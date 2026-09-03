const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCOPES, loadCredentials, pkce, buildAuthUrl, awaitCallback,
} = require('../src/main/google/auth');

test('the requested scopes are read-only for contacts and app-scoped for drive', () => {
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/contacts.readonly'));
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/drive.file'));
  // A write scope here would let a bug corrupt the user's real address book,
  // and full `drive` would let one reach files this app did not create.
  assert.ok(!SCOPES.some((s) => s === 'https://www.googleapis.com/auth/contacts'));
  assert.ok(!SCOPES.some((s) => s === 'https://www.googleapis.com/auth/drive'));
});

test('credentials come from the environment first', () => {
  const creds = loadCredentials({
    env: { GOOGLE_CLIENT_ID: 'id-from-env', GOOGLE_CLIENT_SECRET: 'secret-from-env' },
    configPath: '/nonexistent/google.json',
  });
  assert.deepStrictEqual(creds, { clientId: 'id-from-env', clientSecret: 'secret-from-env' });
});

test('credentials fall back to the config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-creds-'));
  const file = path.join(dir, 'google.json');
  fs.writeFileSync(file, JSON.stringify({ client_id: 'id-from-file', client_secret: 's' }));
  assert.deepStrictEqual(loadCredentials({ env: {}, configPath: file }),
    { clientId: 'id-from-file', clientSecret: 's' });
});

test('the client JSON downloaded from Google Cloud Console works unedited', () => {
  // This is EXACTLY what the console's "Download JSON" button produces for a
  // Desktop app client - everything nested under "installed". Requiring users
  // to hand-flatten the file they just downloaded is a papercut, and the
  // nesting is the shape every single user will actually have.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-creds-'));
  const file = path.join(dir, 'google.json');
  fs.writeFileSync(file, JSON.stringify({
    installed: {
      client_id: 'nested-id.apps.googleusercontent.com',
      project_id: 'konnect-demo',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_secret: 'nested-secret',
      redirect_uris: ['http://localhost'],
    },
  }));
  assert.deepStrictEqual(loadCredentials({ env: {}, configPath: file }),
    { clientId: 'nested-id.apps.googleusercontent.com', clientSecret: 'nested-secret' });
});

test('a web-application client JSON is accepted too', () => {
  // Same download button, different client type: the wrapper key is "web".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-creds-'));
  const file = path.join(dir, 'google.json');
  fs.writeFileSync(file, JSON.stringify({
    web: { client_id: 'web-id', client_secret: 'web-secret' },
  }));
  assert.deepStrictEqual(loadCredentials({ env: {}, configPath: file }),
    { clientId: 'web-id', clientSecret: 'web-secret' });
});

test('a missing client id means unconfigured, not a crash', () => {
  assert.strictEqual(loadCredentials({ env: {}, configPath: '/nonexistent/google.json' }), null);
  // A malformed config file is unconfigured too - it must not throw at startup.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-creds-'));
  const bad = path.join(dir, 'google.json');
  fs.writeFileSync(bad, 'not json at all');
  assert.strictEqual(loadCredentials({ env: {}, configPath: bad }), null);
});

test('the client secret is optional - PKCE is what secures the exchange', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-creds-'));
  const file = path.join(dir, 'google.json');
  fs.writeFileSync(file, JSON.stringify({ client_id: 'id-only' }));
  assert.deepStrictEqual(loadCredentials({ env: {}, configPath: file }),
    { clientId: 'id-only', clientSecret: null });
});

test('the pkce challenge is the base64url sha256 of the verifier', () => {
  const { verifier, challenge } = pkce();
  // RFC 7636: 43-128 characters from the unreserved set.
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(challenge, expected);
  // base64url, unpadded - a '+', '/' or '=' here is rejected by Google.
  assert.doesNotMatch(challenge, /[+/=]/);
});

test('two pkce calls do not repeat a verifier', () => {
  assert.notStrictEqual(pkce().verifier, pkce().verifier);
});

test('the auth url carries every parameter Google requires', () => {
  const url = new URL(buildAuthUrl({
    clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', state: 'st8', challenge: 'ch',
  }));
  assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = url.searchParams;
  assert.strictEqual(q.get('client_id'), 'cid');
  assert.strictEqual(q.get('redirect_uri'), 'http://127.0.0.1:5555');
  assert.strictEqual(q.get('response_type'), 'code');
  assert.strictEqual(q.get('state'), 'st8');
  assert.strictEqual(q.get('code_challenge'), 'ch');
  assert.strictEqual(q.get('code_challenge_method'), 'S256');
  // Without access_type=offline Google returns no refresh token and the user
  // is signed out again an hour later.
  assert.strictEqual(q.get('access_type'), 'offline');
  // Without prompt=consent a re-authorising user gets no NEW refresh token,
  // so a user who signed out and back in would have nothing to persist.
  assert.strictEqual(q.get('prompt'), 'consent');
  assert.strictEqual(q.get('scope'), SCOPES.join(' '));
});

// The browser Google would open. Returns the response status so the test can
// assert what a human would actually see in their browser tab.
async function hitCallback(redirectUri, query) {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams(query).toString();
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

test('a matching state resolves with the authorization code', async () => {
  let resolveSeen;
  const seenPromise = new Promise((resolve) => { resolveSeen = resolve; });
  const pending = awaitCallback({ state: 'st8', timeoutMs: 5000, onReady: (uri) => { resolveSeen(uri); } });
  // Wait on a promise resolved FROM INSIDE onReady rather than a fixed number
  // of event-loop ticks: server.listen() emits 'listening' asynchronously,
  // and a single setImmediate tick is not guaranteed to be enough for onReady
  // to have run yet. This proceeds exactly when the port is known, so the
  // redirect_uri we put in the auth URL always matches the port we are
  // actually listening on.
  const seen = await seenPromise;
  assert.match(seen, /^http:\/\/127\.0\.0\.1:\d+$/);
  const browser = await hitCallback(seen, { code: 'the-code', state: 'st8' });
  assert.strictEqual((await pending).code, 'the-code');
  assert.strictEqual(browser.status, 200);
});

test('a mismatched state is rejected and the server still closes', async () => {
  let resolveSeen;
  const seenPromise = new Promise((resolve) => { resolveSeen = resolve; });
  const pending = awaitCallback({ state: 'expected', timeoutMs: 5000, onReady: (uri) => { resolveSeen(uri); } });
  const seen = await seenPromise;
  // Attach the rejection expectation before awaiting the browser round trip:
  // the server rejects `pending` synchronously inside the request handler, so
  // waiting for hitCallback's response body first leaves `pending` briefly
  // unhandled and node:test fails the test for that, independent of whether
  // the rejection is later caught.
  const rejection = assert.rejects(pending, /state/i);
  const browser = await hitCallback(seen, { code: 'c', state: 'attacker' });
  await rejection;
  assert.strictEqual(browser.status, 400);
  // The port must be free again: a leaked server would hold it for the life of
  // the app and every later sign-in would pick a different one.
  await assert.rejects(fetch(seen), /fetch failed|ECONNREFUSED/i);
});

test('a denied consent screen rejects with the reason Google gave', async () => {
  let resolveSeen;
  const seenPromise = new Promise((resolve) => { resolveSeen = resolve; });
  const pending = awaitCallback({ state: 'st8', timeoutMs: 5000, onReady: (uri) => { resolveSeen(uri); } });
  const seen = await seenPromise;
  // Same reason as the mismatched-state test above: attach the rejection
  // expectation before the browser round trip, not after.
  const rejection = assert.rejects(pending, /access_denied/);
  await hitCallback(seen, { error: 'access_denied', state: 'st8' });
  await rejection;
});

test('an abandoned sign-in times out and frees the port', async () => {
  let resolveSeen;
  const seenPromise = new Promise((resolve) => { resolveSeen = resolve; });
  const pending = awaitCallback({ state: 'st8', timeoutMs: 50, onReady: (uri) => { resolveSeen(uri); } });
  const seen = await seenPromise;
  await assert.rejects(pending, /timed out/i);
  await assert.rejects(fetch(seen), /fetch failed|ECONNREFUSED/i);
});

const { createAuth } = require('../src/main/google/auth');
const { openStore } = require('../src/main/store');

// safeStorage stand-in. `backend` mirrors Electron's getSelectedStorageBackend()
// so the weak-encryption path can be exercised without a real keyring.
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from('enc:' + s),
    decryptString: (b) => {
      const s = Buffer.from(b).toString();
      if (!s.startsWith('enc:')) throw new Error('cannot decrypt');
      return s.slice(4);
    },
  };
}

// Returns responses from a queue and records every request for assertions.
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

function authFixture({ responses = [], safeStorage = fakeSafeStorage(), token = null,
  credentials = { clientId: 'cid', clientSecret: 'sec' }, nowMs = 1_000_000 } = {}) {
  const store = openStore(':memory:');
  const fetchImpl = fakeFetch(responses);
  const auth = createAuth({
    store, safeStorage, fetchImpl, openExternal: () => {},
    credentials, now: () => nowMs,
  });
  if (token) auth._saveTokenForTest(token);
  return { auth, store, fetchImpl };
}

test('an unconfigured install reports so and never reaches the network', async () => {
  const { auth, fetchImpl } = authFixture({ credentials: null });
  const s = auth.status();
  assert.strictEqual(s.configured, false);
  assert.strictEqual(s.signedIn, false);
  await assert.rejects(auth.authedFetch('https://example.test/x'), /not configured/i);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test('a stored token round-trips through safeStorage', () => {
  const { auth, store } = authFixture({
    token: { refresh_token: 'r', access_token: 'a', expires_at: 2_000_000 },
  });
  // The persisted value is the ENCRYPTED blob, never the bare token.
  const persisted = store.getSetting('google_token');
  assert.ok(!persisted.includes('refresh_token'), 'the raw token must not be readable');
  assert.strictEqual(auth.isSignedIn(), true);
});

test('an undecryptable blob is treated as signed out, not a crash', () => {
  const { auth, store } = authFixture();
  // What a keyring change or a copied profile directory leaves behind.
  store.setSetting('google_token', Buffer.from('garbage').toString('base64'));
  assert.strictEqual(auth.isSignedIn(), false);
});

test('a live access token is reused without a refresh call', async () => {
  const { auth, fetchImpl } = authFixture({
    nowMs: 1_000_000,
    token: { refresh_token: 'r', access_token: 'still-good', expires_at: 1_600_000 },
    responses: [{ status: 200, body: { ok: true } }],
  });
  await auth.authedFetch('https://example.test/x');
  assert.strictEqual(fetchImpl.calls.length, 1, 'no refresh should have happened');
  assert.strictEqual(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer still-good');
});

test('an expired access token is refreshed before the request', async () => {
  const { auth, fetchImpl, store } = authFixture({
    nowMs: 2_000_000,
    token: { refresh_token: 'r', access_token: 'stale', expires_at: 1_000_000 },
    responses: [
      { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
      { status: 200, body: { ok: true } },
    ],
  });
  await auth.authedFetch('https://example.test/x');
  assert.match(fetchImpl.calls[0].url, /oauth2\.googleapis\.com\/token/);
  assert.strictEqual(fetchImpl.calls[1].opts.headers.Authorization, 'Bearer fresh');
  // The refreshed token is persisted, so a restart does not refresh again.
  assert.ok(store.getSetting('google_token'));
});

test('a 401 refreshes and retries the request exactly once', async () => {
  const { auth, fetchImpl } = authFixture({
    nowMs: 1_000_000,
    token: { refresh_token: 'r', access_token: 'a', expires_at: 1_600_000 },
    responses: [
      { status: 401, body: {} },
      { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
      { status: 200, body: { ok: true } },
    ],
  });
  const res = await auth.authedFetch('https://example.test/x');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fetchImpl.calls.length, 3);
});

test('a second 401 after refreshing does not loop', async () => {
  const { auth, fetchImpl } = authFixture({
    nowMs: 1_000_000,
    token: { refresh_token: 'r', access_token: 'a', expires_at: 1_600_000 },
    responses: [
      { status: 401, body: {} },
      { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
      { status: 401, body: {} },
    ],
  });
  const res = await auth.authedFetch('https://example.test/x');
  // Returned, not retried again: an unbounded retry against a 401 would hammer
  // Google and never recover.
  assert.strictEqual(res.status, 401);
  assert.strictEqual(fetchImpl.calls.length, 3);
});

test('invalid_grant signs the user out instead of retrying forever', async () => {
  const { auth } = authFixture({
    nowMs: 2_000_000,
    token: { refresh_token: 'revoked', access_token: 'stale', expires_at: 1_000_000 },
    responses: [{ status: 400, body: { error: 'invalid_grant' } }],
  });
  await assert.rejects(auth.authedFetch('https://example.test/x'), /revoked|sign in again/i);
  // The token is gone: retrying one that can never work again would leave a
  // permanent error banner with no action the user can take.
  assert.strictEqual(auth.isSignedIn(), false);
});

test('a transient refresh failure keeps the token for the next attempt', async () => {
  const { auth } = authFixture({
    nowMs: 2_000_000,
    token: { refresh_token: 'r', access_token: 'stale', expires_at: 1_000_000 },
    responses: [{ status: 503, body: { error: 'backendError' } }],
  });
  await assert.rejects(auth.authedFetch('https://example.test/x'));
  assert.strictEqual(auth.isSignedIn(), true, 'a 503 is not a revocation');
});

test('a basic_text keyring is reported as weak rather than trusted silently', () => {
  const { auth } = authFixture({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }) });
  assert.strictEqual(auth.status().weakEncryption, true);
});

test('with no encryption available the token is session-only, never written', () => {
  const { auth, store } = authFixture({
    safeStorage: fakeSafeStorage({ available: false }),
  });
  auth._saveTokenForTest({ refresh_token: 'r', access_token: 'a', expires_at: 9e15 });
  assert.strictEqual(auth.isSignedIn(), true, 'usable for this session');
  assert.strictEqual(store.getSetting('google_token'), null, 'never persisted in the clear');
  assert.strictEqual(auth.status().sessionOnly, true);
});

test('status surfaces the last error and clears it on success', () => {
  const { auth } = authFixture();
  auth.setError('Drive is unreachable');
  assert.strictEqual(auth.status().lastError, 'Drive is unreachable');
  auth.clearError();
  assert.strictEqual(auth.status().lastError, null);
});

// A sign-in that never touches a browser or a network: awaitCallbackImpl is
// injected, so onReady fires synchronously with a fixed redirect URI.
function signInFixture({ responses, callbackResult = { code: 'the-code' }, safeStorage = fakeSafeStorage() }) {
  const store = openStore(':memory:');
  const opened = [];
  const fetchImpl = fakeFetch(responses);
  const auth = createAuth({
    store, safeStorage, fetchImpl,
    openExternal: (url) => opened.push(url),
    credentials: { clientId: 'cid', clientSecret: 'sec' },
    now: () => 1_000_000,
    awaitCallbackImpl: async ({ onReady }) => {
      onReady('http://127.0.0.1:41234');
      if (callbackResult instanceof Error) throw callbackResult;
      return callbackResult;
    },
  });
  return { auth, store, fetchImpl, opened };
}

test('signIn opens the system browser and stores the token and email', async () => {
  const { auth, store, fetchImpl, opened } = signInFixture({
    responses: [
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      { status: 200, body: { email: 'user@example.com' } },
    ],
  });
  const s = await auth.signIn();
  assert.strictEqual(s.signedIn, true);
  assert.strictEqual(s.email, 'user@example.com');
  assert.strictEqual(store.getSetting('google_account'), 'user@example.com');

  // The browser is the SYSTEM browser, via one openExternal call.
  assert.strictEqual(opened.length, 1);
  const authUrl = new URL(opened[0]);
  assert.strictEqual(authUrl.origin + authUrl.pathname,
    'https://accounts.google.com/o/oauth2/v2/auth');
  // The redirect_uri must be the port the callback server actually bound.
  assert.strictEqual(authUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:41234');

  // The exchange sends the verifier matching the challenge in the auth URL.
  const exchange = new URLSearchParams(fetchImpl.calls[0].opts.body);
  assert.strictEqual(exchange.get('grant_type'), 'authorization_code');
  assert.strictEqual(exchange.get('code'), 'the-code');
  assert.strictEqual(exchange.get('redirect_uri'), 'http://127.0.0.1:41234');
  const expectedChallenge = crypto.createHash('sha256')
    .update(exchange.get('code_verifier')).digest('base64url');
  assert.strictEqual(authUrl.searchParams.get('code_challenge'), expectedChallenge);
});

test('signIn on an unconfigured install refuses without opening a browser', async () => {
  const store = openStore(':memory:');
  const opened = [];
  const auth = createAuth({
    store, safeStorage: fakeSafeStorage(), fetchImpl: fakeFetch([]),
    openExternal: (u) => opened.push(u), credentials: null,
  });
  await assert.rejects(auth.signIn(), /not configured/i);
  assert.strictEqual(opened.length, 0);
});

test('a cancelled consent screen leaves the app signed out and says why', async () => {
  const { auth } = signInFixture({
    responses: [], callbackResult: new Error('Google returned access_denied'),
  });
  await assert.rejects(auth.signIn(), /access_denied/);
  assert.strictEqual(auth.isSignedIn(), false);
});

test('signOut clears the token and removes only google contacts', async () => {
  const { auth, store } = signInFixture({
    responses: [
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      { status: 200, body: { email: 'user@example.com' } },
    ],
  });
  await auth.signIn();
  store.upsertContacts([{ uid: 'h1', name: 'Mom', numbers: ['+919876543210'] }]);
  store.upsertContacts([{ uid: 'google:people/c1', name: 'Amma', numbers: ['+919876543210'] }], 'google');
  store.setSetting('google_backup_recordings', 'true');
  store.setSetting('google_folder_id', 'folder-1');

  const s = await auth.signOut();
  assert.strictEqual(s.signedIn, false);
  assert.strictEqual(s.email, null);
  assert.strictEqual(s.removedContacts, 1);
  // The handset contact survives - it is the user's data, not Google's.
  assert.strictEqual(store.findContactByNumber('+919876543210').name, 'Mom');
  // Drive ids are reset so a different account cannot inherit them.
  assert.ok(!store.getSetting('google_folder_id'));
  // The recordings preference is the user's choice and survives a re-sign-in.
  assert.strictEqual(s.backupRecordings, true);
});
