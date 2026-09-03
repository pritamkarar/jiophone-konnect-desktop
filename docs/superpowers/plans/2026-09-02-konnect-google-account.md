# Konnect Google Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Google account to Konnect that pulls Google Contacts read-only, backs the call log up to Drive automatically, and backs call recordings up only when explicitly opted in.

**Architecture:** Three new main-process modules under `src/main/google/` — `auth.js` (PKCE + loopback sign-in, token lifecycle, authed fetch), `contacts.js` (People API pull mapped onto the existing `store.upsertContacts()`), `backup.js` (Drive folder, whole-file call-log upload, per-file recording upload). Every module takes its dependencies by parameter so all tests run with fake `fetch`, fake `safeStorage` and no network. The existing `onPersisted` call-end hook is the single backup trigger; no scheduler exists anywhere in the design.

**Tech Stack:** Electron 44.1.0 / Node 24.19.0, global `fetch`, `node:sqlite`, `node:http` (loopback only), `node:crypto` (PKCE), Electron `safeStorage` and `shell.openExternal`. Tests: `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-02-konnect-google-account-design.md`

## Global Constraints

- **No new npm dependency.** Electron 44.1.0 ships Node 24.19.0 with global `fetch`. `googleapis` is forbidden. (spec §1.1.2)
- **Read-only contacts.** Never request a Google Contacts write scope; never issue a write to the People API. (spec §1.1.1)
- **Credentials never in the repo.** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from the environment, else `~/.config/konnect/google.json`. Absent → feature disabled, no network call. (spec §4.1)
- **Google is best-effort; telephony is not.** No Google operation may be awaited by, throw into, or delay the call path. (spec §1.1.4, §8)
- **Recordings default OFF.** `google_backup_recordings` defaults to `'false'`. (spec §7.2)
- **No timers, no scheduler, no queue table.** Triggers are app start, sign-in, `onPersisted`, and manual buttons only. (spec §3, §7.4)
- **Scopes, exactly:** `openid email https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/drive.file` (spec §5.2)
- **System browser only.** Sign-in goes through `shell.openExternal`. An embedded `BrowserWindow` login is forbidden. (spec §5.1)
- **Tests never touch the network.** Inject `fetch`. Loopback HTTP against `127.0.0.1` is allowed and expected in Task 3.
- **Baseline:** 284 tests pass on `main` at `dc872fd`. Every task must leave the whole suite green, not just its own file.
- **Verify before claiming.** Run `npm test` and read the output before saying a task is done.

### External precondition (spec §5.5)

`contacts.readonly` is a **sensitive** scope. An unverified OAuth client is capped at
100 test users and shows an "unverified app" interstitial at sign-in. This blocks
distribution, not development — every task below is completable against your own Google
account added as a test user. Do not treat the warning screen during Task 10's manual
verification as a bug.

---

## File Structure

**Create**

| File | Responsibility |
| --- | --- |
| `src/main/google/auth.js` | Credential loading, PKCE, loopback callback, token persistence/refresh, `authedFetch`, sign-in/out/status |
| `src/main/google/contacts.js` | People API pull, person→store-row mapping |
| `src/main/google/backup.js` | Drive folder resolution, call-log upload, recording upload, debounced runner |
| `test/google-auth.test.js` | Tasks 2–5 |
| `test/google-contacts.test.js` | Task 6 |
| `test/google-backup.test.js` | Tasks 7–8 |

**Modify**

| File | Change | Task |
| --- | --- | --- |
| `src/main/store.js` | Two guarded migrations, `source` on upsert, Google-first ordering, backup queries | 1 |
| `test/store.test.js` | Migration and ordering tests | 1 |
| `src/main/ipc.js` | Six handlers | 9 |
| `src/main/preload.js` | Six mirrored bindings | 9 |
| `src/main/index.js` | Construct modules, wire `onPersisted` and startup | 9 |
| `src/renderer/index.html` | `#set-google` fieldset | 10 |
| `src/renderer/settings.js` | `renderGoogle()` and its wiring | 10 |
| `.gitignore` | `google.json` | 2 |

---

### Task 1: Store migrations and source-aware queries

Everything Google writes lands in the existing tables. This task makes the schema ready and the read paths source-aware, with no Google code anywhere yet — it is fully testable on its own.

**Files:**
- Modify: `src/main/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `upsertContacts(contacts, source = 'handset') => { added, updated }`
  - `listContacts() => rows` — one row per `number_e164`, Google row preferred; rows now carry `source`
  - `findContactByNumber(e164) => { id, name } | null` — Google row preferred
  - `deleteContactsBySource(source) => number` (rows deleted)
  - `listAllCalls() => rows` — every call, no limit, with resolved `name`
  - `pendingRecordingBackups() => [{ id, recording_path }]`
  - `markRecordingBackedUp(id, fileId) => void`

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.js`:

```js
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A database created before this feature existed: the old schema, with no
// `source` column and no `recording_backup_id`. openStore() must migrate it in
// place rather than throwing or silently reading a column that isn't there.
function legacyDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-mig-')), 'k.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL,
      number_e164 TEXT NOT NULL, number_raw TEXT, type TEXT,
      synced_at TEXT NOT NULL, UNIQUE (uid, number_e164));
    CREATE TABLE calls (
      id INTEGER PRIMARY KEY, direction TEXT NOT NULL, number_e164 TEXT NOT NULL,
      contact_id INTEGER, started_at TEXT, ended_at TEXT NOT NULL,
      duration_s INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'live',
      recording_path TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare(`INSERT INTO contacts (uid,name,number_e164,synced_at)
              VALUES ('old','Legacy','+919000000001','2026-01-01T00:00:00Z')`).run();
  db.close();
  return file;
}

test('an old database without source/recording_backup_id migrates in place', () => {
  const file = legacyDb();
  const s = openStore(file);
  const all = s.listContacts();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].name, 'Legacy');
  // The pre-existing row is backfilled as a handset contact, not left NULL.
  assert.strictEqual(all[0].source, 'handset');
  assert.deepStrictEqual(s.pendingRecordingBackups(), []);
  s.close();
  // Re-opening runs the migration a second time; the guard must make it a no-op
  // rather than throwing "duplicate column name".
  const again = openStore(file);
  assert.strictEqual(again.listContacts().length, 1);
  again.close();
});

test('a google contact outranks a handset contact on the same number', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'h1', name: 'Mom', numbers: ['+919876543210'] }]);
  s.upsertContacts([{ uid: 'google:people/c1', name: 'Amma', numbers: ['+919876543210'] }], 'google');
  // Caller ID picks the Google name even though the handset row was inserted first.
  assert.strictEqual(s.findContactByNumber('+919876543210').name, 'Amma');
  // The list shows ONE row for the number, not a visible duplicate.
  const all = s.listContacts();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].name, 'Amma');
  assert.strictEqual(all[0].source, 'google');
  s.close();
});

test('removing google contacts restores the handset name', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'h1', name: 'Mom', numbers: ['+919876543210'] }]);
  s.upsertContacts([{ uid: 'google:people/c1', name: 'Amma', numbers: ['+919876543210'] }], 'google');
  assert.strictEqual(s.deleteContactsBySource('google'), 1);
  // Nothing was destroyed: the handset row was only ever outranked.
  assert.strictEqual(s.findContactByNumber('+919876543210').name, 'Mom');
  assert.strictEqual(s.listContacts().length, 1);
  s.close();
});

test('listAllCalls returns every call, past the 200-row default of listCalls', () => {
  const s = fresh();
  for (let i = 0; i < 250; i += 1) {
    s.insertCall({ direction: 'in', number_e164: '+91900000000' + (i % 10),
      ended_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), duration_s: 1 });
  }
  assert.strictEqual(s.listCalls().length, 200);
  assert.strictEqual(s.listAllCalls().length, 250);
  s.close();
});

test('pendingRecordingBackups lists only un-uploaded recordings', () => {
  const s = fresh();
  const withRec = s.insertCall({ direction: 'in', number_e164: '+919000000001',
    ended_at: '2026-01-01T00:00:00Z', recording_path: 'a.opus' });
  s.insertCall({ direction: 'in', number_e164: '+919000000002', ended_at: '2026-01-01T00:01:00Z' });
  // node:sqlite returns NULL-PROTOTYPE rows, so deepStrictEqual against an
  // object literal fails on the prototype alone. Spread them first.
  assert.deepStrictEqual(s.pendingRecordingBackups().map((r) => ({ ...r })),
    [{ id: withRec, recording_path: 'a.opus' }]);
  s.markRecordingBackedUp(withRec, 'drive-file-1');
  // Marked rows drop out of the queue - this NULL check IS the retry queue.
  assert.deepStrictEqual(s.pendingRecordingBackups(), []);
  s.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `s.pendingRecordingBackups is not a function`, and the migration test throws on the legacy database.

- [ ] **Step 3: Implement the migrations and queries**

In `src/main/store.js`, add above `openStore`:

```js
// ALTER TABLE ... ADD COLUMN throws "duplicate column name" on a second run, and
// databases already exist on developer machines, so every migration is guarded
// by a table_info probe. PRAGMA table_info DOES return rows, so it goes through
// prepare().all() - the "PRAGMAs go through exec()" note above applies only to
// the row-less ones like journal_mode.
function addColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
```

Inside `openStore`, immediately after `db.exec(SCHEMA)`:

```js
  // Existing rows backfill to 'handset': everything stored before Google
  // existed came off the handset over OPP.
  addColumn(db, 'contacts', 'source', `TEXT NOT NULL DEFAULT 'handset'`);
  // NULL means "not yet uploaded". That NULL is the retry queue - see spec 7.2.
  addColumn(db, 'calls', 'recording_backup_id', 'TEXT');
```

Add `source` to the SCHEMA `contacts` table too, so a brand-new database gets the column directly rather than by migration:

```sql
  synced_at    TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'handset',
  UNIQUE (uid, number_e164)
```

and to `calls`:

```sql
  recording_path TEXT,
  recording_backup_id TEXT
```

Replace the `insertContact`, `listContacts` and `findByNumber` prepared statements:

```js
    insertContact: db.prepare(
      `INSERT INTO contacts (uid, name, number_e164, number_raw, type, synced_at, source)
       VALUES (@uid, @name, @number_e164, @number_raw, @type, @synced_at, @source)
       ON CONFLICT (uid, number_e164) DO UPDATE SET
         name = excluded.name, synced_at = excluded.synced_at,
         source = excluded.source`),
    // One row per number. Where a handset row and a Google row share a number,
    // the Google row wins - it is the address book the user actively curates.
    // The handset row is not deleted, only outranked, so signing out restores
    // it (see deleteContactsBySource).
    listContacts: db.prepare(
      `SELECT id, uid, name, number_e164, number_raw, type, source
       FROM contacts c
       WHERE c.id = (SELECT c2.id FROM contacts c2
                     WHERE c2.number_e164 = c.number_e164
                     ORDER BY (c2.source = 'google') DESC, c2.id LIMIT 1)
       ORDER BY name COLLATE NOCASE, number_e164`),
    // Google first, then the original first-synced-wins tie-break within a source.
    findByNumber: db.prepare(
      `SELECT id, name FROM contacts WHERE number_e164 = ?
       ORDER BY (source = 'google') DESC, id LIMIT 1`),
```

Add three more prepared statements next to the others:

```js
    deleteBySource: db.prepare(`DELETE FROM contacts WHERE source = ?`),
    pendingRecordings: db.prepare(
      `SELECT id, recording_path FROM calls
       WHERE recording_path IS NOT NULL AND recording_backup_id IS NULL
       ORDER BY id`),
    markBackedUp: db.prepare(`UPDATE calls SET recording_backup_id = ? WHERE id = ?`),
```

Change the `upsertContacts` signature and the row it binds:

```js
    upsertContacts(contacts, source = 'handset') {
```

and inside the inner loop:

```js
            stmt.insertContact.run({
              uid: c.uid, name: c.name, number_e164: number,
              number_raw: c.raw?.[i] ?? number, type: c.type || null, synced_at,
              source,
            });
```

Add to the returned object:

```js
    deleteContactsBySource(source) {
      return Number(stmt.deleteBySource.run(source).changes);
    },

    // The whole log, for the Drive backup. listCalls() defaults to limit 200;
    // passing that default would upload only the 200 most recent calls and
    // report success. SQLite treats a negative LIMIT as unbounded.
    listAllCalls() { return this.listCalls({ limit: -1 }); },

    pendingRecordingBackups() { return stmt.pendingRecordings.all(); },

    markRecordingBackedUp(id, fileId) { stmt.markBackedUp.run(fileId, id); },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, 289 tests (284 baseline + 5 new), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/main/store.js test/store.test.js
git commit -m "feat(store): source-tagged contacts and recording backup state

Two guarded migrations so existing databases gain contacts.source and
calls.recording_backup_id in place. A Google contact outranks a handset
contact on the same number in both caller-ID lookup and the contact
list, without deleting the handset row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Credentials, PKCE and the authorization URL

Pure functions, no network, no Electron. The foundation Tasks 3–5 build on.

**Files:**
- Create: `src/main/google/auth.js`
- Create: `test/google-auth.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SCOPES` — array of scope strings
  - `loadCredentials({ env, configPath }) => { clientId, clientSecret } | null`
  - `pkce() => { verifier, challenge }`
  - `buildAuthUrl({ clientId, redirectUri, state, challenge }) => string`

- [ ] **Step 1: Write the failing test**

Create `test/google-auth.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCOPES, loadCredentials, pkce, buildAuthUrl,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../src/main/google/auth'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/google/auth.js`:

```js
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
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
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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

module.exports = {
  SCOPES, AUTH_ENDPOINT, DEFAULT_CONFIG_PATH, loadCredentials, pkce, buildAuthUrl,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 8 new tests PASS; full suite 297 pass, 0 fail.

- [ ] **Step 5: Keep credentials out of git, then commit**

Append to `.gitignore`:

```
# Google OAuth client credentials - never committed (spec 4.1)
google.json
```

```bash
git add src/main/google/auth.js test/google-auth.test.js .gitignore
git commit -m "feat(google): credential loading, PKCE and the authorization URL

Credentials from the environment, else a gitignored config file; absent
or malformed means unconfigured rather than a crash. Scopes are pinned
to contacts.readonly and drive.file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The loopback callback server

The half of sign-in that receives Google's redirect. Real HTTP on `127.0.0.1`, which is not network egress and is safe in tests.

**Files:**
- Modify: `src/main/google/auth.js`
- Test: `test/google-auth.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `awaitCallback({ state, timeoutMs, onReady }) => Promise<{ code }>` — binds `127.0.0.1:0`, calls `onReady(redirectUri)` once listening, resolves with the code, and closes the server on **every** exit path.

- [ ] **Step 1: Write the failing test**

Append to `test/google-auth.test.js`:

```js
const { awaitCallback } = require('../src/main/google/auth');

// The browser Google would open. Returns the response status so the test can
// assert what a human would actually see in their browser tab.
async function hitCallback(redirectUri, query) {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams(query).toString();
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

test('a matching state resolves with the authorization code', async () => {
  let seen = null;
  const pending = awaitCallback({ state: 'st8', timeoutMs: 5000, onReady: (uri) => { seen = uri; } });
  // onReady fires only once the port is known, so the redirect_uri we put in
  // the auth URL always matches the port we are actually listening on.
  await new Promise((r) => setImmediate(r));
  assert.match(seen, /^http:\/\/127\.0\.0\.1:\d+$/);
  const browser = await hitCallback(seen, { code: 'the-code', state: 'st8' });
  assert.strictEqual((await pending).code, 'the-code');
  assert.strictEqual(browser.status, 200);
});

test('a mismatched state is rejected and the server still closes', async () => {
  let seen = null;
  const pending = awaitCallback({ state: 'expected', timeoutMs: 5000, onReady: (uri) => { seen = uri; } });
  await new Promise((r) => setImmediate(r));
  const browser = await hitCallback(seen, { code: 'c', state: 'attacker' });
  await assert.rejects(pending, /state/i);
  assert.strictEqual(browser.status, 400);
  // The port must be free again: a leaked server would hold it for the life of
  // the app and every later sign-in would pick a different one.
  await assert.rejects(fetch(seen), /fetch failed|ECONNREFUSED/i);
});

test('a denied consent screen rejects with the reason Google gave', async () => {
  let seen = null;
  const pending = awaitCallback({ state: 'st8', timeoutMs: 5000, onReady: (uri) => { seen = uri; } });
  await new Promise((r) => setImmediate(r));
  await hitCallback(seen, { error: 'access_denied', state: 'st8' });
  await assert.rejects(pending, /access_denied/);
});

test('an abandoned sign-in times out and frees the port', async () => {
  let seen = null;
  const pending = awaitCallback({ state: 'st8', timeoutMs: 50, onReady: (uri) => { seen = uri; } });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(pending, /timed out/i);
  await assert.rejects(fetch(seen), /fetch failed|ECONNREFUSED/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10`
Expected: FAIL — `awaitCallback is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/main/google/auth.js` (and export `awaitCallback`):

```js
const http = require('node:http');

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 4 new tests PASS; full suite 301 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/google/auth.js test/google-auth.test.js
git commit -m "feat(google): loopback callback server for the OAuth redirect

Binds 127.0.0.1 on an ephemeral port, verifies state before accepting a
code, and closes on every exit path including timeout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Token persistence, refresh and `authedFetch`

The token lifecycle, isolated from sign-in so it can be tested with a fake `safeStorage` and a fake `fetch`.

**Files:**
- Modify: `src/main/google/auth.js`
- Test: `test/google-auth.test.js`

**Interfaces:**
- Consumes: `loadCredentials`, `pkce`, `buildAuthUrl`, `awaitCallback` (Tasks 2–3).
- Produces: `createAuth(deps) => auth` where `deps` is
  `{ store, safeStorage, fetchImpl, openExternal, credentials, now, awaitCallbackImpl }` and `auth` exposes
  `isSignedIn() => boolean`, `authedFetch(url, opts) => Promise<Response>`,
  `setError(message) => void`, `clearError() => void`, `status() => object`.
  Sign-in and sign-out arrive in Task 5.
  `status()` returns
  `{ configured, signedIn, email, contactsSyncedAt, backupAt, backupRecordings, lastError, weakEncryption, sessionOnly }`.

- [ ] **Step 1: Write the failing test**

Append to `test/google-auth.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10`
Expected: FAIL — `createAuth is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/main/google/auth.js` (and export `createAuth`):

```js
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

  return {
    status,
    isSignedIn: () => Boolean(loadToken()),
    authedFetch,
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
```

Export `createAuth`, `SETTING_KEYS`, `TOKEN_ENDPOINT` and `USERINFO_ENDPOINT` alongside the existing exports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 12 new tests PASS; full suite 313 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/google/auth.js test/google-auth.test.js
git commit -m "feat(google): token persistence, refresh and authedFetch

Tokens are safeStorage-encrypted into the settings table, or held in
memory for the session where no keyring exists rather than written in
the clear. A 401 refreshes and retries exactly once; invalid_grant
signs out instead of retrying a token that can never work again.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sign-in and sign-out

Ties Tasks 2–4 together into the two operations the UI actually calls.

**Files:**
- Modify: `src/main/google/auth.js`
- Test: `test/google-auth.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces, added to the object `createAuth` returns:
  - `signIn() => Promise<status>` — opens the system browser, exchanges the code, stores the token and the account email
  - `signOut() => Promise<status & { removedContacts: number }>` — clears the token, removes `source='google'` contacts, resets Google settings except the recordings preference

- [ ] **Step 1: Write the failing test**

Append to `test/google-auth.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10`
Expected: FAIL — `auth.signIn is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Inside `createAuth`, before the `return`:

```js
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
```

Add `signIn` and `signOut` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-auth.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 4 new tests PASS; full suite 317 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/google/auth.js test/google-auth.test.js
git commit -m "feat(google): sign-in and sign-out

PKCE authorization-code flow through the system browser. Sign-out clears
the token and removes only source='google' contacts, leaving handset
contacts and the recordings preference intact.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Google Contacts pull

**Files:**
- Create: `src/main/google/contacts.js`
- Create: `test/google-contacts.test.js`

**Interfaces:**
- Consumes: `auth.authedFetch`, `auth.clearError`, `auth.setError` (Task 4); `store.upsertContacts(contacts, 'google')` (Task 1).
- Produces:
  - `mapPerson(person) => { uid, name, numbers, raw, type } | null`
  - `syncContacts({ auth, store, now }) => Promise<{ added, updated, people }>`

- [ ] **Step 1: Write the failing test**

Create `test/google-contacts.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');
const { mapPerson, syncContacts } = require('../src/main/google/contacts');

test('a person with several numbers becomes one row per normalised number', () => {
  const mapped = mapPerson({
    resourceName: 'people/c1',
    names: [{ displayName: 'Amma' }],
    phoneNumbers: [{ value: '098765 43210', type: 'mobile' }, { value: '+912212345678' }],
  });
  assert.strictEqual(mapped.uid, 'google:people/c1');
  assert.strictEqual(mapped.name, 'Amma');
  // The SAME normaliser the handset path uses, or caller-ID silently misses.
  assert.deepStrictEqual(mapped.numbers, ['+919876543210', '+912212345678']);
  // raw is positional: store binds c.raw[i] against numbers[i].
  assert.deepStrictEqual(mapped.raw, ['098765 43210', '+912212345678']);
  assert.strictEqual(mapped.type, 'mobile');
});

test('a person with no usable number is skipped entirely', () => {
  assert.strictEqual(mapPerson({ resourceName: 'people/c2', names: [{ displayName: 'No Phone' }] }), null);
  assert.strictEqual(mapPerson({ resourceName: 'people/c3', phoneNumbers: [{ value: '   ' }] }), null);
});

test('an unnamed person falls back to their number, never an empty name', () => {
  // contacts.name is NOT NULL; an empty string would also render as a blank
  // row in the contact list.
  const mapped = mapPerson({ resourceName: 'people/c4', phoneNumbers: [{ value: '9876543210' }] });
  assert.strictEqual(mapped.name, '9876543210');
});

test('a number repeated within one person is stored once', () => {
  // Google lets the same number sit under two labels (mobile and main).
  // Both normalise identically, and the second would collide on
  // UNIQUE(uid, number_e164) and be miscounted as an update.
  const mapped = mapPerson({
    resourceName: 'people/c5', names: [{ displayName: 'Dup' }],
    phoneNumbers: [{ value: '9876543210' }, { value: '+919876543210' }],
  });
  assert.deepStrictEqual(mapped.numbers, ['+919876543210']);
});

// Serves a paged People API response and records the URLs requested.
function fakeAuth(pages) {
  const urls = [];
  return {
    urls,
    errors: [],
    authedFetch: async (url) => {
      urls.push(String(url));
      const page = pages.shift();
      if (!page) throw new Error(`unexpected request to ${url}`);
      return { ok: true, status: 200, json: async () => page, text: async () => '' };
    },
    setError(m) { this.errors.push(m); },
    clearError() { this.errors.length = 0; },
  };
}

test('syncContacts follows nextPageToken and stops at the last page', async () => {
  const store = openStore(':memory:');
  const auth = fakeAuth([
    { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'A' }],
      phoneNumbers: [{ value: '9000000001' }] }], nextPageToken: 'page2' },
    { connections: [{ resourceName: 'people/c2', names: [{ displayName: 'B' }],
      phoneNumbers: [{ value: '9000000002' }] }] },
  ]);
  const res = await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.deepStrictEqual({ added: res.added, updated: res.updated }, { added: 2, updated: 0 });
  assert.strictEqual(auth.urls.length, 2);
  assert.ok(!auth.urls[0].includes('pageToken'));
  assert.ok(auth.urls[1].includes('pageToken=page2'));
  // Read-only: personFields never asks for anything we are not scoped to read.
  assert.ok(auth.urls[0].includes('personFields=names%2CphoneNumbers'));
  assert.strictEqual(store.listContacts().length, 2);
  store.close();
});

test('synced google contacts are tagged google and outrank handset rows', async () => {
  const store = openStore(':memory:');
  store.upsertContacts([{ uid: 'h1', name: 'Mom', numbers: ['+919876543210'] }]);
  const auth = fakeAuth([{ connections: [{ resourceName: 'people/c1',
    names: [{ displayName: 'Amma' }], phoneNumbers: [{ value: '9876543210' }] }] }]);
  await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.strictEqual(store.findContactByNumber('+919876543210').name, 'Amma');
  assert.strictEqual(store.listContacts().length, 1);
  store.close();
});

test('a successful sync records its timestamp and clears any previous error', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_last_error', 'an old failure');
  const auth = fakeAuth([{ connections: [] }]);
  await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.strictEqual(store.getSetting('google_contacts_synced_at'), '2026-09-02T10:00:00.000Z');
  assert.deepStrictEqual(auth.errors, []);
  store.close();
});

test('a failed page leaves the timestamp untouched so the failure is visible', async () => {
  const store = openStore(':memory:');
  const auth = {
    errors: [],
    authedFetch: async () => ({ ok: false, status: 503, text: async () => 'backend error' }),
    setError(m) { this.errors.push(m); },
    clearError() {},
  };
  await assert.rejects(syncContacts({ auth, store, now: () => new Date() }), /503/);
  assert.strictEqual(store.getSetting('google_contacts_synced_at'), null);
  store.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-contacts.test.js 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../src/main/google/contacts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/google/contacts.js`:

```js
'use strict';
const { normaliseIndian } = require('../../shared/phone');

const PEOPLE_ENDPOINT = 'https://people.googleapis.com/v1/people/me/connections';
// names and phoneNumbers only. Asking for more would be reading data we have
// no use for, from an address book we promised only to read narrowly.
const PERSON_FIELDS = 'names,phoneNumbers';
const PAGE_SIZE = 1000;

// One Google person -> the shape store.upsertContacts() already accepts, or
// null when there is nothing dialable. numbers[i] and raw[i] are positional
// partners: the store binds raw[i] as number_raw for numbers[i].
function mapPerson(person) {
  const numbers = [];
  const raw = [];
  for (const entry of person.phoneNumbers || []) {
    const normalised = normaliseIndian(entry.value);
    if (!normalised) continue;
    // Google allows one number under two labels; both normalise identically
    // and the second would collide on UNIQUE (uid, number_e164).
    if (numbers.includes(normalised)) continue;
    numbers.push(normalised);
    raw.push(entry.value);
  }
  // A contact with no number can never match a call. This is a dialer.
  if (numbers.length === 0) return null;
  return {
    uid: `google:${person.resourceName}`,
    // contacts.name is NOT NULL, and a blank name renders as an empty row.
    name: person.names?.[0]?.displayName?.trim() || raw[0],
    numbers,
    raw,
    type: person.phoneNumbers?.[0]?.type || null,
  };
}

async function syncContacts({ auth, store, now = () => new Date() }) {
  const people = [];
  let pageToken = null;
  do {
    const url = new URL(PEOPLE_ENDPOINT);
    url.search = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const res = await auth.authedFetch(url.toString());
    if (!res.ok) {
      throw new Error(`Google Contacts returned ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    for (const person of page.connections || []) {
      const mapped = mapPerson(person);
      if (mapped) people.push(mapped);
    }
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  // Written only after EVERY page succeeded. A partial pull that recorded a
  // timestamp would look like a healthy sync.
  const { added, updated } = store.upsertContacts(people, 'google');
  store.setSetting('google_contacts_synced_at', now().toISOString());
  auth.clearError?.();
  return { added, updated, people: people.length };
}

module.exports = { PEOPLE_ENDPOINT, PERSON_FIELDS, mapPerson, syncContacts };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-contacts.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 8 new tests PASS; full suite 325 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/google/contacts.js test/google-contacts.test.js
git commit -m "feat(google): read-only Contacts pull

Paged People API pull mapped through the existing Indian E.164
normaliser onto store.upsertContacts(..., 'google'), so Google contacts
match calls exactly the way handset contacts do. Numberless people are
skipped; the synced-at stamp is written only after every page succeeds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Drive folder and call-log upload

**Files:**
- Create: `src/main/google/backup.js`
- Create: `test/google-backup.test.js`

**Interfaces:**
- Consumes: `auth.authedFetch` (Task 4); `store.listAllCalls()` (Task 1).
- Produces:
  - `multipartBody({ metadata, mimeType, data, boundary }) => Buffer`
  - `ensureFolder({ auth, store }) => Promise<string>` (Drive folder id)
  - `uploadLog({ auth, store, now }) => Promise<string>` (Drive file id)

- [ ] **Step 1: Write the failing test**

Create `test/google-backup.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');
const {
  FOLDER_NAME, LOG_FILE_NAME, multipartBody, ensureFolder, uploadLog,
} = require('../src/main/google/backup');

// Matches requests in order and records them. Each rule is
// [predicate, response]; an unmatched request fails the test loudly rather
// than silently returning undefined.
function fakeAuth(rules) {
  const calls = [];
  return {
    calls,
    errors: [],
    isSignedIn: () => true,
    setError(m) { this.errors.push(m); },
    clearError() { this.errors.length = 0; },
    authedFetch: async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', opts });
      const rule = rules.find((r) => r.match(String(url), opts));
      if (!rule) throw new Error(`unexpected ${opts.method || 'GET'} ${url}`);
      if (rule.once) rules.splice(rules.indexOf(rule), 1);
      return {
        ok: rule.status >= 200 && rule.status < 300,
        status: rule.status,
        json: async () => rule.body,
        text: async () => JSON.stringify(rule.body ?? ''),
      };
    },
  };
}

test('the multipart body frames metadata and bytes with the boundary', () => {
  const body = multipartBody({
    metadata: { name: 'x.json', parents: ['f1'] },
    mimeType: 'application/json',
    data: Buffer.from('{"a":1}'),
    boundary: 'BOUND',
  });
  const text = body.toString();
  assert.ok(text.startsWith('--BOUND\r\n'));
  assert.ok(text.includes('Content-Type: application/json; charset=UTF-8\r\n\r\n{"name":"x.json"'));
  assert.ok(text.includes('\r\n--BOUND\r\nContent-Type: application/json\r\n\r\n{"a":1}'));
  assert.ok(text.endsWith('\r\n--BOUND--'));
  // A Buffer, not a string: recordings are binary and a string round-trip
  // would corrupt every non-UTF-8 byte in the Opus stream.
  assert.ok(Buffer.isBuffer(body));
});

test('binary data survives the multipart body byte for byte', () => {
  const data = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0xfe, 0x80]);
  const body = multipartBody({ metadata: { name: 'a.opus' }, mimeType: 'audio/ogg', data, boundary: 'B' });
  const start = body.indexOf(data);
  assert.ok(start > 0, 'the payload must appear verbatim');
  assert.deepStrictEqual(body.subarray(start, start + data.length), data);
});

test('ensureFolder reuses the cached folder id without a round trip', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'cached-folder');
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/cached-folder'), status: 200, body: { id: 'cached-folder', trashed: false } },
  ]);
  assert.strictEqual(await ensureFolder({ auth, store }), 'cached-folder');
  assert.strictEqual(auth.calls.length, 1);
  store.close();
});

test('a folder the user deleted is searched for, then recreated', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'gone');
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/gone'), status: 404, body: {} },
    { match: (u) => u.includes('q=') && u.includes('files?'), status: 200, body: { files: [] } },
    { match: (u, o) => o.method === 'POST' && u.endsWith('/drive/v3/files'), status: 200, body: { id: 'new-folder' } },
  ]);
  assert.strictEqual(await ensureFolder({ auth, store }), 'new-folder');
  // The new id is cached, so the next pass does not search again.
  assert.strictEqual(store.getSetting('google_folder_id'), 'new-folder');
  store.close();
});

test('an existing folder found by search is adopted rather than duplicated', async () => {
  const store = openStore(':memory:');
  const auth = fakeAuth([
    { match: (u) => u.includes('files?'), status: 200, body: { files: [{ id: 'found', name: FOLDER_NAME }] } },
  ]);
  assert.strictEqual(await ensureFolder({ auth, store }), 'found');
  // Signing out clears the cached id; without the search a second sign-in
  // would leave the user with two identically named folders.
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 0);
  store.close();
});

test('the call log uploads every call, past the 200-row default', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  for (let i = 0; i < 250; i += 1) {
    store.insertCall({ direction: 'in', number_e164: '+919000000001',
      ended_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), duration_s: 1 });
  }
  let uploaded = null;
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } },
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'log-1' } },
  ]);
  const realFetch = auth.authedFetch;
  auth.authedFetch = async (url, opts) => {
    if (String(url).includes('uploadType=multipart')) uploaded = Buffer.from(opts.body).toString();
    return realFetch(url, opts);
  };
  const id = await uploadLog({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.strictEqual(id, 'log-1');
  const payload = JSON.parse(uploaded.slice(uploaded.indexOf('{"exportedAt"'), uploaded.lastIndexOf('}') + 1));
  assert.strictEqual(payload.calls.length, 250, 'a truncated log would look like a successful backup');
  assert.strictEqual(payload.exportedAt, '2026-09-02T10:00:00.000Z');
  assert.strictEqual(store.getSetting('google_log_file_id'), 'log-1');
  store.close();
});

test('a second upload updates the same file instead of creating another', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  store.setSetting('google_log_file_id', 'log-1');
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } },
    { match: (u, o) => o.method === 'PATCH' && u.includes('/files/log-1'), status: 200, body: { id: 'log-1' } },
  ]);
  assert.strictEqual(await uploadLog({ auth, store, now: () => new Date() }), 'log-1');
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 0);
  store.close();
});

test('a log file the user deleted is recreated on the next pass', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  store.setSetting('google_log_file_id', 'deleted-log');
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } },
    { match: (u, o) => o.method === 'PATCH', status: 404, body: {} },
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'log-2' } },
  ]);
  assert.strictEqual(await uploadLog({ auth, store, now: () => new Date() }), 'log-2');
  assert.strictEqual(store.getSetting('google_log_file_id'), 'log-2');
  store.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-backup.test.js 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../src/main/google/backup'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/google/backup.js`:

```js
'use strict';
const crypto = require('node:crypto');

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'JioPhone Konnect';
const LOG_FILE_NAME = 'call-log.json';

// A Buffer, not a template string: recording payloads are binary Opus and a
// string round-trip would mangle every byte outside UTF-8.
function multipartBody({ metadata, mimeType, data, boundary }) {
  const head = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return Buffer.concat([head, Buffer.from(data), tail]);
}

async function createFile({ auth, metadata, mimeType, data }) {
  const boundary = `konnect-${crypto.randomBytes(12).toString('hex')}`;
  const res = await auth.authedFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody({ metadata, mimeType, data, boundary }),
  });
  if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
  return (await res.json()).id;
}

// Cached id first, then a search, then create. The search matters: signing out
// clears the cached id, so without it a second sign-in leaves the user with two
// identically named folders.
async function ensureFolder({ auth, store }) {
  const cached = store.getSetting('google_folder_id');
  if (cached) {
    const res = await auth.authedFetch(
      `${DRIVE_FILES}/${encodeURIComponent(cached)}?fields=id,trashed`);
    if (res.ok) {
      const folder = await res.json();
      if (!folder.trashed) return cached;
    }
    // 404 or trashed: the user deleted it. Fall through and make a new one
    // rather than failing every backup from here on.
  }

  const q = `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const search = await auth.authedFetch(
    `${DRIVE_FILES}?${new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' })}`);
  if (search.ok) {
    const found = (await search.json()).files?.[0];
    if (found) { store.setSetting('google_folder_id', found.id); return found.id; }
  }

  const created = await auth.authedFetch(DRIVE_FILES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  if (!created.ok) throw new Error(`could not create the Drive folder (${created.status})`);
  const id = (await created.json()).id;
  store.setSetting('google_folder_id', id);
  return id;
}

// The WHOLE log, overwritten every pass. Idempotent by construction: the next
// pass is correct no matter how many previous ones failed or how. listAllCalls
// exists because listCalls() defaults to 200 rows - see spec 7.1.
async function uploadLog({ auth, store, now = () => new Date() }) {
  const folderId = await ensureFolder({ auth, store });
  const body = Buffer.from(JSON.stringify({
    exportedAt: now().toISOString(),
    account: store.getSetting('google_account') || null,
    calls: store.listAllCalls(),
  }, null, 2));

  const cached = store.getSetting('google_log_file_id');
  if (cached) {
    const res = await auth.authedFetch(
      `${DRIVE_UPLOAD}/${encodeURIComponent(cached)}?uploadType=media&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) return cached;
    if (res.status !== 404) throw new Error(`call-log upload failed (${res.status})`);
    // 404: the user deleted it in Drive. Fall through and create a new one.
  }

  const id = await createFile({
    auth,
    metadata: { name: LOG_FILE_NAME, parents: [folderId] },
    mimeType: 'application/json',
    data: body,
  });
  store.setSetting('google_log_file_id', id);
  return id;
}

module.exports = {
  DRIVE_FILES, DRIVE_UPLOAD, FOLDER_NAME, LOG_FILE_NAME,
  multipartBody, createFile, ensureFolder, uploadLog,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-backup.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 8 new tests PASS; full suite 333 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/google/backup.js test/google-backup.test.js
git commit -m "feat(google): Drive folder and whole-file call-log backup

The log is one file overwritten every pass, so a pass is correct
regardless of how many previous ones failed. A folder or log file the
user deleted in Drive is recreated rather than breaking backup forever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Recording upload and the backup runner

**Files:**
- Modify: `src/main/google/backup.js`
- Test: `test/google-backup.test.js`

**Interfaces:**
- Consumes: `ensureFolder`, `createFile`, `uploadLog` (Task 7); `store.pendingRecordingBackups()`, `store.markRecordingBackedUp()` (Task 1).
- Produces:
  - `uploadRecordings({ auth, store, readFile, resolvePath }) => Promise<{ uploaded, skipped }>`
  - `createBackupRunner({ auth, store, readFile, resolvePath, now, delayMs, setTimeoutImpl }) => { runNow(), schedule() }` — `runNow()` **never rejects**

- [ ] **Step 1: Write the failing test**

Append to `test/google-backup.test.js`:

```js
const { uploadRecordings, createBackupRunner } = require('../src/main/google/backup');

function storeWithRecording() {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  const id = store.insertCall({ direction: 'in', number_e164: '+919000000001',
    ended_at: '2026-01-01T00:00:00Z', recording_path: 'call-1.opus' });
  return { store, id };
}

const folderOk = { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } };

test('recordings are not uploaded unless the user opted in', async () => {
  const { store } = storeWithRecording();
  const auth = fakeAuth([folderOk]);
  const res = await uploadRecordings({ auth, store, readFile: async () => Buffer.from('x') });
  assert.deepStrictEqual(res, { uploaded: 0, skipped: true });
  // Call audio is the most sensitive data this app holds: nothing leaves the
  // machine, not even a folder probe, until the toggle is on.
  assert.strictEqual(auth.calls.length, 0);
  store.close();
});

test('an opted-in recording uploads and records its drive id', async () => {
  const { store, id } = storeWithRecording();
  store.setSetting('google_backup_recordings', 'true');
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'rec-1' } },
  ]);
  const res = await uploadRecordings({ auth, store, readFile: async () => Buffer.from('OggS') });
  assert.strictEqual(res.uploaded, 1);
  assert.deepStrictEqual(store.pendingRecordingBackups(), []);
  store.markRecordingBackedUp(id, 'rec-1');
  store.close();
});

test('a failed upload leaves the row pending so the next pass retries it', async () => {
  const { store } = storeWithRecording();
  store.setSetting('google_backup_recordings', 'true');
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST', status: 503, body: {} },
  ]);
  await assert.rejects(uploadRecordings({ auth, store, readFile: async () => Buffer.from('x') }));
  // The NULL is the retry queue - no queue table, no backoff state.
  assert.strictEqual(store.pendingRecordingBackups().length, 1);
  store.close();
});

test('a recording deleted from disk is skipped, not fatal to the pass', async () => {
  const { store } = storeWithRecording();
  store.setSetting('google_backup_recordings', 'true');
  store.insertCall({ direction: 'out', number_e164: '+919000000002',
    ended_at: '2026-01-01T00:05:00Z', recording_path: 'call-2.opus' });
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST', status: 200, body: { id: 'rec-2' } },
  ]);
  const res = await uploadRecordings({
    auth, store,
    readFile: async (p) => {
      if (p.includes('call-1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.from('OggS');
    },
  });
  // One missing file must not stop the one after it from being backed up.
  assert.strictEqual(res.uploaded, 1);
  store.close();
});

test('the runner records a timestamp and clears the error on success', async () => {
  const { store } = storeWithRecording();
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'log-1' } },
  ]);
  auth.setError('a previous failure');
  const runner = createBackupRunner({ auth, store, readFile: async () => Buffer.from('x'),
    now: () => new Date('2026-09-02T11:00:00Z') });
  const res = await runner.runNow();
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(store.getSetting('google_backup_at'), '2026-09-02T11:00:00.000Z');
  assert.deepStrictEqual(auth.errors, []);
  store.close();
});

test('runNow reports failure instead of throwing into the call path', async () => {
  const { store } = storeWithRecording();
  const auth = fakeAuth([{ match: () => true, status: 500, body: {} }]);
  const runner = createBackupRunner({ auth, store, readFile: async () => Buffer.from('x') });
  // It is called from the call-end hook. A rejection there would surface as an
  // unhandled rejection during a phone call.
  const res = await runner.runNow();
  assert.ok(res.error, 'the failure is reported as a value');
  assert.strictEqual(auth.errors.length, 1);
  // The timestamp must NOT advance on a failed pass, or Settings would claim
  // a backup that never happened.
  assert.strictEqual(store.getSetting('google_backup_at'), null);
  store.close();
});

test('a signed-out runner does nothing at all', async () => {
  const { store } = storeWithRecording();
  const auth = fakeAuth([]);
  auth.isSignedIn = () => false;
  const runner = createBackupRunner({ auth, store, readFile: async () => Buffer.from('x') });
  assert.deepStrictEqual(await runner.runNow(), { skipped: 'signed-out' });
  assert.strictEqual(auth.calls.length, 0);
  store.close();
});

test('two concurrent passes collapse into one', async () => {
  const { store } = storeWithRecording();
  let release;
  const gate = new Promise((r) => { release = r; });
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST', status: 200, body: { id: 'log-1' } },
  ]);
  const realFetch = auth.authedFetch;
  auth.authedFetch = async (u, o) => { await gate; return realFetch(u, o); };
  const runner = createBackupRunner({ auth, store, readFile: async () => Buffer.from('x') });
  const a = runner.runNow();
  const b = runner.runNow();
  release();
  await Promise.all([a, b]);
  // Two passes would race on recording_backup_id and upload the same audio twice.
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 1);
  store.close();
});

test('a burst of calls debounces into a single pass', async () => {
  const { store } = storeWithRecording();
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST', status: 200, body: { id: 'log-1' } },
  ]);
  const timers = [];
  const runner = createBackupRunner({
    auth, store, readFile: async () => Buffer.from('x'), delayMs: 5000,
    setTimeoutImpl: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  runner.schedule();
  runner.schedule();
  runner.schedule();
  assert.strictEqual(timers.length, 1, 'three calls ending together are one backup pass');
  await timers[0]();
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/google-backup.test.js 2>&1 | tail -10`
Expected: FAIL — `uploadRecordings is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/main/google/backup.js` (and export both):

```js
const path = require('node:path');
const fsp = require('node:fs/promises');
const { resolveRecordingPath } = require('../recordings');

const RECORDING_MIME = { '.opus': 'audio/ogg', '.wav': 'audio/wav' };
const BACKUP_DEBOUNCE_MS = 5000;

// Opt-in, per file. The NULL recording_backup_id IS the retry queue: a failure
// simply leaves the row selected for the next pass.
async function uploadRecordings({
  auth, store, readFile = fsp.readFile, resolvePath = resolveRecordingPath,
}) {
  if (store.getSetting('google_backup_recordings') !== 'true') {
    return { uploaded: 0, skipped: true };
  }
  const pending = store.pendingRecordingBackups();
  if (pending.length === 0) return { uploaded: 0, skipped: false };

  const folderId = await ensureFolder({ auth, store });
  let uploaded = 0;
  for (const row of pending) {
    let data;
    try {
      data = await readFile(resolvePath(row.recording_path));
    } catch {
      // The user deleted or moved the file. Left pending deliberately: if it
      // comes back from a filesystem backup it gets uploaded, and one missing
      // file must not stop the recordings after it.
      continue;
    }
    const name = path.basename(row.recording_path);
    const id = await createFile({
      auth,
      metadata: { name, parents: [folderId] },
      mimeType: RECORDING_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      data,
    });
    store.markRecordingBackedUp(row.id, id);
    uploaded += 1;
  }
  return { uploaded, skipped: false };
}

// runNow() NEVER rejects. It is called from the call-end hook, where a
// rejection would surface as an unhandled rejection during a phone call.
// Failures are returned as { error }, recorded, and retried next pass.
function createBackupRunner({
  auth, store, readFile = fsp.readFile, resolvePath = resolveRecordingPath,
  now = () => new Date(), delayMs = BACKUP_DEBOUNCE_MS, setTimeoutImpl = setTimeout,
}) {
  let timer = null;
  let inFlight = null;

  async function pass() {
    const logFileId = await uploadLog({ auth, store, now });
    const recordings = await uploadRecordings({ auth, store, readFile, resolvePath });
    // Written only after both halves succeeded, so Settings never claims a
    // backup that did not happen.
    store.setSetting('google_backup_at', now().toISOString());
    auth.clearError?.();
    return { logFileId, recordingsUploaded: recordings.uploaded };
  }

  async function runNow() {
    if (!auth.isSignedIn()) return { skipped: 'signed-out' };
    // One pass at a time: two would race on recording_backup_id and upload the
    // same audio twice.
    if (inFlight) return inFlight;
    inFlight = pass()
      .catch((err) => {
        auth.setError?.(err.message);
        return { error: err.message };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  // Calls ending back to back are one pass, not one each.
  function schedule() {
    if (timer) return;
    timer = setTimeoutImpl(() => { timer = null; return runNow(); }, delayMs);
    timer.unref?.();
  }

  return { runNow, schedule };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/google-backup.test.js 2>&1 | tail -10 && npm test 2>&1 | tail -6`
Expected: 9 new tests PASS; full suite 342 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/main/google/backup.js test/google-backup.test.js
git commit -m "feat(google): opt-in recording backup and the debounced runner

Recordings upload only when the user opts in; a NULL recording_backup_id
is the retry queue, so an offline failure is picked up next pass with no
queue table or scheduler. runNow() never rejects - it is called from the
call-end hook.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: IPC, preload and app wiring

The first task where Google code actually runs inside the app. No unit tests — `ipc.js`, `preload.js` and `index.js` have none in this repo — so verification is by launching the app.

**Files:**
- Modify: `src/main/ipc.js`, `src/main/preload.js`, `src/main/index.js`

**Interfaces:**
- Consumes: `createAuth`, `syncContacts`, `createBackupRunner` (Tasks 5, 6, 8).
- Produces, on `window.konnect`: `googleStatus()`, `googleSignIn()`, `googleSignOut()`, `googleSyncContacts()`, `googleBackupNow()`, `onGoogleChanged(cb)`.

- [ ] **Step 1: Add the handlers to `src/main/ipc.js`**

Add to the `registerIpc({ ... })` destructured parameters:

```js
  google = null, syncGoogleContacts = async () => {}, backupNow = async () => {},
```

Add to the `handlers` object:

```js
    // Google is optional at every level: an unconfigured or absent integration
    // answers honestly instead of throwing, so the Settings section can render
    // a disabled row rather than an error.
    'google:status': () => (google ? google.status() : { configured: false, signedIn: false }),
    'google:sign-in': () => requireGoogle().signIn(),
    'google:sign-out': () => requireGoogle().signOut(),
    'google:sync-contacts': () => syncGoogleContacts(),
    'google:backup-now': () => backupNow(),
```

Add next to `needAudio` / `requireAdapter`:

```js
  const requireGoogle = () => {
    if (!google?.status().configured) {
      throw new Error('Google integration is not configured');
    }
    return google;
  };
```

- [ ] **Step 2: Mirror them in `src/main/preload.js`**

Add inside the `exposeInMainWorld` object:

```js
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleSignIn: () => ipcRenderer.invoke('google:sign-in'),
  googleSignOut: () => ipcRenderer.invoke('google:sign-out'),
  googleSyncContacts: () => ipcRenderer.invoke('google:sync-contacts'),
  googleBackupNow: () => ipcRenderer.invoke('google:backup-now'),
  onGoogleChanged: (cb) => ipcRenderer.on('google:changed', () => cb()),
```

- [ ] **Step 3: Wire it up in `src/main/index.js`**

Extend the Electron import to include `shell` and `safeStorage`:

```js
const {
  app, BrowserWindow, Tray, Menu, nativeImage, Notification, protocol, shell, safeStorage,
} = require('electron');
```

Add the requires next to the others:

```js
const { createAuth } = require('./google/auth');
const { syncContacts } = require('./google/contacts');
const { createBackupRunner } = require('./google/backup');
```

Add module-level state next to `let store = null;`:

```js
let google = null;
let backupRunner = null;
```

After `store` is opened and before `registerIpc`, construct both:

```js
  // openExternal, never a BrowserWindow: Google blocks embedded webviews, and
  // an in-app login window would mean Konnect renders someone's Google
  // password field.
  google = createAuth({ store, safeStorage, openExternal: (url) => shell.openExternal(url) });
  backupRunner = createBackupRunner({ auth: google, store });
```

Pass them into `registerIpc({ ... })`:

```js
    google,
    syncGoogleContacts: async () => {
      const res = await syncContacts({ auth: google, store });
      broadcast('contacts:changed', store.listContacts());
      broadcast('google:changed');
      return res;
    },
    backupNow: async () => {
      const res = await backupRunner.runNow();
      broadcast('google:changed');
      return res;
    },
```

Change the `createCallSession` `onPersisted` hook to schedule a backup:

```js
    // Fire-and-forget by construction: schedule() only arms a timer, and the
    // pass it eventually runs never rejects. A Google failure cannot reach
    // the call path (spec section 8).
    onPersisted: () => { broadcast('calls:changed'); backupRunner.schedule(); },
```

After the window is created and the app is ready, drain anything missed while
the app was closed:

```js
  // Startup catch-up. Both are detached: neither may delay the window, and a
  // Google outage must not stop the phone from working.
  if (google.isSignedIn()) {
    syncContacts({ auth: google, store })
      .then(() => broadcast('contacts:changed', store.listContacts()))
      .catch((err) => google.setError(err.message))
      .finally(() => broadcast('google:changed'));
    backupRunner.runNow().finally(() => broadcast('google:changed'));
  }
```

- [ ] **Step 4: Verify the whole suite still passes, then verify in the real app**

Run: `npm test 2>&1 | tail -6`
Expected: 342 pass, 0 fail — no test changes in this task, so a failure here means the wiring broke something existing.

Then launch with no credentials configured:

Run: `npm start`
Expected: the app starts normally; the dialer, call log and settings all work. Nothing Google-related runs. In the DevTools console:

```js
await window.konnect.googleStatus()
// { configured: false, signedIn: false }
await window.konnect.googleSignIn().catch(e => e.message)
// "Google integration is not configured"
```

That is the skip path: an unconfigured build is simply a phone app.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.js src/main/preload.js src/main/index.js
git commit -m "feat(google): IPC surface and app wiring

Six channels declared in ipc.js and mirrored in preload.js. Backup is
scheduled from the existing onPersisted hook, where recording_path is
already written, and detached so no Google failure can reach the call
path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The Settings section

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/settings.js`

**Interfaces:**
- Consumes: the `window.konnect.google*` bindings from Task 9.
- Produces: a `renderGoogle()` section registered in `renderSettings()`.

- [ ] **Step 1: Add the markup**

In `src/renderer/index.html`, inside `#settings-panel`, after the Recording fieldset:

```html
          <fieldset><legend>Google account</legend><div id="set-google"></div></fieldset>
```

- [ ] **Step 2: Add `renderGoogle()` to `src/renderer/settings.js`**

```js
// Every state this section can be in is a sentence the user can act on:
// unconfigured, signed out, signed in, or signed in with something wrong.
async function renderGoogle() {
  const host = $('#set-google');
  host.replaceChildren();
  const s = await window.konnect.googleStatus();

  if (!s.configured) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Google integration is not configured. Set GOOGLE_CLIENT_ID in the '
      + 'environment, or create ~/.config/konnect/google.json, then restart Konnect.';
    host.append(p);
    return;
  }

  if (!s.signedIn) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Sign in to sync your Google contacts and back up your call log to '
      + 'Google Drive. Konnect never changes your Google contacts. You can use every '
      + 'part of the app without signing in.';
    const btn = document.createElement('button');
    btn.textContent = 'Sign in with Google';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Waiting for your browser…';
      try {
        await window.konnect.googleSignIn();
      } catch (err) {
        // Never dead-end: say what went wrong and let them try again.
        p.textContent = err.message;
      }
      await renderSettings();
    });
    host.append(p, btn);
    return;
  }

  const account = document.createElement('p');
  account.textContent = s.email || 'Signed in';

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  const times = document.createElement('p');
  times.className = 'sub';
  times.textContent = `Contacts synced ${when(s.contactsSyncedAt)} · `
    + `Backed up ${when(s.backupAt)}`;
  host.append(account, times);

  // safeStorage degrades silently to a hardcoded key when no keyring is
  // present. Saying so is the point - a quiet downgrade is worse than none.
  if (s.weakEncryption || s.sessionOnly) {
    const warn = document.createElement('p');
    warn.className = 'sub';
    warn.textContent = s.sessionOnly
      ? 'No system keyring is available, so you are signed in for this session only.'
      : 'No system keyring is available; the saved sign-in is obfuscated, not encrypted.';
    host.append(warn);
  }

  if (s.lastError) {
    const err = document.createElement('p');
    err.className = 'sub';
    err.textContent = `Last attempt failed: ${s.lastError}`;
    host.append(err);
  }

  // Off by default and never flipped for the user: call audio is the most
  // sensitive data this app holds.
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 's-google-recordings';
  box.checked = s.backupRecordings;
  const text = document.createElement('span');
  text.className = 'grow';
  text.textContent = 'Back up call recordings too';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = 'Uploads recorded call audio to your Drive folder. Turning this off '
    + 'stops new uploads; it does not delete what is already in Drive.';
  text.append(sub);
  box.addEventListener('change', async () => {
    await window.konnect.setSetting('google_backup_recordings', String(box.checked));
    if (box.checked) await window.konnect.googleBackupNow();
  });
  label.append(box, text);

  const row = document.createElement('div');
  row.className = 'row';
  const action = (text, run) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', async () => {
      const original = b.textContent;
      b.disabled = true;
      b.textContent = 'Working…';
      try { await run(); } catch (err) { times.textContent = err.message; }
      b.disabled = false;
      b.textContent = original;
      await renderGoogle();
    });
    return b;
  };
  const signOut = action('Sign out', async () => {
    const res = await window.konnect.googleSignOut();
    // Say plainly what was removed and what was kept.
    times.textContent = `Signed out. ${res.removedContacts} Google contact(s) removed `
      + 'from Konnect; anything already in Drive was kept.';
  });
  signOut.className = 'danger';
  row.append(
    action('Sync contacts now', () => window.konnect.googleSyncContacts()),
    action('Back up now', () => window.konnect.googleBackupNow()),
    signOut);

  host.append(label, row);
}
```

Register it in `renderSettings()`, after the Startup section:

```js
  if (token !== settingsRenderToken) return;
  await renderSection('Google account', $('#set-google'), renderGoogle);
```

- [ ] **Step 3: Re-render when main says the Google state changed**

Next to the other `window.konnect.on*` subscriptions in `settings.js`:

```js
// Startup sync/backup finish after the page has already rendered.
window.konnect.onGoogleChanged(() => renderSettings());
```

- [ ] **Step 4: Verify in the real app**

Run: `npm test 2>&1 | tail -6`
Expected: 342 pass, 0 fail.

Run: `npm start`

Unconfigured — Settings → Google account shows the "not configured" sentence and no buttons. Every other section still renders (the `renderSection` backstop means a Google failure cannot blank Startup or System checks).

Then configure a Desktop-app OAuth client in a Google Cloud project, enable the People API and the Drive API, and:

```bash
mkdir -p ~/.config/konnect
printf '{"client_id":"YOUR_ID.apps.googleusercontent.com","client_secret":"YOUR_SECRET"}' \
  > ~/.config/konnect/google.json
npm start
```

Expected, checked one at a time:
1. "Sign in with Google" opens the **system browser**, not a window inside Konnect.
2. Consent screen lists contacts (read-only) and Drive file access only.
3. After consent, the browser tab says the sign-in worked; Settings shows the account email.
4. Contacts appear in the Contacts list; a call from a Google-only contact shows their name.
5. Drive has a `JioPhone Konnect` folder containing `call-log.json`, and its `calls` array length matches `SELECT COUNT(*) FROM calls`.
6. With the recordings toggle OFF, make and end a recorded call: `call-log.json` updates, no audio is uploaded.
7. Turn the recordings toggle ON: the existing recording uploads. Make another call; it uploads too.
8. Pull the network cable mid-call, end the call: no error dialog, no delay in the call UI. Settings shows the failure. Reconnect and press "Back up now": it recovers with no duplicates in Drive.
9. Revoke access at myaccount.google.com → Security → Third-party access, then press "Sync contacts now": Settings flips to signed out saying access was revoked.
10. Sign out: Google contacts disappear from the list, handset contacts remain, the Drive folder is untouched.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/settings.js
git commit -m "feat(google): Settings section for the Google account

Four states, each a sentence the user can act on: unconfigured, signed
out, signed in, and signed in with a failure. The recordings toggle is
off by default and says what turning it off does not do.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` — 342 pass, 0 fail
- [ ] `grep -rn "googleapis\|google-auth-library" package.json` — no matches (Global Constraints)
- [ ] `git log --oneline -10` — ten focused commits, no credentials in any diff
- [ ] `grep -rn "client_secret" --include=*.js src/ | grep -v "clientSecret ?" ` — no literal secret anywhere
- [ ] The ten manual checks in Task 10 Step 4 all pass against a real Google account
