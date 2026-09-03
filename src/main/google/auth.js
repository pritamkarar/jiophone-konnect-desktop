'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// contacts.readonly, not contacts: Konnect never writes to the user's address
// book, so no bug here can corrupt it. drive.file, not drive: the app can only
// touch files it created itself.
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

const DEFAULT_CONFIG_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'konnect', 'google.json');

// Absent or malformed credentials mean the feature is UNCONFIGURED, never a
// startup crash: a user who has not set this up must still get a working phone.
function loadCredentials({ env = process.env, configPath = DEFAULT_CONFIG_PATH } = {}) {
  if (env.GOOGLE_CLIENT_ID) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET || null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Google Cloud Console's "Download JSON" nests everything under
    // "installed" (Desktop app client) or "web". That is the file every user
    // actually has, so accept it unedited rather than making them flatten by
    // hand - a step nothing in the UI could tell them they had missed, since
    // an unparsed file and an absent one both read as "not configured".
    const raw = parsed.installed || parsed.web || parsed;
    if (!raw.client_id) return null;
    return { clientId: raw.client_id, clientSecret: raw.client_secret || null };
  } catch {
    return null;
  }
}

// RFC 7636 S256. 32 random bytes base64url-encoded is 43 chars, the minimum
// legal verifier length, and uses only unreserved characters.
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Offline access is what yields a refresh token; prompt=consent forces a
    // NEW one even for a user who has authorised before, so signing out and
    // back in leaves us with something to persist.
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

const CALLBACK_TIMEOUT_MS = 120000;

// Bound to 127.0.0.1 explicitly, NOT 0.0.0.0: the authorization code must not
// be receivable from another machine on the network. Port 0 asks the OS for a
// free port, which is why onReady exists - the redirect_uri cannot be built
// until we know which port we got.
//
// The server is closed on EVERY exit path (success, state mismatch, error,
// timeout). A leaked server holds its port for the life of the process.
function awaitCallback({ state, timeoutMs = CALLBACK_TIMEOUT_MS, onReady }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const server = http.createServer();

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err); else resolve(value);
    };

    const reply = (res, status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      // The user is looking at this in their browser, so it has to read as a
      // sentence, not a status code.
      res.end(`<!doctype html><meta charset="utf-8">
<title>JioPhone Konnect</title>
<body style="font:16px system-ui;padding:3rem;text-align:center">
<p>${message}</p><p>You can close this tab and return to Konnect.</p>`);
    };

    server.on('request', (req, res) => {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      if (q.get('state') !== state) {
        // Someone else's redirect, or a forged one. Never exchange this code.
        reply(res, 400, 'Sign-in could not be verified. Please try again from Konnect.');
        finish(new Error('sign-in state did not match; the response was ignored'));
        return;
      }
      const error = q.get('error');
      if (error) {
        reply(res, 200, 'Sign-in was cancelled.');
        finish(new Error(`Google returned ${error}`));
        return;
      }
      const code = q.get('code');
      if (!code) {
        reply(res, 400, 'Sign-in did not return an authorization code.');
        finish(new Error('no authorization code in the callback'));
        return;
      }
      reply(res, 200, 'Signed in. Konnect is finishing up…');
      finish(null, { code });
    });

    server.on('error', (err) => finish(err));

    server.listen(0, '127.0.0.1', () => {
      timer = setTimeout(
        () => finish(new Error('sign-in timed out')), timeoutMs);
      // Do not hold the event loop open waiting for a browser that may never
      // come back - Electron should still be able to quit mid-sign-in.
      timer.unref?.();
      try {
        onReady(`http://127.0.0.1:${server.address().port}`);
      } catch (err) {
        finish(err);
      }
    });
  });
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Refresh a minute early. A token that expires mid-flight costs a 401 and a
// retry; a minute of slack costs nothing.
const EXPIRY_SKEW_MS = 60000;

const SETTING_KEYS = {
  token: 'google_token',
  account: 'google_account',
  folder: 'google_folder_id',
  logFile: 'google_log_file_id',
  recordings: 'google_backup_recordings',
  contactsAt: 'google_contacts_synced_at',
  backupAt: 'google_backup_at',
  error: 'google_last_error',
};

function createAuth({
  store, safeStorage, fetchImpl = fetch, openExternal,
  credentials = loadCredentials(), now = () => Date.now(),
  awaitCallbackImpl = awaitCallback,
}) {
  // When the platform has no usable keyring, encryptString would either throw
  // or write something only obfuscated. Holding the token in memory for the
  // session is honest: the user stays signed in until they quit, and nothing
  // readable is left on disk. Persisting it in the clear would be worse.
  const canPersist = () => Boolean(safeStorage?.isEncryptionAvailable?.());
  let memoryToken = null;

  function saveToken(token) {
    if (!canPersist()) { memoryToken = token; return; }
    store.setSetting(SETTING_KEYS.token,
      Buffer.from(safeStorage.encryptString(JSON.stringify(token))).toString('base64'));
  }

  function loadToken() {
    if (!canPersist()) return memoryToken;
    const blob = store.getSetting(SETTING_KEYS.token);
    if (!blob) return null;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64')));
    } catch {
      // A keyring change or a copied profile leaves an undecryptable blob.
      // Signed out is the correct reading; crashing at startup is not.
      return null;
    }
  }

  function clearToken() {
    memoryToken = null;
    // The settings table is NOT NULL, and there is no delete helper; an empty
    // string is falsy everywhere it is read.
    store.setSetting(SETTING_KEYS.token, '');
  }

  const requireCredentials = () => {
    if (!credentials) throw new Error('Google integration is not configured');
    return credentials;
  };

  async function postForm(body) {
    const res = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(payload.error_description || payload.error || `token endpoint ${res.status}`);
      err.oauthError = payload.error;
      throw err;
    }
    return payload;
  }

  async function refresh(token) {
    const { clientId, clientSecret } = requireCredentials();
    let payload;
    try {
      payload = await postForm({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
    } catch (err) {
      // invalid_grant means the refresh token is dead for good - the user
      // revoked access, or it expired. Anything else may work next time.
      if (err.oauthError === 'invalid_grant') {
        clearToken();
        throw new Error('Google access was revoked - please sign in again');
      }
      throw err;
    }
    const next = {
      // A refresh response usually omits refresh_token; keep the one we have.
      refresh_token: payload.refresh_token || token.refresh_token,
      access_token: payload.access_token,
      expires_at: now() + (payload.expires_in ?? 3600) * 1000,
    };
    saveToken(next);
    return next;
  }

  async function accessToken({ force = false } = {}) {
    const token = loadToken();
    if (!token) throw new Error('not signed in to Google');
    if (!force && token.expires_at - EXPIRY_SKEW_MS > now()) return token.access_token;
    return (await refresh(token)).access_token;
  }

  async function authedFetch(url, opts = {}) {
    requireCredentials();
    const send = async (bearer) => fetchImpl(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${bearer}` },
    });
    let res = await send(await accessToken());
    // One retry, never a loop: a persistent 401 is returned to the caller.
    if (res.status === 401) res = await send(await accessToken({ force: true }));
    return res;
  }

  function status() {
    return {
      configured: Boolean(credentials),
      signedIn: Boolean(credentials) && Boolean(loadToken()),
      email: store.getSetting(SETTING_KEYS.account) || null,
      contactsSyncedAt: store.getSetting(SETTING_KEYS.contactsAt) || null,
      backupAt: store.getSetting(SETTING_KEYS.backupAt) || null,
      backupRecordings: store.getSetting(SETTING_KEYS.recordings) === 'true',
      lastError: store.getSetting(SETTING_KEYS.error) || null,
      // basic_text is Electron's no-keyring fallback: a hardcoded key, so the
      // token is obfuscated rather than protected. Saying so is the point.
      weakEncryption: canPersist() && safeStorage.getSelectedStorageBackend?.() === 'basic_text',
      sessionOnly: !canPersist(),
    };
  }

  async function signIn() {
    const { clientId, clientSecret } = requireCredentials();
    const { verifier, challenge } = pkce();
    const state = crypto.randomBytes(16).toString('base64url');
    let redirectUri = null;

    // onReady runs once the loopback port is known. The redirect_uri in the
    // auth URL and the one in the token exchange must both be that exact
    // port, or Google rejects the exchange.
    const { code } = await awaitCallbackImpl({
      state,
      onReady: (uri) => {
        redirectUri = uri;
        openExternal(buildAuthUrl({ clientId, redirectUri: uri, state, challenge }));
      },
    });

    const payload = await postForm({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    saveToken({
      refresh_token: payload.refresh_token,
      access_token: payload.access_token,
      expires_at: now() + (payload.expires_in ?? 3600) * 1000,
    });

    // Label the account in Settings. A failure here must not undo a sign-in
    // that otherwise worked - the email is a nicety, the token is the point.
    try {
      const res = await authedFetch(USERINFO_ENDPOINT);
      const info = await res.json();
      if (info.email) store.setSetting(SETTING_KEYS.account, info.email);
    } catch { /* the account label stays empty */ }

    store.setSetting(SETTING_KEYS.error, '');
    return status();
  }

  async function signOut() {
    clearToken();
    const removedContacts = store.deleteContactsBySource('google');
    // Everything except the recordings preference, which is the user's own
    // choice and should survive signing back in.
    for (const key of [SETTING_KEYS.account, SETTING_KEYS.folder, SETTING_KEYS.logFile,
      SETTING_KEYS.contactsAt, SETTING_KEYS.backupAt, SETTING_KEYS.error]) {
      store.setSetting(key, '');
    }
    return { ...status(), removedContacts };
  }

  return {
    status,
    isSignedIn: () => Boolean(loadToken()),
    authedFetch,
    signIn,
    signOut,
    setError: (message) => store.setSetting(SETTING_KEYS.error, String(message || '')),
    clearError: () => store.setSetting(SETTING_KEYS.error, ''),
    // Test seam only: sign-in (Task 5) is the production path to a token.
    _saveTokenForTest: saveToken,
    _clearToken: clearToken,
    _accessToken: accessToken,
    _credentials: () => credentials,
    _keys: SETTING_KEYS,
  };
}

module.exports = {
  SCOPES, AUTH_ENDPOINT, DEFAULT_CONFIG_PATH, loadCredentials, pkce, buildAuthUrl, awaitCallback,
  createAuth, SETTING_KEYS, TOKEN_ENDPOINT, USERINFO_ENDPOINT,
};
