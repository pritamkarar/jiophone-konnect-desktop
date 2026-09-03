# Konnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop PC suite for a JioPhone (KaiOS) on Ubuntu — device status, contacts import, a dialer that places and receives calls through the handset, call logs, call recording and report export.

**Architecture:** An Electron app whose main process is a thin client over three Linux daemons that already implement the Bluetooth protocols: oFono (HFP telephony over D-Bus), BlueZ obexd (OBEX Object Push for contacts) and PipeWire (SCO call audio). All platform-specific code sits behind one backend interface with three implementations — `linux/`, `mock/` and a `windows/` stub — so the renderer never touches D-Bus.

**Tech Stack:** Electron 44, Node 24, `dbus-next`, `node:sqlite`, plain HTML/CSS/JS renderer (no framework), `node:test` + `node:assert`, `pw-record`/`pw-link`/`ffmpeg` as child processes.

**Spec:** `docs/superpowers/specs/2026-09-01-jiophone-konnect-design.md`

## Global Constraints

- **Target device:** LYF JioPhone F120B, BD_ADDR `44:CD:0E:AD:5E:34`. Do not hardcode this address outside config/tests; it is stored in `settings`.
- **Target platform:** Ubuntu 24.04. `windows/` is a stub that throws `UnsupportedPlatformError`; never add Windows logic beyond the stub.
- **oFono modem path shape:** `/hfp/org/bluez/hci0/dev_<MAC with underscores>`.
- **Never re-attempt PBAP.** Spec §2.2. Contacts arrive over OBEX Object Push only.
- **Never build `pw-loopback` routing.** Spec §7.1. WirePlumber links SCO audio to default devices automatically.
- **Never use `pw-record --target <node>`.** Spec §7.2. It silently falls back to the default source. Always `--target 0` plus explicit `pw-link`.
- **Never toggle the oFono modem to work around an OBEX problem.** Spec §2.2. Powering it off drops the whole ACL link.
- **obexd's OBEX CONNECT timeout is ~10 seconds** and is not configurable from our side.
- **SMS is out of scope.** The handset advertises no MAP profile. Do not add a messaging surface.
- **Call log is live-only.** There is no historical import. Empty state must explain this, never look like a sync failure.
- **Tests:** `node:test` + `node:assert` only. No test framework dependencies.
- **Dependencies:** `electron` (^44), `electron-builder`, `dbus-next`. That is the whole list.
  Storage is the stdlib `node:sqlite` — do **not** add `better-sqlite3` or
  `@electron/rebuild`. A native module rebuilt for the Electron ABI cannot be
  loaded by `node --test`, which would break `npm test`. Adding any other
  runtime dependency requires justification against the spec.

---

## File Structure

```
package.json
src/
  main/
    index.js              Electron entry: window, tray, app lifecycle
    ipc.js                contextBridge channel registration, one place
    preload.js            contextBridge exposure to renderer
    store.js              SQLite: schema, migrations, queries
    setup.js              environment detection + pkexec remediation
    export.js             CSV writers + PDF report via printToPDF
    backend/
      index.js            platform switch, exports one backend instance
      interface.js        the contract + UnsupportedPlatformError
      mock/index.js       fixture-driven backend, no hardware
      windows/index.js    stub, throws
      linux/
        bus.js            dbus-next connection helpers, shared
        device.js         BlueZ: connection state, battery
        telephony.js      oFono: status, call events, dial/answer/hangup
        recorder.js       pw-record + pw-link + ffmpeg encode
        opp.js            obexd OBEX receive agent for contacts
  shared/
    vcard.js              vCard 2.1 parser (incl. quoted-printable)
    phone.js              E.164 normalisation
  renderer/
    index.html            shell + all views
    app.js                view routing, IPC wiring
    styles.css            all styling
test/
  vcard.test.js
  phone.test.js
  store.test.js
  export.test.js
  setup.test.js
```

Files split by responsibility, not layer. `linux/` files each own one daemon so a failure has one obvious home. `shared/` holds pure functions with no I/O — these carry the real test suite.

---

### Task 1: Project scaffold, backend contract and mock backend

Establishes the seam everything else plugs into. Nothing here touches hardware, so it is fully testable on any machine.

**Files:**
- Create: `package.json`
- Create: `src/main/backend/interface.js`
- Create: `src/main/backend/mock/index.js`
- Create: `src/main/backend/windows/index.js`
- Create: `src/main/backend/index.js`
- Test: `test/backend.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `UnsupportedPlatformError` (class, `extends Error`)
  - `BACKEND_METHODS: string[]` — the required method names
  - `createBackend({ platform, mock, mac }) -> Backend`
  - `Backend` shape (all async unless noted):
    - `listDevices() -> Promise<Array<{mac, name, paired, connected}>>`
    - `connect(mac) -> Promise<void>`
    - `disconnect() -> Promise<void>`
    - `getStatus() -> Promise<Status>` where `Status = {connected: boolean, model: string|null, battery: number|null, signal: number|null, operator: string|null, roaming: boolean, error: string|null}`
      `error` is non-null only when the status could not be read at all (bus
      unreachable, service down). It exists so "we could not ask" is
      distinguishable from "the handset is disconnected".
    - `onDeviceStatus(cb: (Status) => void) -> () => void` (sync, returns unsubscribe)
    - `dial(number) -> Promise<string>` (resolves call id)
    - `answer(callId) -> Promise<void>`
    - `hangup(callId) -> Promise<void>`
    - `sendDtmf(digits) -> Promise<void>`
    - `onCall(cb: (Call) => void) -> () => void` where `Call = {id, direction: 'in'|'out', state: 'incoming'|'dialing'|'alerting'|'active'|'disconnected', number, name: string|null, startedAt: string|null}`
    - `startContactImport() -> Promise<void>`
    - `cancelContactImport() -> Promise<void>`
    - `onContacts(cb: (Array<Contact>) => void) -> () => void` where `Contact = {uid, name, numbers: string[]}`
    - `startRecording(callId) -> Promise<string>` (resolves output path)
    - `stopRecording(callId) -> Promise<string|null>` (resolves final encoded path)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "konnect",
  "version": "0.1.0",
  "description": "PC suite for JioPhone (KaiOS) over Bluetooth",
  "main": "src/main/index.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test"
  },
  "devDependencies": {
    "electron": "^44.0.0"
  },
  "dependencies": {
    "dbus-next": "^0.10.2"
  }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `test/backend.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createBackend } = require('../src/main/backend');
const { BACKEND_METHODS, UnsupportedPlatformError } = require('../src/main/backend/interface');

test('mock backend implements every method in the contract', () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  for (const name of BACKEND_METHODS) {
    assert.strictEqual(typeof backend[name], 'function', `missing ${name}`);
  }
});

test('windows backend throws UnsupportedPlatformError on any call', async () => {
  const backend = createBackend({ platform: 'win32', mock: false });
  await assert.rejects(() => backend.getStatus(), UnsupportedPlatformError);
});

test('mock reports a connected handset', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const status = await backend.getStatus();
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.operator, 'JIO');
  assert.strictEqual(typeof status.battery, 'number');
});

test('mock emits a call lifecycle ending in disconnected', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const seen = [];
  backend.onCall((c) => seen.push(c.state));
  const id = await backend.dial('+919876543210');
  assert.strictEqual(typeof id, 'string');
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(seen.includes('dialing'), `saw ${seen}`);
  assert.ok(seen.includes('active'), `saw ${seen}`);
  await backend.hangup(id);
  assert.strictEqual(seen.at(-1), 'disconnected');
});

test('unsubscribe stops delivery', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  let count = 0;
  const off = backend.onCall(() => { count += 1; });
  off();
  await backend.dial('+919876543210');
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(count, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/main/backend'`

- [ ] **Step 4: Write `src/main/backend/interface.js`**

```js
'use strict';

class UnsupportedPlatformError extends Error {
  constructor(platform) {
    super(`Konnect has no backend for platform: ${platform}`);
    this.name = 'UnsupportedPlatformError';
  }
}

// The contract. Every backend must implement all of these.
const BACKEND_METHODS = [
  'listDevices', 'connect', 'disconnect', 'getStatus', 'onDeviceStatus',
  'dial', 'answer', 'hangup', 'sendDtmf', 'onCall',
  'startContactImport', 'cancelContactImport', 'onContacts',
  'startRecording', 'stopRecording',
];

// Minimal typed-event helper shared by backends. Returns an unsubscribe fn,
// so callers never need to hold onto the original callback.
function createEmitter() {
  const listeners = new Set();
  return {
    on(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    emit(value) { for (const cb of [...listeners]) cb(value); },
    get size() { return listeners.size; },
  };
}

module.exports = { UnsupportedPlatformError, BACKEND_METHODS, createEmitter };
```

- [ ] **Step 5: Write `src/main/backend/windows/index.js`**

```js
'use strict';
const { BACKEND_METHODS, UnsupportedPlatformError } = require('../interface');

// Stub only. Windows has no public API for the HFP hands-free role or PBAP,
// and SCO call audio is unreachable. See spec section 2 and 11.
function createWindowsBackend() {
  const backend = {};
  for (const name of BACKEND_METHODS) {
    backend[name] = async () => { throw new UnsupportedPlatformError('win32'); };
  }
  return backend;
}

module.exports = { createWindowsBackend };
```

- [ ] **Step 6: Write `src/main/backend/mock/index.js`**

```js
'use strict';
const { createEmitter } = require('../interface');

const MOCK_CONTACTS = [
  { uid: 'mock-1', name: 'Amit Sharma', numbers: ['+919876543210'] },
  { uid: 'mock-2', name: 'Priya Nair', numbers: ['+919812345678'] },
];

// Drives the renderer with no hardware. Call states advance on timers that
// mirror the real oFono sequence observed in the phase 0 spike.
function createMockBackend() {
  const statusEmitter = createEmitter();
  const callEmitter = createEmitter();
  const contactsEmitter = createEmitter();
  const timers = new Set();
  let seq = 0;
  let current = null;

  const later = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  let importTimer = null;

  const status = {
    connected: true, model: 'F120B', battery: 80,
    signal: 100, operator: 'JIO', roaming: false, error: null,
  };

  function emitCall(state, extra = {}) {
    if (!current) return;
    current = { ...current, state, ...extra };
    callEmitter.emit(current);
  }

  return {
    async listDevices() {
      // Placeholder address: the mock must not carry the real handset's
      // BD_ADDR. The real address belongs in settings and test fixtures.
      return [{ mac: '00:11:22:33:44:55', name: 'F120B (mock)', paired: true, connected: true }];
    },
    async connect() {},
    async disconnect() {},
    async getStatus() { return { ...status }; },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },

    async dial(number) {
      const id = `mock-call-${++seq}`;
      current = { id, direction: 'out', state: 'dialing', number, name: null, startedAt: null };
      later(0, () => emitCall('dialing'));
      later(60, () => emitCall('alerting'));
      later(120, () => emitCall('active', { startedAt: new Date().toISOString() }));
      return id;
    },
    async answer() { emitCall('active', { startedAt: new Date().toISOString() }); },
    async hangup() { emitCall('disconnected'); current = null; },
    async sendDtmf() {},
    onCall(cb) { return callEmitter.on(cb); },

    // Mock-only, deliberately NOT part of the backend contract: lets the
    // incoming-call window and its notification be exercised without ringing a
    // real phone. Without it the only way to test task 10 is a real call.
    simulateIncoming(number = '+919804464251', name = null) {
      const id = `mock-call-${++seq}`;
      current = { id, direction: 'in', state: 'incoming', number, name, startedAt: null };
      callEmitter.emit(current);
      return id;
    },

    async startContactImport() {
      importTimer = later(50, () => contactsEmitter.emit(MOCK_CONTACTS));
    },
    // Must genuinely cancel: a no-op here would make every downstream
    // "cancel import" button look broken when tested against the mock.
    async cancelContactImport() {
      if (!importTimer) return;
      clearTimeout(importTimer);
      timers.delete(importTimer);
      importTimer = null;
    },
    onContacts(cb) { return contactsEmitter.on(cb); },

    async startRecording(callId) { return `/tmp/konnect-mock-${callId}.wav`; },
    async stopRecording(callId) { return `/tmp/konnect-mock-${callId}.opus`; },

    // matches the dispose() every backend exposes, so main can call it
    // uniformly; also stops test suites leaking timers
    dispose() { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}

module.exports = { createMockBackend };
```

- [ ] **Step 7: Write `src/main/backend/index.js`**

```js
'use strict';
const { UnsupportedPlatformError } = require('./interface');
const { createMockBackend } = require('./mock');
const { createWindowsBackend } = require('./windows');

function createBackend({ platform = process.platform, mock = false, mac } = {}) {
  if (mock) return createMockBackend();
  if (platform === 'linux') {
    // Required lazily: pulls in dbus-next, which has no meaning off Linux.
    const { createLinuxBackend } = require('./linux');
    return createLinuxBackend(mac ? { mac } : {});
  }
  if (platform === 'win32') return createWindowsBackend();
  throw new UnsupportedPlatformError(platform);
}

module.exports = { createBackend };
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 5 tests. The linux branch is not exercised yet, so the missing `./linux` module does not matter.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/main/backend test/backend.test.js
git commit -m "feat: backend contract with mock and windows-stub implementations"
```

---

### Task 2: SQLite store

The only stateful component. Built before any UI so every later task has somewhere to write.

**Storage engine decision:** the stdlib `node:sqlite`. A native module such as
`better-sqlite3` must be rebuilt for the Electron ABI to run in the app, and
that same build then fails to load under `node --test` - one build cannot
serve both. `node:sqlite` sidesteps the problem entirely and drops two
dependencies. It prints an ExperimentalWarning on first use; that is expected.

**Files:**
- Create: `src/main/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `openStore(path) -> Store` (`':memory:'` supported for tests)
  - `Store.upsertContacts(Array<{uid, name, numbers: string[]}>) -> {added: number, updated: number}`
  - `Store.listContacts() -> Array<{id, uid, name, number_e164, number_raw, type}>`
  - `Store.findContactByNumber(e164) -> {id, name}|null`
  - `Store.insertCall({direction, number_e164, started_at, ended_at, duration_s, recording_path}) -> number`
  - `Store.listCalls({limit, offset, from, to}) -> Array<Call>`
  - `Store.callStats({from, to}) -> {total, in, out, missed, talkTimeSeconds, topContacts}`
  - `Store.getSetting(key) -> string|null` / `Store.setSetting(key, value) -> void`
  - `Store.close() -> void`

- [ ] **Step 1: Confirm `node:sqlite` is available**

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').exec('CREATE TABLE t(a)'); console.log('node:sqlite OK')"
npx electron -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').exec('CREATE TABLE t(a)'); console.log('electron node:sqlite OK')" 2>/dev/null || echo "electron check skipped"
```

Expected: `node:sqlite OK`. If the Electron check fails outright (not merely
skipped), STOP and report - the fallback is `better-sqlite3` with tests run
under Electron, which changes this task's shape.

- [ ] **Step 2: Write the failing test**

Create `test/store.test.js`:

```js
// Pin the zone before anything constructs a Date. The local-day filter test
// below is only meaningful under a non-UTC offset: on a UTC machine a 02:00
// local call stores as 02:00Z the same day, so the assertion holds against the
// broken code too and the test silently stops discriminating on CI.
process.env.TZ = 'Asia/Kolkata';

const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');

function fresh() { return openStore(':memory:'); }

test('upsertContacts adds then updates without duplicating', () => {
  const s = fresh();
  let r = s.upsertContacts([{ uid: 'a', name: 'Amit', numbers: ['+919876543210'] }]);
  assert.deepStrictEqual(r, { added: 1, updated: 0 });
  r = s.upsertContacts([{ uid: 'a', name: 'Amit Sharma', numbers: ['+919876543210'] }]);
  assert.deepStrictEqual(r, { added: 0, updated: 1 });
  const all = s.listContacts();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].name, 'Amit Sharma');
  s.close();
});

test('a contact with two numbers yields two rows sharing a uid', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'b', name: 'Priya', numbers: ['+919812345678', '+919800000000'] }]);
  assert.strictEqual(s.listContacts().length, 2);
  s.close();
});

test('findContactByNumber resolves caller id', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'a', name: 'Amit', numbers: ['+919876543210'] }]);
  assert.strictEqual(s.findContactByNumber('+919876543210').name, 'Amit');
  assert.strictEqual(s.findContactByNumber('+910000000000'), null);
  s.close();
});

test('insertCall links to a contact when the number matches', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'a', name: 'Amit', numbers: ['+919876543210'] }]);
  const id = s.insertCall({
    direction: 'out', number_e164: '+919876543210',
    started_at: '2026-09-01T12:04:29+05:30', ended_at: '2026-09-01T12:05:29+05:30',
    duration_s: 60, recording_path: null,
  });
  assert.strictEqual(typeof id, 'number');
  const [call] = s.listCalls({ limit: 10 });
  assert.strictEqual(call.name, 'Amit');
  assert.strictEqual(call.duration_s, 60);
  s.close();
});

test('a missed call has null started_at and zero duration', () => {
  const s = fresh();
  s.insertCall({
    direction: 'in', number_e164: '+919804464251',
    started_at: null, ended_at: '2026-09-01T12:06:00+05:30',
    duration_s: 0, recording_path: null,
  });
  const stats = s.callStats({});
  assert.strictEqual(stats.missed, 1);
  assert.strictEqual(stats.talkTimeSeconds, 0);
  s.close();
});

test('callStats aggregates direction split, talk time and top contacts', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'a', name: 'Amit', numbers: ['+919876543210'] }]);
  for (let i = 0; i < 3; i += 1) {
    s.insertCall({
      direction: 'out', number_e164: '+919876543210',
      started_at: '2026-09-01T12:00:00+05:30', ended_at: '2026-09-01T12:01:00+05:30',
      duration_s: 60, recording_path: null,
    });
  }
  s.insertCall({
    direction: 'in', number_e164: '+919804464251',
    started_at: '2026-09-01T13:00:00+05:30', ended_at: '2026-09-01T13:00:30+05:30',
    duration_s: 30, recording_path: null,
  });
  const st = s.callStats({});
  assert.strictEqual(st.total, 4);
  assert.strictEqual(st.out, 3);
  assert.strictEqual(st.in, 1);
  assert.strictEqual(st.talkTimeSeconds, 210);
  assert.strictEqual(st.topContacts[0].count, 3);
  assert.strictEqual(st.topContacts[0].name, 'Amit');
  s.close();
});

test('listCalls filters by date range', () => {
  const s = fresh();
  s.insertCall({ direction: 'out', number_e164: '+911', started_at: '2026-08-01T10:00:00+05:30', ended_at: '2026-08-01T10:01:00+05:30', duration_s: 60, recording_path: null });
  s.insertCall({ direction: 'out', number_e164: '+912', started_at: '2026-09-01T10:00:00+05:30', ended_at: '2026-09-01T10:01:00+05:30', duration_s: 60, recording_path: null });
  const rows = s.listCalls({ from: '2026-08-15', to: '2026-09-30' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].number_e164, '+912');
  s.close();
});

test('settings round-trip and missing keys return null', () => {
  const s = fresh();
  assert.strictEqual(s.getSetting('nope'), null);
  s.setSetting('record_calls', 'true');
  assert.strictEqual(s.getSetting('record_calls'), 'true');
  s.setSetting('record_calls', 'false');
  assert.strictEqual(s.getSetting('record_calls'), 'false');
  s.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL - `Cannot find module '../src/main/store'`

- [ ] **Step 4: Write `src/main/store.js`**

```js
'use strict';
const { DatabaseSync } = require('node:sqlite');
const { UNKNOWN_NUMBER } = require('../shared/phone');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY,
  uid          TEXT NOT NULL,
  name         TEXT NOT NULL,
  number_e164  TEXT NOT NULL,
  number_raw   TEXT,
  type         TEXT,
  synced_at    TEXT NOT NULL,
  UNIQUE (uid, number_e164)
);
CREATE INDEX IF NOT EXISTS idx_contacts_number ON contacts (number_e164);

CREATE TABLE IF NOT EXISTS calls (
  id             INTEGER PRIMARY KEY,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  number_e164    TEXT NOT NULL,
  contact_id     INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  started_at     TEXT,
  ended_at       TEXT NOT NULL,
  duration_s     INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'live',
  recording_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_ended ON calls (ended_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function openStore(path) {
  const db = new DatabaseSync(path);
  // node:sqlite has no pragma() helper; PRAGMAs go through exec().
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const stmt = {
    insertContact: db.prepare(
      `INSERT INTO contacts (uid, name, number_e164, number_raw, type, synced_at)
       VALUES (@uid, @name, @number_e164, @number_raw, @type, @synced_at)
       ON CONFLICT (uid, number_e164) DO UPDATE SET
         name = excluded.name, synced_at = excluded.synced_at`),
    listContacts: db.prepare(
      `SELECT id, uid, name, number_e164, number_raw, type
       FROM contacts ORDER BY name COLLATE NOCASE, number_e164`),
    // ORDER BY id makes attribution deterministic when two contacts share a
    // number (a family landline, a shared work line): first synced wins,
    // every time, rather than whichever row SQLite happens to return.
    findByNumber: db.prepare(
      `SELECT id, name FROM contacts WHERE number_e164 = ?
       ORDER BY id LIMIT 1`),
    // Scoped by uid: the add/update tally must reflect what the INSERT
    // actually did, and the conflict target is (uid, number_e164). Probing
    // by number alone counts a genuine insert for contact B as an "update"
    // merely because contact A already had that number.
    findByUidAndNumber: db.prepare(
      `SELECT id FROM contacts WHERE uid = ? AND number_e164 = ? LIMIT 1`),
    insertCall: db.prepare(
      `INSERT INTO calls (direction, number_e164, contact_id, started_at,
                          ended_at, duration_s, source, recording_path)
       VALUES (@direction, @number_e164, @contact_id, @started_at,
               @ended_at, @duration_s, 'live', @recording_path)`),
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    setSetting: db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  };

  // The date pickers yield a LOCAL calendar day, but ended_at is stored in UTC
  // (callsession writes toISOString()). Comparing a bare local date against
  // UTC text drops calls made in the early hours of a local day in any
  // positive-offset zone: in IST a 02:00 call is stored as 20:30Z the previous
  // day, so it vanishes from its own day and shows up under the one before.
  // Measured before fixing: from=2026-09-01 returned 0 rows for a 02:00 IST
  // call; from=2026-08-31 returned it.
  //
  // Both helpers also accept a full timestamp unchanged, so programmatic
  // callers are unaffected, and return null for input Date cannot parse - a
  // bad bound is dropped rather than silently matching nothing.
  function dayStartUtc(date) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function dayEndUtc(date) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.999` : date;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function rangeClause(from, to) {
    const where = [];
    const params = {};
    const fromUtc = from ? dayStartUtc(from) : null;
    const toUtc = to ? dayEndUtc(to) : null;
    if (fromUtc) { where.push(`ended_at >= @from`); params.from = fromUtc; }
    if (toUtc) { where.push(`ended_at <= @to`); params.to = toUtc; }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  return {
    upsertContacts(contacts) {
      const synced_at = new Date().toISOString();
      let added = 0;
      let updated = 0;
      // node:sqlite has no transaction() helper; drive it with exec().
      db.exec('BEGIN');
      try {
        for (const c of contacts) {
          for (const raw of c.numbers) {
            const existing = stmt.findByUidAndNumber.get(c.uid, raw);
            stmt.insertContact.run({
              uid: c.uid, name: c.name, number_e164: raw,
              number_raw: c.raw || raw, type: c.type || null, synced_at,
            });
            if (existing) updated += 1; else added += 1;
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { added, updated };
    },

    listContacts() { return stmt.listContacts.all(); },

    findContactByNumber(e164) { return stmt.findByNumber.get(e164) ?? null; },

    insertCall(call) {
      const match = stmt.findByNumber.get(call.number_e164);
      const info = stmt.insertCall.run({
        direction: call.direction,
        number_e164: call.number_e164,
        contact_id: match ? match.id : null,
        started_at: call.started_at ?? null,
        ended_at: call.ended_at,
        duration_s: call.duration_s ?? 0,
        recording_path: call.recording_path ?? null,
      });
      // node:sqlite may hand back a BigInt for rowids.
      return Number(info.lastInsertRowid);
    },

    listCalls({ limit = 200, offset = 0, from = null, to = null } = {}) {
      const { sql, params } = rangeClause(from, to);
      return db.prepare(
        `SELECT c.*, ct.name AS name
         FROM calls c LEFT JOIN contacts ct ON ct.id = c.contact_id
         ${sql}
         ORDER BY c.ended_at DESC LIMIT @limit OFFSET @offset`
      ).all({ ...params, limit, offset });
    },

    callStats({ from = null, to = null } = {}) {
      const { sql, params } = rangeClause(from, to);
      const totals = db.prepare(
        `SELECT
           COUNT(*)                                     AS total,
           SUM(direction = 'in')                        AS inbound,
           SUM(direction = 'out')                       AS outbound,
           SUM(started_at IS NULL AND direction = 'in') AS missed,
           COALESCE(SUM(duration_s), 0)                 AS talk
         FROM calls ${sql}`
      ).get(params);
      // Group by contact identity (uid) where one is known, else by number.
      // NOT by contact_id: contacts.id is a per-(uid, number) ROW id, so one
      // person with two numbers owns two ids and would still fragment.
      // Grouping by number alone splits them the same way.
      //
      // Anonymous calls all share the UNKNOWN_NUMBER sentinel, so leaving them
      // in would present unrelated withheld-number callers as a single frequent
      // contact. They still count in the totals above - they happened - they
      // are simply not a contact.
      const topWhere = sql
        ? `${sql} AND c.number_e164 <> @unknownNumber`
        : 'WHERE c.number_e164 <> @unknownNumber';
      const topContacts = db.prepare(
        `SELECT COALESCE(ct.name, c.number_e164) AS name,
                MIN(c.number_e164) AS number, COUNT(*) AS count
         FROM calls c LEFT JOIN contacts ct ON ct.id = c.contact_id
         ${topWhere}
         GROUP BY COALESCE(ct.uid, 'n:' || c.number_e164)
         ORDER BY count DESC, name LIMIT 10`
      ).all({ ...params, unknownNumber: UNKNOWN_NUMBER });
      return {
        total: totals.total || 0,
        in: totals.inbound || 0,
        out: totals.outbound || 0,
        missed: totals.missed || 0,
        talkTimeSeconds: totals.talk || 0,
        topContacts,
      };
    },

    getSetting(key) {
      const row = stmt.getSetting.get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) { stmt.setSetting.run(key, String(value)); },
    close() { db.close(); },
  };
}

module.exports = { openStore };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/store.js test/store.test.js
git commit -m "feat: sqlite store for contacts, calls and settings"
```

---

### Task 3: Pure utilities - vCard 2.1 parser and E.164 normalisation

No I/O, no D-Bus, no Electron. These carry the real test suite and are the two places where a subtle bug would silently corrupt user data.

**Files:**
- Create: `src/shared/phone.js`
- Create: `src/shared/vcard.js`
- Test: `test/phone.test.js`
- Test: `test/vcard.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normaliseIndian(input) -> string|null` (`null` for unusable input)
  - `parseVCards(text) -> Array<{uid, name, numbers: string[], raw: string[]}>`

- [ ] **Step 1: Write the failing phone test**

Create `test/phone.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { normaliseIndian } = require('../src/shared/phone');

test('already E.164 passes through', () => {
  assert.strictEqual(normaliseIndian('+919876543210'), '+919876543210');
});

test('ten digit local number gains +91', () => {
  assert.strictEqual(normaliseIndian('9876543210'), '+919876543210');
});

test('leading zero trunk prefix is stripped', () => {
  assert.strictEqual(normaliseIndian('09876543210'), '+919876543210');
});

test('country code without plus is normalised', () => {
  assert.strictEqual(normaliseIndian('919876543210'), '+919876543210');
});

test('formatting characters are ignored', () => {
  assert.strictEqual(normaliseIndian('+91 98765-43210'), '+919876543210');
  assert.strictEqual(normaliseIndian('(098) 7654 3210'), '+919876543210');
});

test('international numbers keep their own country code', () => {
  assert.strictEqual(normaliseIndian('+14155552671'), '+14155552671');
});

test('00 international prefix becomes +', () => {
  assert.strictEqual(normaliseIndian('0014155552671'), '+14155552671');
});

test('short codes are preserved verbatim, not forced to +91', () => {
  assert.strictEqual(normaliseIndian('121'), '121');
  assert.strictEqual(normaliseIndian('1800180'), '1800180');
});

test('unusable input returns null', () => {
  assert.strictEqual(normaliseIndian(''), null);
  assert.strictEqual(normaliseIndian(null), null);
  assert.strictEqual(normaliseIndian('abc'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/phone.test.js`
Expected: FAIL - `Cannot find module '../src/shared/phone'`

- [ ] **Step 3: Write `src/shared/phone.js`**

```js
'use strict';

// India-first E.164 normalisation. The handset reports caller id in mixed
// formats and the call log joins to contacts on this value, so both sides
// must normalise identically or caller-id lookup silently misses.
const NSN_LENGTH = 10;   // Indian national significant number
const IN_CC = '91';

// Stored in place of a number for a withheld / no-caller-id call. It is a
// sentinel, not a number: anything grouping calls by number must exclude it,
// or unrelated anonymous callers appear as one frequent contact.
const UNKNOWN_NUMBER = 'unknown';

function normaliseIndian(input) {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (hadPlus) return `+${digits}`;

  // 00 is the international access prefix in India.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return digits ? `+${digits}` : null;
  }

  // National trunk prefix.
  if (digits.length === NSN_LENGTH + 1 && digits.startsWith('0')) {
    return `+${IN_CC}${digits.slice(1)}`;
  }

  if (digits.length === NSN_LENGTH) return `+${IN_CC}${digits}`;

  if (digits.length === NSN_LENGTH + IN_CC.length && digits.startsWith(IN_CC)) {
    return `+${digits}`;
  }

  // Anything shorter is a short code or service number: leave it alone rather
  // than inventing a country code for something that is not a phone number.
  if (digits.length < NSN_LENGTH) return digits;

  return `+${digits}`;
}

module.exports = { normaliseIndian, UNKNOWN_NUMBER };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/phone.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing vCard test**

Create `test/vcard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { parseVCards } = require('../src/shared/vcard');

test('parses a minimal vCard 2.1 entry', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'N:Sharma;Amit;;;', 'FN:Amit Sharma',
    'TEL;CELL:+91 98765 43210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'Amit Sharma');
  assert.deepStrictEqual(c.numbers, ['+919876543210']);
});

test('builds a name from N when FN is absent', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'N:Nair;Priya;;;',
    'TEL;CELL:9812345678', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'Priya Nair');
});

test('decodes quoted-printable UTF-8 names', () => {
  // Devanagari "amit" encoded as quoted-printable UTF-8, as KaiOS emits it.
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A4=85=E0=A4=AE=E0=A4=BF=E0=A4=A4',
    'TEL;CELL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'अमित');
});

test('joins quoted-printable soft line breaks', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1',
    'FN;ENCODING=QUOTED-PRINTABLE:Amit =',
    'Sharma',
    'TEL;CELL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'Amit Sharma');
});

test('unfolds continuation lines starting with whitespace', () => {
  // RFC 6350 folding is CRLF + one WSP, and unfolding removes both. So the
  // fixture needs TWO spaces: the first is the fold marker that gets eaten,
  // the second is real content. One space would correctly yield 'AmitSharma'.
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Amit', '  Sharma',
    'TEL;CELL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'Amit Sharma');
});

test('collects multiple numbers and dedupes them', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Priya',
    'TEL;CELL:9812345678', 'TEL;HOME:098 1234 5678', 'TEL;WORK:9800000000',
    'END:VCARD',
  ].join('\r\n'));
  assert.deepStrictEqual(c.numbers, ['+919812345678', '+919800000000']);
});

test('parses several vCards from one payload', () => {
  const one = ['BEGIN:VCARD', 'VERSION:2.1', 'FN:A', 'TEL:9876543210', 'END:VCARD'];
  const two = ['BEGIN:VCARD', 'VERSION:2.1', 'FN:B', 'TEL:9812345678', 'END:VCARD'];
  assert.strictEqual(parseVCards([...one, ...two].join('\r\n')).length, 2);
});

test('skips entries with no usable number rather than throwing', () => {
  const cards = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:No Number', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Good', 'TEL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].name, 'Good');
});

test('malformed input yields an empty array, never an exception', () => {
  assert.deepStrictEqual(parseVCards('not a vcard at all'), []);
  assert.deepStrictEqual(parseVCards(''), []);
  assert.deepStrictEqual(parseVCards('BEGIN:VCARD\r\nFN:Truncated'), []);
});

test('PHOTO payloads are ignored without corrupting the entry', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Amit',
    'PHOTO;ENCODING=BASE64;TYPE=JPEG:/9j/4AAQSkZJRgABAQ',
    '  AAAQABAAD', '', 'TEL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'Amit');
  assert.deepStrictEqual(c.numbers, ['+919876543210']);
});

test('uses UID when present, otherwise derives a stable one', () => {
  const [withUid] = parseVCards(
    ['BEGIN:VCARD', 'VERSION:2.1', 'UID:abc-123', 'FN:A', 'TEL:9876543210', 'END:VCARD'].join('\r\n'));
  assert.strictEqual(withUid.uid, 'abc-123');
  const mk = () => parseVCards(
    ['BEGIN:VCARD', 'VERSION:2.1', 'FN:A', 'TEL:9876543210', 'END:VCARD'].join('\r\n'))[0];
  assert.strictEqual(mk().uid, mk().uid);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/vcard.test.js`
Expected: FAIL - `Cannot find module '../src/shared/vcard'`

- [ ] **Step 7: Write `src/shared/vcard.js`**

```js
'use strict';
const crypto = require('node:crypto');
const { normaliseIndian } = require('./phone');

// vCard 2.1 as emitted by KaiOS over OBEX Object Push. Deliberately narrow:
// we need name, numbers and uid. Everything else is skipped, and any entry
// that fails to parse is dropped rather than aborting the whole import.

function decodeQuotedPrintable(value, charset) {
  const bytes = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '=' && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(value.charCodeAt(i) & 0xff);
  }
  return bytesToString(bytes, charset);
}

// KaiOS and many other emitters send UTF-8 quoted-printable WITHOUT declaring
// CHARSET. Defaulting to latin1 mojibakes exactly the non-Latin names QP
// exists to carry, so when no charset is declared, prefer UTF-8 and fall back
// to latin1 only when the bytes cannot be valid UTF-8.
function bytesToString(bytes, charset) {
  const buf = Buffer.from(bytes);
  if (charset) {
    return /utf-?8/i.test(charset) ? buf.toString('utf8') : buf.toString('latin1');
  }
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

// Joins folded lines. Two mechanisms coexist in the wild: RFC folding
// (continuation starts with space or tab) and quoted-printable soft breaks
// (line ends with '='). Both must be handled before parsing properties.
// A line that begins a new property, e.g. `TEL;CELL:...` or `FN:...`.
const PROPERTY_RE = /^[A-Za-z0-9.-]+(;[^:]*)?:/;

function unfold(text) {
  const raw = text.split(/\r\n|\r|\n/);
  const out = [];
  for (const line of raw) {
    const prev = out.length ? out[out.length - 1] : null;

    // A trailing '=' is a soft line break ONLY inside a quoted-printable
    // value. Treating it as one unconditionally also fires on base64 '='
    // padding and on transfers truncated mid-value, and in both cases it
    // swallows the following property line. When that line is the TEL, the
    // card ends up with no numbers and buildCard drops the contact entirely -
    // silent data loss, not a visible error.
    const qpSoftBreak = prev !== null
      && prev.endsWith('=')
      && /ENCODING=QUOTED-PRINTABLE/i.test(prev)
      && !PROPERTY_RE.test(line);

    if (qpSoftBreak) {
      // Drop the '='. If the emitter ALSO RFC-folded, one leading whitespace
      // is a fold marker and belongs to the folding, not to the value.
      out[out.length - 1] = prev.slice(0, -1) + line.replace(/^[ \t]/, '');
    } else if (prev !== null && /^[ \t]/.test(line)) {
      out[out.length - 1] = prev + line.replace(/^[ \t]/, '');
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...params] = head.split(';');
  const paramStr = params.join(';');
  const charset = (paramStr.match(/CHARSET=([^;]+)/i) || [])[1];
  const isQP = /ENCODING=QUOTED-PRINTABLE/i.test(paramStr);
  return {
    name: name.toUpperCase(),
    params: paramStr,
    value: isQP ? decodeQuotedPrintable(value, charset) : value,
  };
}

function nameFromN(value) {
  // N is Last;First;Middle;Prefix;Suffix
  const [last = '', first = '', middle = ''] = value.split(';');
  return [first, middle, last].filter(Boolean).join(' ').trim();
}

function buildCard(lines) {
  let fn = '';
  let n = '';
  let uid = '';
  const numbers = [];
  const raw = [];

  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'FN') fn = p.value.trim();
    else if (p.name === 'N') n = p.value;
    else if (p.name === 'UID') uid = p.value.trim();
    else if (p.name === 'TEL') {
      raw.push(p.value.trim());
      const e164 = normaliseIndian(p.value);
      if (e164 && !numbers.includes(e164)) numbers.push(e164);
    }
  }

  if (!numbers.length) return null;
  const name = fn || nameFromN(n) || numbers[0];
  if (!uid) {
    uid = crypto.createHash('sha1')
      .update(`${name} ${numbers.join(',')}`)
      .digest('hex')
      .slice(0, 16);
  }
  return { uid, name, numbers, raw };
}

function parseVCards(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = unfold(text);
  const cards = [];
  let current = null;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') { current = []; continue; }
    if (upper === 'END:VCARD') {
      if (current) {
        try {
          const card = buildCard(current);
          if (card) cards.push(card);
        } catch { /* skip this entry, keep the import going */ }
      }
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return cards;
}

module.exports = { parseVCards };
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `node --test test/vcard.test.js test/phone.test.js`
Expected: PASS, 20 tests total.

- [ ] **Step 9: Commit**

```bash
git add src/shared test/vcard.test.js test/phone.test.js
git commit -m "feat: vCard 2.1 parser and E.164 normalisation"
```

---

### Task 4: Linux D-Bus foundation and BlueZ device status

First task that touches hardware. Pure helpers are unit tested; the D-Bus paths get a manual verification script, because mocking BlueZ, oFono and PipeWire together costs more than it catches (spec section 10).

**Files:**
- Create: `src/main/backend/linux/bus.js`
- Create: `src/main/backend/linux/device.js`
- Create: `src/main/backend/linux/index.js`
- Create: `scripts/verify-device.js`
- Test: `test/linux-helpers.test.js`

**Interfaces:**
- Consumes: `createEmitter` from `../interface`
- Produces:
  - `modemPathFor(mac) -> string` e.g. `44:CD:0E:AD:5E:34` -> `/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34`
  - `devicePathFor(mac) -> string` -> `/org/bluez/hci0/dev_44_CD_0E_AD_5E_34`
  - `unwrap(dict) -> object` (strips dbus-next `Variant` wrappers one level deep)
  - `systemBus() -> Bus`, `sessionBus() -> Bus` (memoised singletons)
  - `createDeviceMonitor({mac}) -> {getStatus, onChange, listDevices, connect, disconnect, dispose}` where `getStatus()` resolves `{connected, model, battery}`

- [ ] **Step 1: Write the failing helper test**

Create `test/linux-helpers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { modemPathFor, devicePathFor, unwrap } = require('../src/main/backend/linux/bus');

test('modemPathFor builds the oFono HFP modem path', () => {
  assert.strictEqual(
    modemPathFor('44:CD:0E:AD:5E:34'),
    '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});

test('modemPathFor accepts lowercase and normalises to uppercase', () => {
  assert.strictEqual(
    modemPathFor('44:cd:0e:ad:5e:34'),
    '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});

test('devicePathFor builds the BlueZ device path', () => {
  assert.strictEqual(
    devicePathFor('44:CD:0E:AD:5E:34'),
    '/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});

test('malformed MAC throws rather than producing a silently wrong path', () => {
  assert.throws(() => modemPathFor('nonsense'), /invalid MAC/i);
  assert.throws(() => modemPathFor(''), /invalid MAC/i);
});

test('unwrap strips Variant wrappers', () => {
  const dict = { Online: { value: true }, Name: { value: 'F120B' }, Strength: { value: 100 } };
  assert.deepStrictEqual(unwrap(dict), { Online: true, Name: 'F120B', Strength: 100 });
});

test('unwrap passes through plain values untouched', () => {
  assert.deepStrictEqual(unwrap({ a: 1, b: 'x' }), { a: 1, b: 'x' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/linux-helpers.test.js`
Expected: FAIL - `Cannot find module '.../linux/bus'`

- [ ] **Step 3: Write `src/main/backend/linux/bus.js`**

```js
'use strict';
const dbus = require('dbus-next');

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function macToPathSegment(mac) {
  if (typeof mac !== 'string' || !MAC_RE.test(mac)) {
    throw new Error(`invalid MAC address: ${mac}`);
  }
  return mac.toUpperCase().replace(/:/g, '_');
}

// oFono exposes HFP modems under /hfp/<bluez device path>.
function modemPathFor(mac) {
  return `/hfp/org/bluez/hci0/dev_${macToPathSegment(mac)}`;
}

function devicePathFor(mac) {
  return `/org/bluez/hci0/dev_${macToPathSegment(mac)}`;
}

// dbus-next returns a{sv} as { key: Variant }. One level is all we need.
function unwrap(dict) {
  const out = {};
  for (const [key, value] of Object.entries(dict || {})) {
    out[key] = value && typeof value === 'object' && 'value' in value ? value.value : value;
  }
  return out;
}

let _system = null;
let _session = null;
function systemBus() { if (!_system) _system = dbus.systemBus(); return _system; }
function sessionBus() { if (!_session) _session = dbus.sessionBus(); return _session; }

async function getInterface(bus, service, path, iface) {
  const obj = await bus.getProxyObject(service, path);
  return obj.getInterface(iface);
}

// dbus-next raises a DBusError whose `type` is the D-Bus error name. An
// absent interface or property is expected in this project; a bus-level
// failure is not. Kept pure and exported so it can be unit tested.
// BlueZ answers GetAll for an interface an object does not carry with
// InvalidArgs, NOT UnknownInterface. Verified against the handset:
//   type    "org.freedesktop.DBus.Error.InvalidArgs"
//   message "No such interface 'org.bluez.Battery1'"
// InvalidArgs ALSO covers genuinely malformed calls, so match on the MESSAGE
// rather than trusting the type: blanket-trusting InvalidArgs would silence
// real programming errors, and rejecting it outright reports a false bus
// fault on every poll, because Battery1 is legitimately absent here.
const ABSENT_TYPE_RE = /UnknownInterface|UnknownObject|UnknownProperty|DoesNotExist/i;
const ABSENT_MESSAGE_RE = /No such (interface|property|object)/i;

function describeDBusError(err) {
  if (!err) return 'unknown error';
  // message BEFORE name: a plain Error's name is the useless string "Error",
  // and a bus-unreachable failure - the very case this exists to diagnose -
  // arrives as a plain Error rather than a dbus-next DBusError with a type.
  return String(err.type || err.message || err.name || err);
}

function isAbsentError(err) {
  if (!err) return false;
  if (ABSENT_TYPE_RE.test(String(err.type || ''))) return true;
  return ABSENT_MESSAGE_RE.test(String(err.message || ''));
}

module.exports = {
  modemPathFor, devicePathFor, unwrap, systemBus, sessionBus, getInterface,
  isAbsentError, describeDBusError,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/linux-helpers.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write `src/main/backend/linux/device.js`**

```js
'use strict';
const {
  systemBus, devicePathFor, unwrap, getInterface, isAbsentError, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const BLUEZ = 'org.bluez';
const PROPS = 'org.freedesktop.DBus.Properties';

// BlueZ owns connection state and the model name.
//
// Battery is NOT reliably here. BlueZ populates org.bluez.Battery1 from the
// HFP battery indicator it receives as the HFP handler - but in this project
// oFono owns the HFP connection, so BlueZ never sees the indicator and drops
// the interface entirely. Verified on the target handset: Battery1 is absent
// while oFono reports BatteryChargeLevel. This read stays as an opportunistic
// fallback; the real source is oFono's Handsfree interface (Task 5).
// getInterfaceFn/systemBusFn are injection seams with real defaults. They
// exist so connect(mac)'s path selection can be regression-tested without
// opening the system bus - a test that called the real one would genuinely
// dial whichever handset it targeted.
function createDeviceMonitor({
  mac, getInterfaceFn = getInterface, systemBusFn = systemBus,
} = {}) {
  const emitter = createEmitter();
  const path = devicePathFor(mac);
  let propsIface = null;
  let ensuring = null;
  let onChanged = null;

  function ensure() {
    if (propsIface) return Promise.resolve(propsIface);
    // Memoise the in-flight PROMISE, not just its result. getStatus() is fired
    // on every PropertiesChanged and BlueZ emits several in a burst during a
    // connect, so concurrent callers would each build their own proxy and
    // register their own listener - of which only the last is tracked, leaving
    // the rest attached forever. Measured: 5 concurrent calls leak 4 listeners
    // without this, 0 with it.
    if (ensuring) return ensuring;
    const p = (async () => {
      const bus = systemBusFn();
      const iface = await getInterfaceFn(bus, BLUEZ, path, PROPS);
      onChanged = (name, changed) => {
        if (name !== 'org.bluez.Device1' && name !== 'org.bluez.Battery1') return;
        emitter.emit(unwrap(changed));
      };
      iface.on('PropertiesChanged', onChanged);
      propsIface = iface;
      return iface;
    })();
    ensuring = p;
    // Clear on failure so a later call retries instead of reusing a dead promise.
    p.catch(() => { if (ensuring === p) ensuring = null; });
    return p;
  }

  // Returns {props, error}. An absent interface is normal here - BlueZ drops
  // org.bluez.Battery1 entirely because oFono owns HFP - so that stays quiet.
  // Anything else (bus unreachable, bluetoothd restarting) is a real fault and
  // must NOT masquerade as "the handset is disconnected".
  async function readAll(ifaceName) {
    try {
      const proxy = await ensure();
      return { props: unwrap(await proxy.GetAll(ifaceName)), error: null };
    } catch (err) {
      return isAbsentError(err)
        ? { props: {}, error: null }
        : { props: {}, error: describeDBusError(err) };
    }
  }

  return {
    async getStatus() {
      const dev = await readAll('org.bluez.Device1');
      const bat = await readAll('org.bluez.Battery1');
      const error = dev.error || bat.error || null;
      if (error) console.error('[konnect] BlueZ read failed:', error);
      return {
        connected: Boolean(dev.props.Connected),
        model: dev.props.Alias || dev.props.Name || null,
        battery: typeof bat.props.Percentage === 'number' ? bat.props.Percentage : null,
        error,
      };
    },

    async listDevices() {
      const bus = systemBusFn();
      const om = await getInterfaceFn(bus, BLUEZ, '/', 'org.freedesktop.DBus.ObjectManager');
      const objects = await om.GetManagedObjects();
      const out = [];
      for (const [objPath, ifaces] of Object.entries(objects)) {
        const d = ifaces['org.bluez.Device1'];
        if (!d) continue;
        const p = unwrap(d);
        out.push({
          mac: p.Address, name: p.Alias || p.Name || p.Address,
          paired: Boolean(p.Paired), connected: Boolean(p.Connected),
        });
      }
      return out;
    },

    // Honours an explicit MAC so a device chosen from listDevices() can be
    // connected, not just the configured default. Silently ignoring the
    // argument would connect to the wrong handset.
    async connect(targetMac) {
      const bus = systemBusFn();
      const target = targetMac ? devicePathFor(targetMac) : path;
      const dev = await getInterfaceFn(bus, BLUEZ, target, 'org.bluez.Device1');
      await dev.Connect();
    },

    async disconnect() {
      const bus = systemBusFn();
      const dev = await getInterfaceFn(bus, BLUEZ, path, 'org.bluez.Device1');
      await dev.Disconnect();
    },

    onChange(cb) { return emitter.on(cb); },

    dispose() {
      if (propsIface && onChanged) propsIface.off('PropertiesChanged', onChanged);
      propsIface = null;
      // Clear the memo too, or a later ensure() hands back the stale promise
      // whose listener was just detached - reads would work while change
      // notifications stayed permanently dead.
      ensuring = null;
      onChanged = null;
    },
  };
}

module.exports = { createDeviceMonitor };
```

- [ ] **Step 6: Write `src/main/backend/linux/index.js` (device only for now)**

```js
'use strict';
const { createDeviceMonitor } = require('./device');
const { createEmitter } = require('../interface');

const DEFAULT_MAC = '44:CD:0E:AD:5E:34';

// Telephony, recording and OPP are added in tasks 5, 10 and 11. Methods not
// yet implemented throw explicitly rather than returning undefined, so a
// half-wired backend fails loudly during development.
function notYet(name) {
  return async () => { throw new Error(`${name} not implemented yet`); };
}

function createLinuxBackend({ mac = DEFAULT_MAC } = {}) {
  const device = createDeviceMonitor({ mac });
  const statusEmitter = createEmitter();

  device.onChange(async () => {
    statusEmitter.emit(await api.getStatus());
  });

  const api = {
    listDevices: () => device.listDevices(),
    connect: (m) => device.connect(m),
    disconnect: () => device.disconnect(),

    async getStatus() {
      const d = await device.getStatus();
      return {
        connected: d.connected, model: d.model, battery: d.battery,
        signal: null, operator: null, roaming: false, error: d.error ?? null,
      };
    },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },

    dial: notYet('dial'),
    answer: notYet('answer'),
    hangup: notYet('hangup'),
    sendDtmf: notYet('sendDtmf'),
    onCall() { return () => {}; },

    startContactImport: notYet('startContactImport'),
    cancelContactImport: notYet('cancelContactImport'),
    onContacts() { return () => {}; },

    startRecording: notYet('startRecording'),
    stopRecording: notYet('stopRecording'),

    dispose() { device.dispose(); },
  };

  return api;
}

module.exports = { createLinuxBackend };
```

- [ ] **Step 7: Write `scripts/verify-device.js`**

```js
// Manual hardware check. Run with the handset paired and connected:
//   node scripts/verify-device.js
const { createLinuxBackend } = require('../src/main/backend/linux');

(async () => {
  const backend = createLinuxBackend();
  console.log('devices:', await backend.listDevices());
  console.log('status :', await backend.getStatus());
  backend.onDeviceStatus((s) => console.log('change :', s));
  console.log('watching for 20s - toggle bluetooth on the handset to see events');
  setTimeout(() => { backend.dispose(); process.exit(0); }, 20000);
})();
```

- [ ] **Step 8: Verify against the handset**

Run: `node scripts/verify-device.js`
Expected: the device list includes `F120B`, and status shows `connected: true`
and `model: 'F120B'`.

**`battery` is expected to be `null` here, and that is correct.** BlueZ exposes
`org.bluez.Battery1` only when it is itself the HFP handler; oFono owns that
connection in this project, so the interface is absent. Battery arrives from
oFono in Task 5. Do not chase this.

- [ ] **Step 9: Commit**

```bash
git add src/main/backend/linux scripts/verify-device.js test/linux-helpers.test.js
git commit -m "feat: linux d-bus foundation and bluez device status"
```

---

### Task 5: oFono telephony - status, call events, dial, answer, hangup

The core of the product. Everything here was verified live during the phase 0 spike; the state names and property shapes below are what the handset actually emitted.

**Files:**
- Create: `src/main/backend/linux/telephony.js`
- Modify: `src/main/backend/linux/index.js` (replace the `notYet` telephony stubs)
- Create: `scripts/verify-telephony.js`
- Test: `test/telephony-helpers.test.js`

**Interfaces:**
- Consumes: `modemPathFor`, `unwrap`, `systemBus`, `getInterface` from `./bus`
- Produces:
  - `toCall(path, props) -> Call` (pure; maps oFono properties to the `Call` shape from Task 1)
  - `signalPercent(strength) -> number|null` (pure)
  - `createTelephony({mac}) -> {ensureOnline, getNetwork, getBattery, dial, answer, hangup, sendDtmf, onCall, dispose}`
  - `getNetwork() -> {operator, signal, roaming, error}` and
    `getBattery() -> {battery, error}`. Battery comes from HFP's 0-5 `battchg`
    indicator (level x 20) - the only working source in this configuration,
    see the note in `device.js`. Neither swallows failures: oFono drops its
    interfaces when the modem powers down, and that must surface as
    `handset modem offline` rather than as "connected, no service".

- [ ] **Step 1: Write the failing helper test**

Create `test/telephony-helpers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { toCall, signalPercent } = require('../src/main/backend/linux/telephony');

const PATH = '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34/voicecall01';

test('maps an outgoing dialing call', () => {
  const c = toCall(PATH, { State: 'dialing', LineIdentification: '+919876543210', Name: '' });
  assert.strictEqual(c.id, PATH);
  assert.strictEqual(c.direction, 'out');
  assert.strictEqual(c.state, 'dialing');
  assert.strictEqual(c.number, '+919876543210');
  assert.strictEqual(c.name, null);
  assert.strictEqual(c.startedAt, null);
});

test('maps an incoming call as inbound', () => {
  const c = toCall(PATH, { State: 'incoming', LineIdentification: '+919804464251' });
  assert.strictEqual(c.direction, 'in');
  assert.strictEqual(c.state, 'incoming');
});

test('alerting is outbound, waiting is inbound', () => {
  assert.strictEqual(toCall(PATH, { State: 'alerting' }).direction, 'out');
  assert.strictEqual(toCall(PATH, { State: 'waiting' }).direction, 'in');
});

test('StartTime is carried through only when present', () => {
  const active = toCall(PATH, { State: 'active', StartTime: '2026-09-01T12:04:29+0530' });
  assert.strictEqual(active.startedAt, '2026-09-01T12:04:29+0530');
  assert.strictEqual(toCall(PATH, { State: 'active' }).startedAt, null);
});

test('an empty Name becomes null rather than an empty string', () => {
  assert.strictEqual(toCall(PATH, { State: 'active', Name: '' }).name, null);
  assert.strictEqual(toCall(PATH, { State: 'active', Name: 'Amit' }).name, 'Amit');
});

test('signalPercent clamps and rejects nonsense', () => {
  assert.strictEqual(signalPercent(100), 100);
  assert.strictEqual(signalPercent(0), 0);
  assert.strictEqual(signalPercent(150), 100);
  assert.strictEqual(signalPercent(-5), 0);
  assert.strictEqual(signalPercent(undefined), null);
  assert.strictEqual(signalPercent('loud'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/telephony-helpers.test.js`
Expected: FAIL - `Cannot find module '.../linux/telephony'`

- [ ] **Step 3: Write `src/main/backend/linux/telephony.js`**

```js
'use strict';
const {
  systemBus, modemPathFor, unwrap, getInterface, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const OFONO = 'org.ofono';

// oFono REMOVES its interfaces when the modem powers down, so a missing
// interface here does NOT mean "this feature is unavailable" the way BlueZ's
// absent Battery1 does - it means the handset link is down and the remedy is
// to reconnect. Reporting no operator and no signal with error: null would be
// indistinguishable from a phone that is connected but has no service.
// Verified against the live modem: dbus-next raises a plain Error (no .type)
// whose message is "interface not found in proxy object: org.ofono.X".
const MODEM_OFFLINE_RE = /interface not found in proxy object/i;

function describeTelephonyError(err) {
  const desc = describeDBusError(err);
  return MODEM_OFFLINE_RE.test(desc) ? 'handset modem offline' : desc;
}

// oFono call states observed on the handset during the phase 0 spike:
//   outgoing: dialing -> alerting -> active -> disconnected
//   incoming: incoming -> active -> disconnected
// StartTime appears only on the transition to active, which is why call
// duration must be measured from it and never from dial time.
const INBOUND_STATES = new Set(['incoming', 'waiting']);

function toCall(path, rawProps) {
  const p = rawProps || {};
  const state = p.State || 'disconnected';
  return {
    id: path,
    direction: INBOUND_STATES.has(state) ? 'in' : 'out',
    state,
    number: p.LineIdentification || null,
    name: p.Name ? p.Name : null,
    startedAt: p.StartTime || null,
  };
}

function signalPercent(strength) {
  if (typeof strength !== 'number' || Number.isNaN(strength)) return null;
  return Math.max(0, Math.min(100, strength));
}

function createTelephony({ mac }) {
  const emitter = createEmitter();
  const modemPath = modemPathFor(mac);
  const watched = new Map();   // call path -> { iface, handler }
  let managerIface = null;
  let starting = null;
  let handlers = null;

  async function iface(path, name) {
    return getInterface(systemBus(), OFONO, path, name);
  }

  // Powering the modem establishes the HFP connection. Never power it OFF to
  // work around an unrelated problem - it drops the whole ACL link and SDP
  // lookups then fail with "Unable to find service record" (spec section 2.2).
  async function ensureOnline() {
    const modem = await iface(modemPath, 'org.ofono.Modem');
    const props = unwrap(await modem.GetProperties());
    if (!props.Powered) {
      await modem.SetProperty('Powered', new (require('dbus-next').Variant)('b', true));
    }
    return true;
  }

  async function watchCall(path, initialProps) {
    if (watched.has(path)) return;
    const call = await iface(path, 'org.ofono.VoiceCall');
    const handler = (name, variant) => {
      const merged = { ...(watched.get(path)?.props || {}), [name]: variant.value };
      watched.set(path, { ...watched.get(path), props: merged });
      emitter.emit(toCall(path, merged));
    };
    call.on('PropertyChanged', handler);
    watched.set(path, { iface: call, handler, props: initialProps });
    emitter.emit(toCall(path, initialProps));
  }

  function unwatchCall(path) {
    const entry = watched.get(path);
    if (!entry) return;
    entry.iface.off('PropertyChanged', entry.handler);
    watched.delete(path);
    // Only synthesize a terminal event if oFono did not already deliver one.
    // It normally sets State to 'disconnected' via PropertyChanged BEFORE
    // removing the call, so emitting again here hands every consumer two
    // identical terminal events for an ordinary hangup. The synthesis exists
    // for the case where a call vanishes with no terminal transition at all.
    // Correct under either ordering: exactly one terminal event each way.
    if (entry.props && entry.props.State !== 'disconnected') {
      emitter.emit({ ...toCall(path, entry.props), state: 'disconnected' });
    }
  }

  // Memoises the in-flight promise, not just its result - the same fix
  // device.js needed. onCall() calls start() lazily and dial() awaits it, so
  // two callers can overlap before the first proxy resolves; each would then
  // register its own CallAdded/CallRemoved listeners while only the last is
  // tracked, leaving the rest attached past dispose(). Measured: 3 concurrent
  // callers leak 4 listeners without this, 0 with it.
  function start() {
    if (managerIface) return Promise.resolve(managerIface);
    if (starting) return starting;
    const p = (async () => {
      const mgr = await iface(modemPath, 'org.ofono.VoiceCallManager');
      handlers = {
        added: (path, props) => { watchCall(path, unwrap(props)).catch(() => {}); },
        removed: (path) => unwatchCall(path),
      };
      mgr.on('CallAdded', handlers.added);
      mgr.on('CallRemoved', handlers.removed);
      managerIface = mgr;

      // Adopt any call already in progress when we attach.
      for (const [path, props] of await mgr.GetCalls()) {
        await watchCall(path, unwrap(props));
      }
      return mgr;
    })();
    starting = p;
    p.catch(() => { if (starting === p) starting = null; });
    return p;
  }

  return {
    ensureOnline,

    // Battery comes from HFP's 0-5 `battchg` indicator, surfaced by oFono.
    // BlueZ's Battery1 is absent in this configuration (see device.js), so
    // this is the real source. Scale is 20% per level: level 4 reads as 80%,
    // which matches what BlueZ reported before oFono took over HFP.
    async getBattery() {
      try {
        const hf = await iface(modemPath, 'org.ofono.Handsfree');
        const p = unwrap(await hf.GetProperties());
        const level = p.BatteryChargeLevel;
        return {
          battery: typeof level === 'number' ? Math.max(0, Math.min(100, level * 20)) : null,
          error: null,
        };
      } catch (err) {
        return { battery: null, error: describeTelephonyError(err) };
      }
    },

    async getNetwork() {
      try {
        const net = await iface(modemPath, 'org.ofono.NetworkRegistration');
        const p = unwrap(await net.GetProperties());
        return {
          operator: p.Name || null,
          signal: signalPercent(p.Strength),
          roaming: p.Status === 'roaming',
          error: null,
        };
      } catch (err) {
        return {
          operator: null, signal: null, roaming: false,
          error: describeTelephonyError(err),
        };
      }
    },

    async dial(number) {
      await ensureOnline();
      // start() returns the manager proxy, so there is no second round-trip.
      const mgr = await start();
      const path = await mgr.Dial(number, 'default');
      return path;
    },

    async answer(callId) {
      const call = await iface(callId, 'org.ofono.VoiceCall');
      await call.Answer();
    },

    async hangup(callId) {
      const call = await iface(callId, 'org.ofono.VoiceCall');
      await call.Hangup();
    },

    async sendDtmf(digits) {
      const mgr = await iface(modemPath, 'org.ofono.VoiceCallManager');
      await mgr.SendTones(String(digits));
    },

    onCall(cb) { start().catch(() => {}); return emitter.on(cb); },

    dispose() {
      for (const path of [...watched.keys()]) {
        const entry = watched.get(path);
        entry.iface.off('PropertyChanged', entry.handler);
        watched.delete(path);
      }
      if (managerIface && handlers) {
        managerIface.off('CallAdded', handlers.added);
        managerIface.off('CallRemoved', handlers.removed);
      }
      managerIface = null;
      // Clear the memo too, or a later start() returns the stale promise whose
      // listeners were just detached.
      starting = null;
      handlers = null;
    },
  };
}

module.exports = { toCall, signalPercent, createTelephony };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/telephony-helpers.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire telephony into `src/main/backend/linux/index.js`**

Replace the telephony stubs. `getStatus` now merges BlueZ and oFono:

```js
'use strict';
const { createDeviceMonitor } = require('./device');
const { createTelephony } = require('./telephony');
const { createEmitter } = require('../interface');

const DEFAULT_MAC = '44:CD:0E:AD:5E:34';

function notYet(name) {
  return async () => { throw new Error(`${name} not implemented yet`); };
}

function createLinuxBackend({ mac = DEFAULT_MAC } = {}) {
  const device = createDeviceMonitor({ mac });
  const telephony = createTelephony({ mac });
  const statusEmitter = createEmitter();

  const api = {
    listDevices: () => device.listDevices(),
    connect: (m) => device.connect(m),
    disconnect: () => device.disconnect(),

    async getStatus() {
      const [d, n, b] = await Promise.all([
        device.getStatus(), telephony.getNetwork(), telephony.getBattery(),
      ]);
      return {
        connected: d.connected,
        model: d.model,
        // oFono first: BlueZ's Battery1 is absent while oFono owns HFP.
        battery: b.battery ?? d.battery,
        signal: n.signal, operator: n.operator, roaming: n.roaming,
        // A BlueZ fault outranks an oFono one: if the device link is down,
        // "handset modem offline" is a symptom, not the cause.
        error: d.error ?? n.error ?? b.error ?? null,
      };
    },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },

    dial: (number) => telephony.dial(number),
    answer: (id) => telephony.answer(id),
    hangup: (id) => telephony.hangup(id),
    sendDtmf: (d) => telephony.sendDtmf(d),
    onCall: (cb) => telephony.onCall(cb),

    startContactImport: notYet('startContactImport'),
    cancelContactImport: notYet('cancelContactImport'),
    onContacts() { return () => {}; },

    startRecording: notYet('startRecording'),
    stopRecording: notYet('stopRecording'),

    async ensureOnline() { return telephony.ensureOnline(); },
    dispose() {
      device.dispose();
      telephony.dispose();
      recorder.dispose();
      // Retire the OBEX agent explicitly. obexd's disconnect watch probably
      // frees it when our bus connection drops, but "not a standing drop
      // target" should be a property of this code, not of another daemon's
      // best-effort cleanup.
      opp.cancel().catch(() => {});
    },
  };

  device.onChange(async () => { statusEmitter.emit(await api.getStatus()); });
  return api;
}

module.exports = { createLinuxBackend };
```

- [ ] **Step 6: Write `scripts/verify-telephony.js`**

```js
// Manual hardware check. Watches call events; optionally dials.
//   node scripts/verify-telephony.js            # watch only
//   node scripts/verify-telephony.js +919876543210
const { createLinuxBackend } = require('../src/main/backend/linux');

(async () => {
  const backend = createLinuxBackend();
  await backend.ensureOnline();
  console.log('status:', await backend.getStatus());

  backend.onCall((c) => console.log(
    `call ${c.state.padEnd(12)} dir=${c.direction} num=${c.number} start=${c.startedAt}`));

  const number = process.argv[2];
  if (number) {
    const id = await backend.dial(number);
    console.log('dialed, call id:', id);
    setTimeout(() => backend.hangup(id).catch(() => {}), 25000);
  } else {
    console.log('watching 90s - call the handset to see incoming events');
  }
  setTimeout(() => { backend.dispose(); process.exit(0); }, 95000);
})();
```

- [ ] **Step 7: Verify against the handset**

Run: `node scripts/verify-telephony.js`
Expected: `status` shows `operator: 'JIO'`, a numeric `signal`, and a numeric
`battery` (a multiple of 20 - this is where battery starts working). Call the handset from another phone; expect a line with `state=incoming` carrying the caller's number.

Then run: `node scripts/verify-telephony.js <a number you may ring>`
Expected: `dialing` then `alerting` then `active` with a non-null `startedAt`, then `disconnected` after the automatic hangup.

- [ ] **Step 8: Commit**

```bash
git add src/main/backend/linux scripts/verify-telephony.js test/telephony-helpers.test.js
git commit -m "feat: ofono telephony - status, call events, dial, answer, hangup"
```

---

### Task 6: Setup wizard - environment detection and pkexec remediation

Spec section 4. Every failure mode here was hit during the phase 0 spike, and each one fails silently, so detection must be explicit.

**Files:**
- Create: `src/main/setup.js`
- Test: `test/setup.test.js`

**Interfaces:**
- Consumes: nothing (takes an injected `exec` so it is testable without a system)
- Produces:
  - `CHECKS: Array<{id, label, detect(exec), remedy}>`
  - `runChecks({exec}) -> Promise<Array<{id, label, ok, detail, remedy}>>`
  - `WIREPLUMBER_CONFIG_PATH: string`
  - `WIREPLUMBER_CONFIG_BODY: string`
  - `remediate(id, {exec, writeFile}) -> Promise<{ok: true, detail} | {ok: false, reason, detail, command}>`
    where `reason` is `'cancelled' | 'unavailable' | 'failed'`. It never
    rejects for a command failure - the caller needs `command` to offer the
    manual fallback spec 4.4 requires. An unknown id still throws.
  - `classifyFailure(err) -> 'cancelled' | 'unavailable' | 'failed'`

- [ ] **Step 1: Write the failing test**

Create `test/setup.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { runChecks, remediate, WIREPLUMBER_CONFIG_BODY } = require('../src/main/setup');

// exec stub: maps a substring of the command to { stdout, code }
function fakeExec(routes) {
  return async (cmd) => {
    for (const [needle, result] of Object.entries(routes)) {
      if (cmd.includes(needle)) {
        if (result.code && result.code !== 0) {
          const err = new Error('command failed');
          err.code = result.code;
          err.stdout = result.stdout || '';
          throw err;
        }
        return { stdout: result.stdout || '', stderr: '' };
      }
    }
    const err = new Error(`unstubbed command: ${cmd}`);
    err.code = 127;
    throw err;
  };
}

test('all checks pass on a fully configured system', async () => {
  const exec = fakeExec({
    'which ofonod': { stdout: '/usr/sbin/ofonod' },
    'is-active ofono': { stdout: 'active' },
    'hfphsp-backend': { stdout: 'bluez5.hfphsp-backend = "ofono"' },
    'org.ofono.Modem': { stdout: '"Powered" b true "Online" b true' },
  });
  const results = await runChecks({ exec });
  assert.ok(results.length >= 4);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results, null, 2));
});

test('missing ofono is reported with a remedy, not a crash', async () => {
  const exec = fakeExec({
    'which ofonod': { code: 1 },
    'is-active ofono': { stdout: 'inactive' },
    'hfphsp-backend': { code: 1 },
    'org.ofono.Modem': { code: 1 },
  });
  const results = await runChecks({ exec });
  const ofono = results.find((r) => r.id === 'ofono-installed');
  assert.strictEqual(ofono.ok, false);
  assert.match(ofono.remedy, /apt install/);
});

test('modem offline is detected separately from ofono being absent', async () => {
  const exec = fakeExec({
    'which ofonod': { stdout: '/usr/sbin/ofonod' },
    'is-active ofono': { stdout: 'active' },
    'hfphsp-backend': { stdout: 'bluez5.hfphsp-backend = "ofono"' },
    'org.ofono.Modem': { stdout: '"Powered" b false "Online" b false' },
  });
  const results = await runChecks({ exec });
  assert.strictEqual(results.find((r) => r.id === 'ofono-installed').ok, true);
  assert.strictEqual(results.find((r) => r.id === 'modem-online').ok, false);
});

test('wireplumber config body sets the ofono backend', () => {
  assert.match(WIREPLUMBER_CONFIG_BODY, /bluez5\.hfphsp-backend/);
  assert.match(WIREPLUMBER_CONFIG_BODY, /ofono/);
});

test('remediate writes the wireplumber config and restarts in the required order', async () => {
  const calls = [];
  const exec = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
  const written = [];
  const writeFile = async (p, body) => { written.push([p, body]); };

  const r = await remediate('wireplumber-backend', { exec, writeFile });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(written.length, 1);

  // Order matters: wireplumber releases the HFP UUID, ofono claims it, then
  // wireplumber reattaches to the ofono backend. See spec section 4.2.
  const order = calls.join(' | ');
  const wp1 = order.indexOf('wireplumber');
  const of1 = order.indexOf('ofono');
  const wp2 = order.lastIndexOf('wireplumber');
  assert.ok(wp1 < of1 && of1 < wp2, `wrong restart order: ${order}`);
});

test('remediate on an unknown id rejects rather than silently succeeding', async () => {
  await assert.rejects(
    () => remediate('nope', { exec: async () => ({ stdout: '' }), writeFile: async () => {} }),
    /unknown remediation/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/setup.test.js`
Expected: FAIL - `Cannot find module '../src/main/setup'`

- [ ] **Step 3: Write `src/main/setup.js`**

```js
'use strict';
const os = require('node:os');
const path = require('node:path');

const MODEM_PATH = '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34';

const WIREPLUMBER_CONFIG_PATH = path.join(
  os.homedir(), '.config', 'wireplumber', 'bluetooth.lua.d', '51-konnect-hfp.lua');

const WIREPLUMBER_CONFIG_BODY = `-- Konnect: hand HFP signalling to oFono so the app gets a telephony D-Bus
-- API (dial/answer/hangup/call state) while PipeWire consumes the SCO fd for
-- audio. Without this, PipeWire's native backend owns RFCOMM channel 3 and
-- outside connections get EBUSY.
bluez_monitor.properties["bluez5.hfphsp-backend"] = "ofono"
bluez_monitor.properties["bluez5.roles"] =
  "[ hfp_hf hsp_hs a2dp_sink a2dp_source ]"
`;

// What the "Copy" button in the wizard hands the user. These must be real,
// runnable shell - spec 4.4 asks for "the exact command", and prose in a copy
// buffer is a dead end wearing a fallback's clothes. The WirePlumber one is
// derived from the config constants above so it cannot drift out of sync, and
// it preserves the load-bearing restart order from spec 4.2.
const WIREPLUMBER_MANUAL_COMMAND = [
  `mkdir -p "$(dirname ${WIREPLUMBER_CONFIG_PATH})"`,
  `cat > ${WIREPLUMBER_CONFIG_PATH} <<'KONNECT_EOF'`,
  WIREPLUMBER_CONFIG_BODY.trimEnd(),
  'KONNECT_EOF',
  'systemctl --user restart wireplumber',
  // pkexec, not sudo: the automated remedy uses pkexec, so a system with a
  // polkit rule for it but no sudoers entry - exactly the locked-down setup
  // this recovery flow targets - would fail this step by hand while the
  // automated path's mechanism would have worked.
  'pkexec systemctl restart ofono',
  'systemctl --user restart wireplumber',
].join('\n');

const MODEM_MANUAL_COMMAND =
  `pkexec hciconfig hci0 class 0x240404 && \\\n  busctl --system call org.ofono ${MODEM_PATH} `
  + 'org.ofono.Modem SetProperty sv Powered b true';

async function ok(exec, cmd) {
  try {
    const { stdout } = await exec(cmd);
    return { ok: true, detail: (stdout || '').trim() };
  } catch (err) {
    return { ok: false, detail: (err && err.message) || 'command failed' };
  }
}

const CHECKS = [
  {
    id: 'ofono-installed',
    label: 'oFono is installed',
    remedy: 'pkexec apt install -y ofono',
    manualCommand: 'pkexec apt install -y ofono',
    async detect(exec) { return ok(exec, 'which ofonod'); },
  },
  {
    id: 'ofono-running',
    label: 'oFono service is running',
    remedy: 'pkexec systemctl enable --now ofono',
    manualCommand: 'pkexec systemctl enable --now ofono',
    async detect(exec) {
      const r = await ok(exec, 'systemctl is-active ofono');
      return { ok: r.ok && r.detail === 'active', detail: r.detail };
    },
  },
  {
    id: 'wireplumber-backend',
    label: 'PipeWire uses the oFono HFP backend',
    remedy: 'write ~/.config/wireplumber/bluetooth.lua.d/51-konnect-hfp.lua and restart',
    manualCommand: WIREPLUMBER_MANUAL_COMMAND,
    async detect(exec) {
      const r = await ok(exec, `grep -h hfphsp-backend ${WIREPLUMBER_CONFIG_PATH}`);
      return { ok: r.ok && r.detail.includes('ofono'), detail: r.detail };
    },
  },
  {
    id: 'modem-online',
    label: 'Handset HFP modem is online',
    remedy: 'connect the handset, then run the class bootstrap if it refuses',
    manualCommand: MODEM_MANUAL_COMMAND,
    async detect(exec) {
      const r = await ok(
        exec,
        `busctl --system call org.ofono ${MODEM_PATH} org.ofono.Modem GetProperties`);
      return { ok: r.ok && /"Online" b true/.test(r.detail), detail: r.detail };
    },
  },
];

async function runChecks({ exec }) {
  const out = [];
  for (const check of CHECKS) {
    const result = await check.detect(exec);
    out.push({ id: check.id, label: check.label, ok: result.ok, detail: result.detail, remedy: check.remedy });
  }
  return out;
}

const REMEDIES = {
  async 'ofono-installed'({ exec }) {
    await exec('pkexec apt install -y ofono');
    return { ok: true, detail: 'installed' };
  },
  async 'ofono-running'({ exec }) {
    await exec('pkexec systemctl enable --now ofono');
    return { ok: true, detail: 'started' };
  },
  async 'wireplumber-backend'({ exec, writeFile }) {
    await writeFile(WIREPLUMBER_CONFIG_PATH, WIREPLUMBER_CONFIG_BODY);
    // Order is load-bearing (spec 4.2): wireplumber must release the HFP UUID
    // before ofono can claim it, and must restart again afterwards to attach
    // to the ofono backend. Wrong order leaves a modem that never powers on.
    await exec('systemctl --user restart wireplumber');
    await exec('pkexec systemctl restart ofono');
    await exec('systemctl --user restart wireplumber');
    return { ok: true, detail: 'configured and restarted' };
  },
  async 'modem-online'({ exec }) {
    // One-time class bootstrap. The handset caches our hands-free role, so
    // bluetoothd reverting the class afterwards is harmless (spec 4.1).
    await exec('pkexec hciconfig hci0 class 0x240404');
    await exec(
      `busctl --system call org.ofono ${MODEM_PATH} org.ofono.Modem SetProperty sv Powered b true`);
    return { ok: true, detail: 'class bootstrapped and modem powered' };
  },
};

// pkexec's own exit codes (man pkexec): 126 when the user dismissed the
// authentication dialog, 127 when authorisation could not be obtained or
// pkexec itself is absent. Anything else is the wrapped command's own exit
// code. All three must surface the command so it can be run by hand - spec
// 4.4: setup must never be a dead end because a prompt was dismissed.
const ELEVATION_CANCELLED = 126;
const ELEVATION_UNAVAILABLE = 127;

function classifyFailure(err) {
  const code = err && typeof err.code === 'number' ? err.code : null;
  if (code === ELEVATION_CANCELLED) return 'cancelled';
  if (code === ELEVATION_UNAVAILABLE) return 'unavailable';
  return 'failed';
}

// Resolves {ok: true, detail} on success, or {ok: false, reason, detail,
// command} on failure - never rejects for a command failure, because the
// caller needs the command string to offer a manual fallback. An unknown id
// still throws: that is a programming error, not a user-recoverable state.
async function remediate(id, deps) {
  const fn = REMEDIES[id];
  if (!fn) throw new Error(`unknown remediation: ${id}`);
  const check = CHECKS.find((c) => c.id === id);
  try {
    return await fn(deps);
  } catch (err) {
    return {
      ok: false,
      reason: classifyFailure(err),
      detail: (err && err.message) || 'command failed',
      // manualCommand, not remedy: remedy is the human-readable description
      // shown in the checks list; only manualCommand is runnable.
      command: check ? check.manualCommand : null,
    };
  }
}

module.exports = {
  CHECKS, runChecks, remediate, classifyFailure,
  WIREPLUMBER_CONFIG_PATH, WIREPLUMBER_CONFIG_BODY,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/setup.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/setup.js test/setup.test.js
git commit -m "feat: setup wizard checks and pkexec remediation"
```

---

### Task 7: Electron shell, IPC bridge, tray and status view

First runnable app. Uses the mock backend when `KONNECT_MOCK=1`, so the UI can be built without the handset.

**Files:**
- Create: `src/main/index.js`
- Create: `src/main/preload.js`
- Create: `src/main/ipc.js`
- Create: `src/renderer/index.html`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/app.js`

**Interfaces:**
- Consumes: `createBackend` (Task 1), `openStore` (Task 2), `runChecks`/`remediate` (Task 6)
- Produces:
  - `window.konnect` in the renderer:
    - `getStatus() -> Promise<Status>`
    - `onStatus(cb) -> void`
    - `onCall(cb) -> void`
    - `dial(number)`, `answer(id)`, `hangup(id)`
    - `runSetupChecks() -> Promise<Array<Check>>`
    - `remediate(id) -> Promise<{ok, detail}>`
    - `listCalls(opts)`, `listContacts()`, `callStats(opts)`
    - `getSetting(k)`, `setSetting(k, v)`

- [ ] **Step 1: Write `src/main/ipc.js`**

```js
'use strict';
const { ipcMain } = require('electron');
const { runChecks, remediate } = require('./setup');
const { promisify } = require('node:util');
const { exec: execCb } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const execAsync = promisify(execCb);
const exec = (cmd) => execAsync(cmd, { timeout: 120000 });
const writeFile = async (p, body) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
};

// One place where every renderer-reachable capability is declared. Adding a
// channel anywhere else is a bug: the preload allowlist mirrors this list.
function registerIpc({ backend, store, broadcast }) {
  const handlers = {
    'status:get': () => backend.getStatus(),
    'call:dial': (_e, number) => backend.dial(number),
    'call:answer': (_e, id) => backend.answer(id),
    'call:hangup': (_e, id) => backend.hangup(id),
    'call:dtmf': (_e, digits) => backend.sendDtmf(digits),
    'setup:check': () => runChecks({ exec }),
    'setup:remediate': (_e, id) => remediate(id, { exec, writeFile }),
    'calls:list': (_e, opts) => store.listCalls(opts || {}),
    'calls:stats': (_e, opts) => store.callStats(opts || {}),
    'contacts:list': () => store.listContacts(),
    'contacts:import': () => backend.startContactImport(),
    'contacts:cancelImport': () => backend.cancelContactImport(),
    'settings:get': (_e, key) => store.getSetting(key),
    'settings:set': (_e, key, value) => store.setSetting(key, value),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }

  backend.onDeviceStatus((s) => broadcast('status:changed', s));
  backend.onCall((c) => broadcast('call:changed', c));
  backend.onContacts((list) => broadcast('contacts:changed', list));
}

module.exports = { registerIpc };
```

- [ ] **Step 2: Write `src/main/preload.js`**

```js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation is on and nodeIntegration off, so this allowlist is the
// entire renderer-facing API surface.
contextBridge.exposeInMainWorld('konnect', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  dial: (n) => ipcRenderer.invoke('call:dial', n),
  answer: (id) => ipcRenderer.invoke('call:answer', id),
  hangup: (id) => ipcRenderer.invoke('call:hangup', id),
  sendDtmf: (d) => ipcRenderer.invoke('call:dtmf', d),
  runSetupChecks: () => ipcRenderer.invoke('setup:check'),
  remediate: (id) => ipcRenderer.invoke('setup:remediate', id),
  listCalls: (o) => ipcRenderer.invoke('calls:list', o),
  callStats: (o) => ipcRenderer.invoke('calls:stats', o),
  listContacts: () => ipcRenderer.invoke('contacts:list'),
  importContacts: () => ipcRenderer.invoke('contacts:import'),
  cancelImport: () => ipcRenderer.invoke('contacts:cancelImport'),
  getSetting: (k) => ipcRenderer.invoke('settings:get', k),
  setSetting: (k, v) => ipcRenderer.invoke('settings:set', k, v),
  onStatus: (cb) => ipcRenderer.on('status:changed', (_e, s) => cb(s)),
  onCall: (cb) => ipcRenderer.on('call:changed', (_e, c) => cb(c)),
  onContacts: (cb) => ipcRenderer.on('contacts:changed', (_e, l) => cb(l)),
});
```

- [ ] **Step 3: Write `src/main/index.js`**

```js
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { createBackend } = require('./backend');
const { openStore } = require('./store');
const { registerIpc } = require('./ipc');

// Bootstrap default only; the live value is the `device_mac` setting.
const DEFAULT_DEVICE_MAC = '44:CD:0E:AD:5E:34';

let win = null;
let tray = null;
let incomingCallId = null;
let trayAvailable = false;
let backend = null;
let store = null;

// A real 16x16 icon. nativeImage.createEmpty() yields isEmpty() === true, so a
// tray built from it is blank even where the tray itself works.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNggAKvef//k4IZ0AHZBpCqEcOgwWkAOoCJkWUAMp9kA7AZRrQBuLxCdCBiA2QHIlkuGEIJacBzIwD4dtlp0zcP3QAAAABJRU5ErkJggg==';

// new Tray() does NOT throw when no StatusNotifier host is on the bus - it
// silently produces an invisible icon - so ask the bus directly rather than
// inferring availability from the constructor succeeding. Verified on the
// target machine: the appindicator extension is enabled but INACTIVE, and
// org.kde.StatusNotifierWatcher is absent.
async function detectTrayHost() {
  if (process.platform !== 'linux') return true;
  try {
    const { sessionBus } = require('./backend/linux/bus');
    await sessionBus().getProxyObject(
      'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher');
    return true;
  } catch {
    return false;
  }
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 720, show: false, title: 'Konnect',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Tray-resident: closing hides rather than quits, so incoming calls still
  // surface (spec section 9). But ONLY when a tray icon will actually be
  // visible - hiding with no tray strands the window with no way back.
  win.on('close', (e) => {
    if (!app.isQuitting && trayAvailable) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  const refresh = (status) => {
    const bits = ['Konnect'];
    if (status?.model) bits.push(status.model);
    if (typeof status?.battery === 'number') bits.push(`${status.battery}%`);
    if (status?.operator) bits.push(status.operator);
    tray.setToolTip(bits.join(' - '));
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Konnect', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  refresh(null);
  backend.onDeviceStatus(refresh);
  backend.getStatus().then(refresh).catch(() => {});
}

app.whenReady().then(async () => {
  trayAvailable = await detectTrayHost();
  if (!trayAvailable) {
    // Not fatal: incoming calls still surface via a desktop notification and
    // the call window (task 10). Only close-to-tray is given up.
    console.warn(
      '[konnect] No system tray host (org.kde.StatusNotifierWatcher). '
      + 'Closing the window will quit rather than hide to the tray.');
  }
  store = openStore(path.join(app.getPath('userData'), 'konnect.db'));
  // The handset address lives in settings (seeded once from the bootstrap
  // default) so the app is not hardwired to one device.
  if (!store.getSetting('device_mac')) store.setSetting('device_mac', DEFAULT_DEVICE_MAC);
  backend = createBackend({
    mock: process.env.KONNECT_MOCK === '1',
    mac: store.getSetting('device_mac'),
  });
  registerIpc({ backend, store, broadcast });

  // Mock-only: schedule a simulated incoming call so the incoming-call window
  // and notification can be verified without a real handset ringing. Ignored
  // entirely by the linux backend, which has no simulateIncoming.
  const mockIncomingDelay = Number(process.env.KONNECT_MOCK_INCOMING);
  if (typeof backend.simulateIncoming === 'function'
      && Number.isFinite(mockIncomingDelay) && mockIncomingDelay > 0) {
    setTimeout(() => backend.simulateIncoming(), mockIncomingDelay);
  }
  createWindow();
  if (trayAvailable) createTray();
});

app.on('window-all-closed', () => {
  // With no tray there is no way back to the app, so quit normally.
  if (!trayAvailable) app.quit();
});
let shuttingDown = false;

// Finalising a recording must not be able to hold the app open. Past this
// deadline we stop waiting and dispose anyway - dispose() kills any recorder
// still running, so the worst case is a kept WAV rather than a lost Opus.
const SHUTDOWN_GRACE_MS = 20000;

app.on('before-quit', async (event) => {
  // preventDefault BEFORE the guard: a second quit trigger arriving during
  // shutdown must also be deferred, or Electron's default quit races the
  // cleanup already in flight.
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  app.isQuitting = true;

  // Defer the quit: a call still recording needs its encode finished and its
  // path attached before the row is written, and its pw-record child reaped.
  // Quitting synchronously orphans the process and loses the recording.
  try {
    await Promise.race([
      callSession?.stop(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
    backend?.dispose?.();
    store?.close();
  } catch (err) {
    // Every step above is best-effort. A throw here previously skipped
    // app.exit() entirely, and because shuttingDown is already set, every
    // later quit attempt returns at the guard - the app becomes unquittable
    // by a different route than the one the timeout closed.
    console.error('[konnect] shutdown step failed:', err.message);
  } finally {
    app.exit(0);
  }
});
```

- [ ] **Step 4: Write `src/renderer/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Konnect</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <nav id="nav">
    <button data-view="status" class="active">Status</button>
    <button data-view="dialer">Dialer</button>
    <button data-view="calls">Call log</button>
    <button data-view="contacts">Contacts</button>
    <button data-view="setup">Setup</button>
  </nav>

  <main>
    <section id="view-status" class="view active">
      <h1>Handset</h1>
      <div id="s-error" class="banner" hidden></div>
      <div class="cards">
        <div class="card"><span class="k">Device</span><span class="v" id="s-model">-</span></div>
        <div class="card"><span class="k">Connection</span><span class="v" id="s-conn">-</span></div>
        <div class="card"><span class="k">Operator</span><span class="v" id="s-op">-</span></div>
        <div class="card"><span class="k">Signal</span><span class="v" id="s-sig">-</span></div>
        <div class="card"><span class="k">Battery</span><span class="v" id="s-bat">-</span></div>
      </div>
    </section>

    <section id="view-dialer" class="view"><h1>Dialer</h1><p class="muted">Added in task 8.</p></section>
    <section id="view-calls" class="view"><h1>Call log</h1><p class="muted">Added in task 9.</p></section>
    <section id="view-contacts" class="view"><h1>Contacts</h1><p class="muted">Added in task 12.</p></section>

    <section id="view-setup" class="view">
      <h1>Setup</h1>
      <button id="run-checks">Run checks</button>
      <ul id="checks"></ul>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Write `src/renderer/styles.css`**

```css
:root {
  --bg: #14161a; --panel: #1c1f26; --line: #2a2f3a;
  --text: #e7eaf0; --muted: #8b93a5; --accent: #4a9eff;
  --ok: #3fb950; --bad: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  display: grid; grid-template-columns: 200px 1fr; height: 100vh;
}
#nav { background: var(--panel); border-right: 1px solid var(--line); padding: 16px 8px; }
#nav button {
  display: block; width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 4px;
  background: none; border: 0; border-radius: 8px; color: var(--muted);
  font: inherit; cursor: pointer;
}
#nav button:hover { background: #23272f; color: var(--text); }
#nav button.active { background: var(--accent); color: #fff; }
main { padding: 28px 32px; overflow-y: auto; }
h1 { font-size: 20px; margin: 0 0 20px; font-weight: 600; }
.view { display: none; }
.view.active { display: block; }
.muted { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;
}
.card .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card .v { font-size: 20px; font-weight: 600; }
button.primary {
  background: var(--accent); color: #fff; border: 0; border-radius: 8px;
  padding: 10px 18px; font: inherit; cursor: pointer;
}
#checks { list-style: none; padding: 0; margin-top: 16px; }
#checks li {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px;
  flex-wrap: wrap;
}
.manual-step {
  flex-basis: 100%; margin-top: 10px; padding: 12px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
}
.manual-step p { margin: 0 0 8px; color: var(--muted); }
.manual-step code {
  display: block; padding: 8px 10px; margin-bottom: 8px;
  background: #101318; border-radius: 6px; user-select: all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* Manual commands can be multi-line (the WirePlumber one writes a config
     file via heredoc), so newlines must survive. */
  white-space: pre-wrap; overflow-x: auto;
}
.manual-step button { margin-right: 8px; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
```

- [ ] **Step 6: Write `src/renderer/app.js`**

```js
'use strict';

const $ = (sel) => document.querySelector(sel);

function showView(name) {
  for (const b of document.querySelectorAll('#nav button')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === `view-${name}`);
  }
}

for (const b of document.querySelectorAll('#nav button')) {
  b.addEventListener('click', () => showView(b.dataset.view));
}

function renderStatus(s) {
  if (!s) return;

  // s.error means the status could not be READ - the bus is unreachable, or
  // the modem is offline. Reporting "Disconnected" in that case is precisely
  // the masquerade the error field exists to prevent, so say "Unknown" and
  // show what actually went wrong.
  const banner = $('#s-error');
  banner.textContent = s.error ? `Cannot read handset status: ${s.error}` : '';
  banner.hidden = !s.error;

  $('#s-model').textContent = s.model || 'Not detected';
  $('#s-conn').textContent =
    s.error ? 'Unknown' : (s.connected ? 'Connected' : 'Disconnected');
  $('#s-op').textContent = s.operator || '-';
  $('#s-sig').textContent = s.signal === null || s.signal === undefined ? '-' : `${s.signal}%`;
  $('#s-bat').textContent = s.battery === null || s.battery === undefined ? '-' : `${s.battery}%`;
}

async function renderChecks() {
  const list = $('#checks');
  list.innerHTML = '<li class="muted">Running...</li>';
  const results = await window.konnect.runSetupChecks();
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${r.ok ? 'ok' : 'bad'}`;
    const label = document.createElement('span');
    label.textContent = r.label;
    li.append(dot, label);
    if (!r.ok) {
      const fix = document.createElement('button');
      fix.className = 'primary';
      fix.textContent = 'Fix';
      fix.style.marginLeft = 'auto';
      fix.addEventListener('click', async () => {
        fix.disabled = true;
        fix.textContent = 'Working...';
        let result;
        try {
          result = await window.konnect.remediate(r.id);
        } catch (e) {
          // remediate() only rejects for an unknown id - a programming error.
          // Deliberately NOT r.remedy: that is a human description, and
          // offering prose as a copyable command is the defect this fallback
          // was built to remove.
          result = { ok: false, reason: 'failed', detail: e.message, command: null };
        }
        if (result && result.ok) { renderChecks(); return; }
        // Never dead-end: show the command so the user can run it by hand.
        showManualStep(li, result);
        fix.disabled = false;
        fix.textContent = 'Fix';
      });
      li.append(fix);
    }
    list.append(li);
  }
}

// Setup must never dead-end because a password prompt was dismissed
// (spec 4.4). Whatever went wrong, surface the command to run by hand.
const ELEVATION_MESSAGE = {
  cancelled: 'The authentication prompt was dismissed. Run this yourself, then press Recheck:',
  unavailable: 'Could not request administrator access. Run this yourself, then press Recheck:',
  failed: 'That command failed. Run it yourself to see why, then press Recheck:',
};

function showManualStep(container, result) {
  container.querySelector('.manual-step')?.remove();
  const box = document.createElement('div');
  box.className = 'manual-step';

  const msg = document.createElement('p');
  msg.textContent = ELEVATION_MESSAGE[result?.reason] || ELEVATION_MESSAGE.failed;

  const cmd = document.createElement('code');
  cmd.textContent = result?.command || '(no command available)';

  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd.textContent).then(
      () => { copy.textContent = 'Copied'; },
      () => { copy.textContent = 'Copy failed'; });
  });

  const recheck = document.createElement('button');
  recheck.textContent = 'Recheck';
  recheck.addEventListener('click', renderChecks);

  box.append(msg, cmd, copy, recheck);
  container.append(box);
}

$('#run-checks').addEventListener('click', renderChecks);
window.konnect.onStatus(renderStatus);
window.konnect.getStatus().then(renderStatus).catch(() => {});
```

- [ ] **Step 7: Make Electron launchable, then run against the mock backend**

`npm install` extracts `chrome-sandbox` without its setuid bit, and Electron
refuses to start rather than run unsandboxed:

```
FATAL:setuid_sandbox_host.cc] The SUID sandbox helper binary was found, but is
not configured correctly.
```

The correct fix is one-time and needs root:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

If root is unavailable, add a dev-only script and use it — do NOT put
`--no-sandbox` on the default `start` script, which would ship a weakened
renderer sandbox:

```bash
npm pkg set scripts.start:dev="electron . --no-sandbox"
```

`electron-builder` installs `chrome-sandbox` correctly in packaged builds, so
this is a development-environment issue only.

Run: `KONNECT_MOCK=1 npm start` (or `npm run start:dev`)
Expected: window opens on Status showing `F120B`, `Connected`, `JIO`, `100%`, `80%`. Nav switches views. Tray icon present with a tooltip.

- [ ] **Step 8: Run the app against the handset**

Run: `npm start`
Expected: real values from the handset. The Setup view's checks all pass on the machine used for the phase 0 spike.

- [ ] **Step 9: Commit**

```bash
git add src/main/index.js src/main/preload.js src/main/ipc.js src/renderer
git commit -m "feat: electron shell, ipc bridge, tray and status view"
```

---

### Task 8: Dialer view and outgoing calls

**Files:**
- Modify: `src/renderer/index.html` (replace the dialer placeholder)
- Modify: `src/renderer/styles.css` (append dialer styles)
- Modify: `src/renderer/app.js` (append dialer logic)

**Interfaces:**
- Consumes: `window.konnect.dial/answer/hangup/sendDtmf/onCall` (Task 7)
- Produces: `renderCall(call)` in `app.js`, reused by the incoming-call window in Task 10

- [ ] **Step 1: Replace the dialer section in `src/renderer/index.html`**

```html
<section id="view-dialer" class="view">
  <h1>Dialer</h1>
  <div class="dialer">
    <input id="d-number" type="tel" placeholder="+91 98765 43210" autocomplete="off">
    <div class="keypad">
      <button>1</button><button>2</button><button>3</button>
      <button>4</button><button>5</button><button>6</button>
      <button>7</button><button>8</button><button>9</button>
      <button>*</button><button>0</button><button>#</button>
    </div>
    <div class="dial-actions">
      <button id="d-call" class="primary">Call</button>
      <button id="d-back">Delete</button>
    </div>
  </div>

  <div id="call-panel" hidden>
    <div class="call-name" id="c-name">-</div>
    <div class="call-number" id="c-number">-</div>
    <div class="call-state" id="c-state">-</div>
    <div class="call-timer" id="c-timer">00:00</div>
    <div class="dial-actions">
      <button id="c-answer" class="primary" hidden>Answer</button>
      <button id="c-hangup">Hang up</button>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Append dialer styles to `src/renderer/styles.css`**

```css
.dialer { max-width: 320px; }
#d-number {
  width: 100%; padding: 12px 14px; font-size: 20px; letter-spacing: .02em;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  color: var(--text); margin-bottom: 14px;
}
.keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.keypad button {
  padding: 16px 0; font-size: 18px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 10px; cursor: pointer;
}
.keypad button:hover { border-color: var(--accent); }
.dial-actions { display: flex; gap: 8px; margin-top: 14px; }
.dial-actions button {
  flex: 1; padding: 12px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--panel); color: var(--text); font: inherit; cursor: pointer;
}
#call-panel {
  margin-top: 24px; padding: 20px; max-width: 320px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
}
.call-name { font-size: 20px; font-weight: 600; }
.call-number { color: var(--muted); }
.call-state { margin-top: 10px; text-transform: capitalize; color: var(--accent); }
.call-timer { font-size: 28px; font-variant-numeric: tabular-nums; margin-top: 4px; }
```

- [ ] **Step 3: Append dialer logic to `src/renderer/app.js`**

```js
// ---- dialer -------------------------------------------------------------
// Every live call, keyed by id. The handset advertises three-way-calling and
// oFono reports a second inbound call as 'waiting', so more than one call can
// exist at once. Tracking only "the" call made a second call steal the panel,
// stop the first call's timer, and silently retarget Hangup at the wrong one.
const liveCalls = new Map();
let activeCall = null;
let timerHandle = null;

// The Call button is enabled only when nothing is live AND no dial is waiting
// for its first call event. Inferring that from liveCalls alone is not enough:
// dial() resolves before CallAdded arrives, so liveCalls is briefly empty
// while a call is genuinely on its way - and a backstop armed by an EARLIER
// dial can fire inside a later dial's window and re-open the same hole.
let dialPending = false;
let dialBackstop = null;

function updateDialButton() {
  $('#d-call').disabled = dialPending || liveCalls.size > 0;
}

function clearDialPending() {
  dialPending = false;
  if (dialBackstop) {
    clearTimeout(dialBackstop);
    dialBackstop = null;
  }
  updateDialButton();
}

// Which call the in-call panel represents. An active call outranks a ringing
// one: an incoming call already surfaces as a desktop notification and its own
// window, so the panel keeps showing the conversation actually in progress.
function primaryCall() {
  for (const call of liveCalls.values()) {
    if (call.state === 'active') return call;
  }
  let last = null;
  for (const call of liveCalls.values()) last = call;
  return last;
}

function formatDuration(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

// Duration counts from StartTime, which oFono emits only on answer. Counting
// from dial time would inflate every call by its ring duration.
function startTimer(startedAt) {
  stopTimer();
  const base = startedAt ? new Date(startedAt).getTime() : Date.now();
  const tick = () => {
    const secs = Math.max(0, Math.floor((Date.now() - base) / 1000));
    $('#c-timer').textContent = formatDuration(secs);
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function renderCall(call) {
  if (call) {
    if (call.state === 'disconnected') liveCalls.delete(call.id);
    else liveCalls.set(call.id, call);
  }

  // A call exists, so whatever dial was pending has landed. Cancelling the
  // backstop here is what stops it firing inside a LATER dial's window.
  if (liveCalls.size > 0) clearDialPending();
  updateDialButton();

  const shown = primaryCall();
  const panel = $('#call-panel');
  if (!shown) {
    panel.hidden = true;
    stopTimer();
    activeCall = null;
    return;
  }

  activeCall = shown;
  panel.hidden = false;
  $('#c-name').textContent = shown.name || 'Unknown';
  $('#c-number').textContent = shown.number || '-';
  $('#c-state').textContent = shown.state;
  $('#c-answer').hidden = shown.state !== 'incoming';
  if (shown.state === 'active') startTimer(shown.startedAt); else stopTimer();
}

for (const key of document.querySelectorAll('.keypad button')) {
  key.addEventListener('click', () => {
    if (activeCall && activeCall.state === 'active') {
      window.konnect.sendDtmf(key.textContent);
    } else {
      $('#d-number').value += key.textContent;
    }
  });
}

$('#d-back').addEventListener('click', () => {
  const el = $('#d-number');
  el.value = el.value.slice(0, -1);
});

$('#d-call').addEventListener('click', async () => {
  // A dial is already going out - silently ignore the extra click rather than
  // scolding the user for double-clicking.
  if (dialPending) return;
  if (liveCalls.size > 0) {
    alert('A call is already in progress.');
    return;
  }
  const number = $('#d-number').value.trim();
  if (!number) {
    alert('Enter a number to dial.');
    return;
  }

  dialPending = true;
  updateDialButton();
  try {
    await window.konnect.dial(number);
    // Stay pending until a call event actually arrives - dial() resolving does
    // not mean the call exists. The backstop covers only a dial that resolves
    // and never yields a call event; renderCall cancels it as soon as any call
    // registers, so it can never fire inside a later dial's window.
    if (dialBackstop) clearTimeout(dialBackstop);
    dialBackstop = setTimeout(() => {
      dialBackstop = null;
      clearDialPending();
    }, 10000);
  } catch (e) {
    // Nothing was placed, so another attempt is safe immediately.
    clearDialPending();
    alert(`Could not dial: ${e.message}`);
  }
});

// Failures here must be visible. A silently swallowed hangup leaves the user
// believing the call ended while the microphone is still live.
$('#c-hangup').addEventListener('click', async () => {
  if (!activeCall) return;
  try {
    await window.konnect.hangup(activeCall.id);
  } catch (e) {
    alert(`Could not hang up: ${e.message}\nThe call may still be connected.`);
  }
});
$('#c-answer').addEventListener('click', async () => {
  if (!activeCall) return;
  try {
    await window.konnect.answer(activeCall.id);
  } catch (e) {
    alert(`Could not answer: ${e.message}`);
  }
});

window.konnect.onCall((call) => {
  // Compute this BEFORE renderCall, which mutates liveCalls.
  const isNewCall =
    call && call.state !== 'disconnected' && !liveCalls.has(call.id);
  renderCall(call);
  // Switch to the dialer only when a call FIRST appears. oFono emits an event
  // per property change - a name resolving mid-call is one - so switching on
  // every event drags the user back here repeatedly while they are trying to
  // read something else.
  if (isNewCall) showView('dialer');
});
```

- [ ] **Step 4: Verify with the mock backend**

Run: `KONNECT_MOCK=1 npm start`
Expected: type a number, press Call. The panel shows `dialing`, then `alerting`, then `active` with a running timer. Hang up hides the panel and stops the timer.

- [ ] **Step 5: Verify with the handset**

Run: `npm start`, dial a number you may ring.
Expected: the same transitions against real hardware, audio audible through your speakers, and the timer starting only when the call is answered.

- [ ] **Step 6: Commit**

```bash
git add src/renderer
git commit -m "feat: dialer view with keypad, dtmf and in-call panel"
```

---

### Task 9: Call session manager and call log persistence

Spec section 5.1. Turns the stream of oFono call events into durable rows. This is the piece that decides what a "missed call" is, so it gets real tests driven by the mock backend.

**Files:**
- Create: `src/main/callsession.js`
- Modify: `src/main/index.js` (start the session manager)
- Test: `test/callsession.test.js`

**Interfaces:**
- Consumes: `Call` events from any backend, `Store.insertCall` (Task 2)
- Produces:
  - `createCallSession({backend, store, now, onRecord}) -> {start, stop, attachRecording}`
  - Numbers are normalised with `normaliseIndian` (Task 3) before persisting,
    so they match the normalised numbers stored for contacts.
  - `onRecord({phase: 'start'|'stop', call})` fires on answer and on hangup;
    the `'stop'` call runs **before** the row is persisted, so Task 12 can
    attach a recording path via `attachRecording(callId, path)` in time.
  - Persists one row per completed call: outgoing answered, outgoing unanswered, incoming answered, incoming missed.

- [ ] **Step 1: Write the failing test**

Create `test/callsession.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');
const { createCallSession } = require('../src/main/callsession');
const { createEmitter } = require('../src/main/backend/interface');

// Minimal fake backend: we push call events by hand so timing is deterministic.
function fakeBackend() {
  const calls = createEmitter();
  return {
    onCall: (cb) => calls.on(cb),
    emit: (c) => calls.emit(c),
    onDeviceStatus: () => () => {},
    onContacts: () => () => {},
  };
}

function setup() {
  const store = openStore(':memory:');
  const backend = fakeBackend();
  let clock = Date.parse('2026-09-01T12:00:00Z');
  const now = () => new Date(clock);
  const session = createCallSession({ backend, store, now });
  session.start();
  return { store, backend, session, advance: (ms) => { clock += ms; } };
}

test('an answered outgoing call is stored with duration from StartTime', () => {
  const { store, backend, advance } = setup();
  const id = '/call/1';
  backend.emit({ id, direction: 'out', state: 'dialing', number: '+919876543210', name: null, startedAt: null });
  advance(40000);
  backend.emit({ id, direction: 'out', state: 'active', number: '+919876543210', name: null, startedAt: '2026-09-01T12:00:40Z' });
  advance(60000);
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: '2026-09-01T12:00:40Z' });

  const [row] = store.listCalls({});
  assert.strictEqual(row.direction, 'out');
  assert.strictEqual(row.number_e164, '+919876543210');
  // 60s of talk time, NOT the 100s since dialing began.
  assert.strictEqual(row.duration_s, 60);
  store.close();
});

test('an unanswered outgoing call is stored with zero duration and null start', () => {
  const { store, backend, advance } = setup();
  const id = '/call/2';
  backend.emit({ id, direction: 'out', state: 'dialing', number: '+919876543210', name: null, startedAt: null });
  advance(30000);
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: null });

  const [row] = store.listCalls({});
  assert.strictEqual(row.duration_s, 0);
  assert.strictEqual(row.started_at, null);
  store.close();
});

test('an incoming call that is never answered counts as missed', () => {
  const { store, backend, advance } = setup();
  const id = '/call/3';
  backend.emit({ id, direction: 'in', state: 'incoming', number: '+919804464251', name: null, startedAt: null });
  advance(15000);
  backend.emit({ id, direction: 'in', state: 'disconnected', number: '+919804464251', name: null, startedAt: null });

  const stats = store.callStats({});
  assert.strictEqual(stats.missed, 1);
  assert.strictEqual(stats.in, 1);
  store.close();
});

test('an answered incoming call is not counted as missed', () => {
  const { store, backend, advance } = setup();
  const id = '/call/4';
  backend.emit({ id, direction: 'in', state: 'incoming', number: '+919804464251', name: null, startedAt: null });
  advance(5000);
  backend.emit({ id, direction: 'in', state: 'active', number: '+919804464251', name: null, startedAt: '2026-09-01T12:00:05Z' });
  advance(30000);
  backend.emit({ id, direction: 'in', state: 'disconnected', number: '+919804464251', name: null, startedAt: '2026-09-01T12:00:05Z' });

  const stats = store.callStats({});
  assert.strictEqual(stats.missed, 0);
  assert.strictEqual(stats.talkTimeSeconds, 30);
  store.close();
});

test('a call is persisted exactly once even if disconnected repeats', () => {
  const { store, backend } = setup();
  const id = '/call/5';
  const base = { id, direction: 'out', number: '+919876543210', name: null, startedAt: null };
  backend.emit({ ...base, state: 'dialing' });
  backend.emit({ ...base, state: 'disconnected' });
  backend.emit({ ...base, state: 'disconnected' });
  assert.strictEqual(store.listCalls({}).length, 1);
  store.close();
});

test('a disconnected event for an unknown call is ignored', () => {
  const { store, backend } = setup();
  backend.emit({ id: '/ghost', direction: 'out', state: 'disconnected', number: '+911', name: null, startedAt: null });
  assert.strictEqual(store.listCalls({}).length, 0);
  store.close();
});

test('two concurrent calls are tracked independently', () => {
  const { store, backend, advance } = setup();
  backend.emit({ id: '/a', direction: 'out', state: 'active', number: '+911', name: null, startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: '/b', direction: 'in', state: 'incoming', number: '+912', name: null, startedAt: null });
  advance(20000);
  backend.emit({ id: '/a', direction: 'out', state: 'disconnected', number: '+911', name: null, startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: '/b', direction: 'in', state: 'disconnected', number: '+912', name: null, startedAt: null });

  const rows = store.listCalls({});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.filter((r) => r.duration_s === 20).length, 1);
  store.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/callsession.test.js`
Expected: FAIL - `Cannot find module '../src/main/callsession'`

- [ ] **Step 3: Write `src/main/callsession.js`**

```js
'use strict';
const { normaliseIndian, UNKNOWN_NUMBER } = require('../shared/phone');

// Converts the oFono call event stream into durable rows.
//
// Duration is measured from StartTime, which oFono emits only on the
// transition to active. A call that never reaches active has no StartTime,
// zero duration, and - if inbound - is a missed call.
function createCallSession({ backend, store, now = () => new Date(), onRecord = null }) {
  const live = new Map();   // call id -> { direction, number, name, startedAt }
  let unsubscribe = null;

  function persist(id) {
    const entry = live.get(id);
    if (!entry) return;                 // unknown or already persisted
    live.delete(id);

    const endedAt = now();
    let duration = 0;
    if (entry.startedAt) {
      const started = new Date(entry.startedAt).getTime();
      const seconds = Math.round((endedAt.getTime() - started) / 1000);
      // A StartTime Date cannot parse yields NaN, which SQLite rejects against
      // the NOT NULL duration column. The insert would throw AFTER the entry
      // was removed from `live`, losing the call entirely, and the exception
      // would escape into the D-Bus signal handler that delivered the event.
      duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    }

    // Contacts are stored normalised, so call numbers must be too - otherwise
    // the exact-match contact lookup silently misses and caller id never
    // resolves. Normalisation is idempotent for already-E.164 input.
    const normalised = entry.number ? (normaliseIndian(entry.number) || entry.number) : null;

    try {
      store.insertCall({
        direction: entry.direction,
        number_e164: normalised || UNKNOWN_NUMBER,
        started_at: entry.startedAt || null,
        ended_at: endedAt.toISOString(),
        duration_s: duration,
        recording_path: entry.recordingPath || null,
      });
    } catch (err) {
      // This runs inside a D-Bus signal handler. Losing one row is bad; an
      // exception escaping into the event path would break call handling for
      // the rest of the session.
      console.error('[konnect] failed to persist call:', err.message);
    }
  }

  async function handle(call) {
    if (!call || !call.id) return;

    if (call.state === 'disconnected') {
      // Awaited, because attachRecording() must land before persist() writes
      // the row - there is no path to backfill recording_path afterwards.
      //
      // Guarded, because a recorder failure must NOT cost the call log entry:
      // the row is the primary record and the recording is an attachment to
      // it. Unguarded, a throw here skips persist() entirely (the call
      // vanishes) and escapes as an unhandled rejection out of a D-Bus signal
      // handler. Measured: 0 rows persisted unguarded, 1 guarded.
      if (onRecord) {
        try {
          await onRecord({ phase: 'stop', call });
        } catch (err) {
          console.error('[konnect] recorder stop failed:', err.message);
        }
      }
      persist(call.id);
      return;
    }

    const prev = live.get(call.id) || {};
    const next = {
      direction: call.direction,
      number: call.number || prev.number || null,
      name: call.name || prev.name || null,
      // StartTime arrives once and must never be overwritten with null.
      startedAt: call.startedAt || prev.startedAt || null,
      recordingPath: prev.recordingPath || null,
    };
    live.set(call.id, next);

    if (onRecord && call.state === 'active' && !prev.startedAt && next.startedAt) {
      // Fire-and-forget: the call is already live and its row is written on
      // hangup regardless. Caught so a recorder failure cannot surface as an
      // unhandled rejection out of a D-Bus signal handler.
      Promise.resolve(onRecord({ phase: 'start', call }))
        .catch((err) => console.error('[konnect] recorder start failed:', err.message));
    }
  }

  return {
    start() { if (!unsubscribe) unsubscribe = backend.onCall(handle); },
    // Async so recordings can be finalised before their rows are written -
    // the same ordering the disconnected path uses. Without it a call still
    // live at shutdown is persisted with recording_path null while its
    // recorder keeps running.
    async stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      for (const id of [...live.keys()]) {
        const entry = live.get(id);
        if (onRecord && entry) {
          try {
            await onRecord({ phase: 'stop', call: { id, ...entry } });
          } catch (err) {
            console.error('[konnect] recorder stop failed at shutdown:', err.message);
          }
        }
        persist(id);
      }
    },
    // exposed so the recorder can attach a path before the row is written
    attachRecording(id, path) {
      const entry = live.get(id);
      if (entry) entry.recordingPath = path;
    },
  };
}

module.exports = { createCallSession };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/callsession.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Start the session manager in `src/main/index.js`**

Add near the other requires:

```js
const { createCallSession } = require('./callsession');
```

and inside `app.whenReady()`, after `registerIpc(...)`:

```js
  callSession = createCallSession({ backend, store });
  callSession.start();
```

Declare `let callSession = null;` alongside the other module-level lets, and stop it in `before-quit`:

```js
  callSession?.stop();
```

- [ ] **Step 6: Commit**

```bash
git add src/main/callsession.js src/main/index.js test/callsession.test.js
git commit -m "feat: call session manager persisting calls with real durations"
```

---

### Task 10: Incoming call window and desktop notifications

Spec section 9. The app is tray-resident, so an incoming call must surface even when the window is hidden.

**Files:**
- Create: `src/renderer/incoming.html`
- Modify: `src/main/index.js` (incoming window + notification)

**Interfaces:**
- Consumes: `backend.onCall` (Task 5), `Call` shape (Task 1)
- Produces: `showIncoming(call)` / `closeIncoming()` in `src/main/index.js`

- [ ] **Step 1: Write `src/renderer/incoming.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Incoming call</title>
  <style>
    body {
      margin: 0; height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 6px;
      background: #1c1f26; color: #e7eaf0;
      font: 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .name { font-size: 22px; font-weight: 600; }
    .number { color: #8b93a5; }
    .row { display: flex; gap: 10px; margin-top: 18px; }
    button { padding: 10px 22px; border: 0; border-radius: 8px; font: inherit; cursor: pointer; color: #fff; }
    .answer { background: #3fb950; } .reject { background: #f85149; }
  </style>
</head>
<body>
  <div class="name" id="name">Unknown</div>
  <div class="number" id="number"></div>
  <div class="row">
    <button class="answer" id="answer">Answer</button>
    <button class="reject" id="reject">Reject</button>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    document.getElementById('name').textContent = params.get('name') || 'Unknown';
    document.getElementById('number').textContent = params.get('number') || '';
    document.getElementById('answer').addEventListener('click', () => window.konnect.answer(params.get('id')));
    document.getElementById('reject').addEventListener('click', () => window.konnect.hangup(params.get('id')));
  </script>
</body>
</html>
```

- [ ] **Step 2: Add the incoming window to `src/main/index.js`**

Add `Notification` to the electron require, declare `let incomingWin = null;`, and add:

```js
function closeIncoming() {
  if (incomingWin && !incomingWin.isDestroyed()) incomingWin.close();
  incomingWin = null;
  incomingCallId = null;
}

function showIncoming(call) {
  // oFono re-emits the WHOLE call object on every PropertyChanged, not only on
  // state transitions - a caller name resolving mid-ring is one such event -
  // so guard on the call id. Without it the window is destroyed and rebuilt
  // and a duplicate notification fires for each property change while ringing.
  // Measured: three windows and three notifications for one ringing call.
  if (incomingCallId === call.id) return;
  closeIncoming();
  incomingCallId = call.id;
  const q = new URLSearchParams({
    id: call.id, number: call.number || '', name: call.name || 'Unknown',
  }).toString();

  incomingWin = new BrowserWindow({
    width: 320, height: 220, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, title: 'Incoming call',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  incomingWin.loadFile(path.join(__dirname, '..', 'renderer', 'incoming.html'), { search: q });

  new Notification({
    title: `Incoming call - ${call.name || 'Unknown'}`,
    body: call.number || '',
  }).show();
}
```

Then wire it, inside `app.whenReady()` after `callSession.start()`:

```js
  backend.onCall((call) => {
    // 'waiting' is oFono's second-inbound-call state and is in the backend's
    // own INBOUND_STATES. Treating it here is what makes the dialer's
    // primaryCall() rationale true: the in-app panel deliberately keeps
    // showing the ACTIVE call because a ringing one surfaces as a notification
    // and its own window - which only holds if 'waiting' opens one.
    if (call.state === 'incoming' || call.state === 'waiting') showIncoming(call);
    else if (call.state === 'disconnected' || call.state === 'active') closeIncoming();
  });
```

- [ ] **Step 3: Verify with the mock — no real call**

The mock cannot produce an inbound call on its own, which is why
`simulateIncoming` and the `KONNECT_MOCK_INCOMING` hook exist. Use them:

Run: `KONNECT_MOCK=1 KONNECT_MOCK_INCOMING=4000 npm start`, then close the main
window within four seconds so only the tray remains.

Expected: a desktop notification plus a small always-on-top window showing
`+919804464251`. Answer transitions the call to active and closes the window;
Reject hangs up. Afterwards a row exists in the store — check with
`node -e "const {openStore}=require('./src/main/store'); const s=openStore(process.env.HOME+'/.config/konnect/konnect.db'); console.log(s.listCalls({limit:5})); s.close();"`
(or via the call log view once Task 11 lands).

**Do not verify this by ringing the real handset.** A real incoming call is the
user's to arrange, not an agent's.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/incoming.html src/main/index.js
git commit -m "feat: incoming call window and desktop notification"
```

---

### Task 11: Call log view with honest empty state

Spec section 5.1. The empty state carries real information: an empty list here does not mean sync failed, it means history starts now. Getting this wrong makes the app look broken on first run.

**Files:**
- Modify: `src/renderer/index.html` (replace the call log placeholder)
- Modify: `src/renderer/styles.css` (append table styles)
- Modify: `src/renderer/app.js` (append call log logic)

**Interfaces:**
- Consumes: `window.konnect.listCalls`, `window.konnect.callStats`
- Produces: `renderCalls()` in `app.js`, reused by the export view in Task 14

- [ ] **Step 1: Replace the call log section in `src/renderer/index.html`**

```html
<section id="view-calls" class="view">
  <h1>Call log</h1>
  <div class="filters">
    <label>From <input type="date" id="f-from"></label>
    <label>To <input type="date" id="f-to"></label>
    <button id="f-apply">Apply</button>
    <button id="f-clear">Clear</button>
  </div>
  <div class="cards" id="call-stats"></div>
  <table id="calls-table">
    <thead>
      <tr><th>Direction</th><th>Name</th><th>Number</th><th>When</th><th>Duration</th><th>Recording</th></tr>
    </thead>
    <tbody id="calls-body"></tbody>
  </table>
  <p id="calls-truncated" class="muted" hidden></p>
  <div id="calls-empty" class="empty" hidden>
    <p><strong id="calls-empty-title">No calls recorded yet.</strong></p>
    <p class="muted" id="calls-empty-body">
      History starts when Konnect first runs. Calls made or received while
      Konnect is closed cannot be recovered - the handset does not share its
      own call history over Bluetooth.
    </p>
  </div>
</section>
```

- [ ] **Step 2: Append styles to `src/renderer/styles.css`**

```css
.filters { display: flex; gap: 12px; align-items: end; margin-bottom: 18px; flex-wrap: wrap; }
.filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.filters input, .filters button {
  padding: 8px 10px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 8px; font: inherit;
}
.filters button { cursor: pointer; }
table { width: 100%; border-collapse: collapse; margin-top: 18px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
td.dir-in { color: var(--ok); } td.dir-out { color: var(--accent); } td.dir-missed { color: var(--bad); }
.banner {
  padding: 10px 14px; margin-bottom: 16px; border-radius: 8px;
  background: #3a2326; border: 1px solid var(--bad); color: #ffd7d5;
}
.empty { margin-top: 32px; padding: 24px; border: 1px dashed var(--line); border-radius: 12px; max-width: 560px; }
```

- [ ] **Step 3: Append call log logic to `src/renderer/app.js`**

```js
// ---- call log -----------------------------------------------------------
function fmtWhen(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function directionLabel(row) {
  if (row.direction === 'in' && !row.started_at) return ['Missed', 'dir-missed'];
  return row.direction === 'in' ? ['Incoming', 'dir-in'] : ['Outgoing', 'dir-out'];
}

function currentRange() {
  const from = $('#f-from').value || null;
  const to = $('#f-to').value || null;
  return { from, to };
}

// listCalls is capped; callStats is not. Without the notice below, a range
// holding more than this many calls shows stat tiles that exceed the visible
// rows, which reads as a rendering bug rather than a page limit.
const CALL_PAGE_LIMIT = 500;

async function renderCalls() {
  const range = currentRange();
  const [rows, stats] = await Promise.all([
    window.konnect.listCalls({ ...range, limit: CALL_PAGE_LIMIT }),
    window.konnect.callStats(range),
  ]);

  $('#call-stats').innerHTML = [
    ['Total', stats.total],
    ['Incoming', stats.in],
    ['Outgoing', stats.out],
    ['Missed', stats.missed],
    ['Talk time', formatDuration(stats.talkTimeSeconds)],
  ].map(([k, v]) => `<div class="card"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

  const body = $('#calls-body');
  body.innerHTML = '';
  for (const row of rows) {
    const [label, cls] = directionLabel(row);
    const tr = document.createElement('tr');
    for (const [text, klass] of [
      [label, cls], [row.name || 'Unknown', ''], [row.number_e164, ''],
      [fmtWhen(row.ended_at), ''], [formatDuration(row.duration_s || 0), ''],
      [row.recording_path ? 'Yes' : '-', ''],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (klass) td.className = klass;
      tr.append(td);
    }
    body.append(tr);
  }

  const truncated = stats.total > rows.length;
  $('#calls-truncated').textContent = truncated
    ? `Showing the most recent ${rows.length} of ${stats.total} calls.`
    : '';
  $('#calls-truncated').hidden = !truncated;

  const empty = rows.length === 0;
  if (empty) {
    // A filtered-empty result is NOT an empty history. Showing the first-run
    // explanation when the user has merely narrowed a date range tells them
    // their calls were never captured, which is false.
    const filtered = Boolean(range.from || range.to);
    $('#calls-empty-title').textContent =
      filtered ? 'No calls in this date range.' : 'No calls recorded yet.';
    $('#calls-empty-body').textContent = filtered
      ? 'Clear the filters to see the full call history.'
      : 'History starts when Konnect first runs. Calls made or received while '
        + 'Konnect is closed cannot be recovered - the handset does not share '
        + 'its own call history over Bluetooth.';
  }
  $('#calls-empty').hidden = !empty;
  $('#calls-table').hidden = empty;
}

$('#f-apply').addEventListener('click', renderCalls);
$('#f-clear').addEventListener('click', () => {
  $('#f-from').value = '';
  $('#f-to').value = '';
  renderCalls();
});

// Refresh whenever a call ends, so the log is current without a manual reload.
window.konnect.onCall((call) => { if (call.state === 'disconnected') renderCalls(); });
```

Also extend the nav handler so switching to the call log refreshes it — replace the nav click listener with:

```js
for (const b of document.querySelectorAll('#nav button')) {
  b.addEventListener('click', () => {
    showView(b.dataset.view);
    if (b.dataset.view === 'calls') renderCalls();
  });
}
```

- [ ] **Step 4: Verify the empty state**

Run: `KONNECT_MOCK=1 npm start` with a fresh user-data directory, open Call log.
Expected: the explanatory empty state, not a bare empty table.

- [ ] **Step 5: Verify with real calls**

Run: `npm start`, make one call and reject one incoming call.
Expected: two rows — one Outgoing with a real duration, one Missed with `-`. Stats update. Date filters narrow the list.

- [ ] **Step 6: Commit**

```bash
git add src/renderer
git commit -m "feat: call log view with stats, filters and explanatory empty state"
```

---

### Task 12: Call recording

Spec section 7. The recipe below is the one verified bit-exact during the phase 0 spike. Two constraints are absolute: never use `pw-record --target <node>` (it silently records the default source), and never build `pw-loopback` routing (WirePlumber already links the SCO audio).

**Files:**
- Create: `src/main/backend/linux/recorder.js`
- Modify: `src/main/backend/linux/index.js` (replace recording stubs)
- Modify: `src/main/index.js` (wire recording into the call session)
- Modify: `src/renderer/index.html` (the master toggle and REC indicator)
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js`
- Create: `scripts/verify-recording.js`
- Test: `test/recorder-helpers.test.js`

**Interfaces:**
- Consumes: `pw-dump`, `pw-link`, `pw-record`, `ffmpeg` as child processes
- Produces:
  - `parsePwLink(text) -> Array<{output: string, input: string}>` (pure)
  - `findMicFeedingPhone(links) -> string|null` (pure) — the source linked into `bluez_output`
  - `createRecorder({outputDir}) -> {start(callId), stop(callId)}`

- [ ] **Step 1: Write the failing helper test**

Create `test/recorder-helpers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { parsePwLink, findMicFeedingPhone } = require('../src/main/backend/linux/recorder');

// Real `pw-link -l` output captured during the phase 0 spike.
const SAMPLE = [
  'alsa_output.pci-0000_2d_00.4.analog-stereo:playback_FL',
  '  |<- bluez_input.44_CD_0E_AD_5E_34.0:output_FL',
  'alsa_output.pci-0000_2d_00.4.analog-stereo:playback_FR',
  '  |<- bluez_input.44_CD_0E_AD_5E_34.0:output_FR',
  'alsa_input.usb-Jieli_Technology_USB_Composite_Device-00.mono-fallback:capture_MONO',
  '  |-> bluez_output.44_CD_0E_AD_5E_34.1:input_MONO',
].join('\n');

test('parsePwLink extracts output to input pairs in both arrow directions', () => {
  const links = parsePwLink(SAMPLE);
  assert.ok(links.some((l) =>
    l.output === 'bluez_input.44_CD_0E_AD_5E_34.0:output_FL' &&
    l.input === 'alsa_output.pci-0000_2d_00.4.analog-stereo:playback_FL'));
  assert.ok(links.some((l) =>
    l.output === 'alsa_input.usb-Jieli_Technology_USB_Composite_Device-00.mono-fallback:capture_MONO' &&
    l.input === 'bluez_output.44_CD_0E_AD_5E_34.1:input_MONO'));
});

test('findMicFeedingPhone returns the source actually routed to the handset', () => {
  const mic = findMicFeedingPhone(parsePwLink(SAMPLE));
  assert.strictEqual(mic, 'alsa_input.usb-Jieli_Technology_USB_Composite_Device-00.mono-fallback:capture_MONO');
});

test('findMicFeedingPhone returns null when no call audio is routed', () => {
  assert.strictEqual(findMicFeedingPhone(parsePwLink('')), null);
  assert.strictEqual(
    findMicFeedingPhone(parsePwLink('foo:out\n  |-> bar:in')), null);
});

test('parsePwLink tolerates blank and malformed lines', () => {
  assert.deepStrictEqual(parsePwLink('\n\n   \n'), []);
  assert.deepStrictEqual(parsePwLink('no arrows here'), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/recorder-helpers.test.js`
Expected: FAIL - `Cannot find module '.../linux/recorder'`

- [ ] **Step 3: Write `src/main/backend/linux/recorder.js`**

```js
'use strict';
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const execFileAsync = promisify(execFile);

// Opus encoding of a phone call is fast; this only exists so a wedged ffmpeg
// cannot hold the app open at shutdown.
const ENCODE_TIMEOUT_MS = 15000;

// `pw-link -l` prints a node port, then indented links with |-> or |<- arrows.
// |-> means "this port feeds that one"; |<- means the reverse.
function parsePwLink(text) {
  const links = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const arrow = line.match(/^\s+\|(->|<-)\s+(\S+)/);
    if (arrow) {
      if (!current) continue;
      if (arrow[1] === '->') links.push({ output: current, input: arrow[2] });
      else links.push({ output: arrow[2], input: current });
    } else if (/^\S/.test(line)) {
      current = line.trim();
    }
  }
  return links;
}

// The microphone the user is actually being heard through is whichever source
// WirePlumber linked into bluez_output. Guessing the default source instead
// records the wrong microphone whenever the default differs.
function findMicFeedingPhone(links) {
  const link = links.find((l) => l.input.startsWith('bluez_output.'));
  return link ? link.output : null;
}

async function pwLinkList() {
  const { stdout } = await execFileAsync('pw-link', ['-l']);
  return parsePwLink(stdout);
}

async function findRemotePorts(links) {
  const ports = new Set();
  for (const l of links) {
    if (l.output.startsWith('bluez_input.')) ports.add(l.output);
  }
  return [...ports].sort();   // output_FL before output_FR
}

function createRecorder({ outputDir = path.join(os.homedir(), 'Konnect', 'recordings') } = {}) {
  const active = new Map();   // callId -> { proc, wavPath, nodeName }
  // ffmpeg children belonging to a stop() still in flight. app.exit() halts the
  // event loop, so execFile's own timeout cannot fire once shutdown wins the
  // race - dispose() has to be able to reach these directly or they orphan.
  const encoding = new Set();

  // Reports whether the link actually attached. Swallowing failures here is
  // what makes an unlinked recorder indistinguishable from a working one: the
  // file is written, it is the right length, and it is silent. "Already
  // linked" is the one benign failure, and pw-link says so.
  async function link(a, b) {
    try {
      await execFileAsync('pw-link', [a, b]);
      return true;
    } catch (err) {
      return /exists|already/i.test(String(err.stderr || err.message || ''));
    }
  }

  // Poll for the recorder's ports instead of sleeping a fixed interval. Under
  // load the node may not exist yet, and linking to a port that is not there
  // fails silently, yielding a recording of nothing.
  async function waitForPorts(nodeName, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync('pw-link', ['-i']).catch(() => ({ stdout: '' }));
      if (stdout.includes(`${nodeName}:input_FL`)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  return {
    async start(callId) {
      if (active.has(callId)) return active.get(callId).wavPath;
      await fs.mkdir(outputDir, { recursive: true });

      const safe = String(callId).replace(/[^A-Za-z0-9]/g, '_').slice(-40);
      const nodeName = `konnect_rec_${safe}`;
      const wavPath = path.join(outputDir, `${safe}.wav`);

      // --target 0 means "do not auto-link". Anything else silently attaches
      // to the default source and records the wrong audio (spec 7.2).
      const proc = spawn('pw-record', [
        '-P', `{ node.name = ${nodeName} }`,
        '--target', '0', '--channels', '2', wavPath,
      ], { stdio: 'ignore' });
      active.set(callId, { proc, wavPath, nodeName });

      if (!await waitForPorts(nodeName)) {
        proc.kill('SIGTERM');
        active.delete(callId);
        // pw-record writes the WAV header the moment it spawns, so a timeout
        // always leaves a file behind. Nothing will ever reference it - start()
        // returns null - and stop() cannot reach it once the active entry is
        // gone, so remove it here as the remote-link-failure path does.
        await fs.unlink(wavPath).catch(() => {});
        console.error(`[konnect] recorder ports never appeared for ${callId}; not recording`);
        return null;
      }

      const links = await pwLinkList();
      const remote = await findRemotePorts(links);
      const mic = findMicFeedingPhone(links);

      // Remote voice on the left, local voice on the right.
      const remoteLinked = remote[0] ? await link(remote[0], `${nodeName}:input_FL`) : false;
      const micLinked = mic ? await link(mic, `${nodeName}:input_FR`) : false;

      if (!remoteLinked) {
        // Without the far end there is nothing worth keeping - the file would
        // hold only the local mic, or silence, and would be indistinguishable
        // from a real recording. Fail loudly and claim nothing.
        proc.kill('SIGTERM');
        active.delete(callId);
        await fs.unlink(wavPath).catch(() => {});
        console.error(`[konnect] could not link remote audio for ${callId}; not recording`);
        return null;
      }
      if (!micLinked) {
        console.warn(`[konnect] no local microphone linked for ${callId}; recording the remote side only`);
      }

      return wavPath;
    },

    // Terminate any recorder still running. Without this a pw-record child
    // survives the parent's exit and keeps writing to a file nothing points at.
    dispose() {
      for (const [callId, entry] of active) {
        entry.proc.kill('SIGTERM');
        active.delete(callId);
      }
      for (const child of encoding) child.kill('SIGTERM');
      encoding.clear();
    },

    async stop(callId) {
      const entry = active.get(callId);
      if (!entry) return null;
      active.delete(callId);

      entry.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));

      const opusPath = entry.wavPath.replace(/\.wav$/, '.opus');
      // Bounded: this runs on the shutdown path, where an encode that never
      // returns would stall app.exit() and strand the very dispose() call
      // that could kill it. A timeout turns a hang into a kept WAV.
      const encode = execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', entry.wavPath, '-c:a', 'libopus', '-b:a', '24k', opusPath,
      ], { timeout: ENCODE_TIMEOUT_MS });
      if (encode.child) encoding.add(encode.child);
      try {
        await encode;
        await fs.unlink(entry.wavPath).catch(() => {});
        return opusPath;
      } catch {
        // Encoding failed: keep the raw capture rather than losing the call.
        return entry.wavPath;
      } finally {
        if (encode.child) encoding.delete(encode.child);
      }
    },
  };
}

module.exports = { parsePwLink, findMicFeedingPhone, createRecorder };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/recorder-helpers.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the recorder into `src/main/backend/linux/index.js`**

Add `const { createRecorder } = require('./recorder');`, create `const recorder = createRecorder();` alongside the other components, and replace the two stubs:

```js
    startRecording: (callId) => recorder.start(callId),
    stopRecording: (callId) => recorder.stop(callId),
```

- [ ] **Step 6: Drive recording from the call session in `src/main/index.js`**

Replace the `createCallSession` construction with one that starts and stops recording, honouring the master toggle:

```js
  callSession = createCallSession({
    backend,
    store,
    onRecord: async ({ phase, call }) => {
      if (store.getSetting('record_calls') !== 'true') return;
      try {
        if (phase === 'start') {
          await backend.startRecording(call.id);
        } else {
          const finalPath = await backend.stopRecording(call.id);
          if (finalPath) callSession.attachRecording(call.id, finalPath);
        }
      } catch (err) {
        console.error('recording failed:', err.message);
      }
    },
  });
  callSession.start();
```

Note the ordering inside `callsession.js`: `onRecord({phase:'stop'})` runs *before* `persist()`, so `attachRecording` still finds the live entry.

- [ ] **Step 6b: Add the master toggle and REC indicator (spec 7.3)**

Without these the feature is dead code: `record_calls` is only ever read, so
recording can never be switched on.

In `src/renderer/index.html`, inside `#view-status` after the `.cards` div:

```html
      <div class="setting">
        <label>
          <input type="checkbox" id="s-record">
          Record calls
        </label>
        <p class="muted">
          Saved to ~/Konnect/recordings and linked to the call log. Remote
          audio on the left channel, your microphone on the right.
        </p>
      </div>
```

In `src/renderer/index.html`, inside `#call-panel` after `#c-state`:

```html
    <div class="call-rec" id="c-rec" hidden>&#9679; REC</div>
```

In `src/renderer/styles.css`:

```css
.setting { margin-top: 24px; max-width: 560px; }
.setting label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.setting p { margin: 6px 0 0; }
.call-rec { color: var(--bad); font-weight: 600; margin-top: 6px; }
```

In `src/renderer/app.js`, add near the dialer state:

```js
// Mirrors the persisted record_calls setting so the REC indicator reflects
// what the main process will actually do on the next active transition.
let recordCalls = false;

async function loadRecordSetting() {
  recordCalls = (await window.konnect.getSetting('record_calls')) === 'true';
  $('#s-record').checked = recordCalls;
}

$('#s-record').addEventListener('change', async (event) => {
  recordCalls = event.target.checked;
  await window.konnect.setSetting('record_calls', recordCalls ? 'true' : 'false');
});
```

and in `renderCall`, after the state line:

```js
  // The recorder starts on the active transition when the setting is on, so
  // this mirrors what the main process is actually doing rather than guessing.
  $('#c-rec').hidden = !(recordCalls && shown.state === 'active');
```

and call `loadRecordSetting()` alongside the initial status fetch:

```js
loadRecordSetting().catch(() => {});
```

- [ ] **Step 7: Write `scripts/verify-recording.js`**

```js
// Manual check. Start a call first, then run this while it is active:
//   node scripts/verify-recording.js
const { createRecorder } = require('../src/main/backend/linux/recorder');

(async () => {
  const rec = createRecorder({ outputDir: '/tmp/konnect-verify' });
  const wav = await rec.start('verify-1');
  console.log('recording to', wav, '- speak into both ends for 12s');
  await new Promise((r) => setTimeout(r, 12000));
  const out = await rec.stop('verify-1');
  console.log('final file:', out);
})();
```

- [ ] **Step 8: Verify against a live call**

Place a call, then run `node scripts/verify-recording.js` while it is active. When it finishes:

Run: `ffmpeg -hide_banner -i /tmp/konnect-verify/verify_1.opus -af "pan=mono|c0=c0,volumedetect" -f null -` (left channel, remote voice)
Then: `ffmpeg -hide_banner -i /tmp/konnect-verify/verify_1.opus -af "pan=mono|c0=c1,volumedetect" -f null -` (right channel, your voice)

Expected: **both** channels report a `mean_volume` well above silence, and the two values differ. Identical values on both channels means the links did not attach and both inputs captured the same source — the exact failure seen in the spike. Investigate before proceeding.

- [ ] **Step 9: Commit**

```bash
git add src/main/backend/linux/recorder.js src/main/backend/linux/index.js src/main/index.js scripts/verify-recording.js test/recorder-helpers.test.js
git commit -m "feat: stereo call recording via explicit pw-link port routing"
```

---

### Task 13: Contacts import over OBEX Object Push

Spec section 6. The handset pushes; we receive. Incoming OBEX is untrusted input from a device, so section 6.3's trust boundary is implemented here, not bolted on later.

**Files:**
- Create: `src/main/backend/linux/opp.js`
- Modify: `src/main/backend/linux/index.js` (replace contact import stubs)
- Modify: `src/renderer/index.html` / `styles.css` / `app.js` (contacts view)
- Modify: `src/main/ipc.js` (persist imported contacts)
- Test: `test/opp-guard.test.js`

**Interfaces:**
- Consumes: `parseVCards` (Task 3), session bus (Task 4)
- Produces:
  - `isAcceptableTransfer({name, type, size, destination}, {mac, maxBytes}) -> {ok: boolean, reason: string|null}` (pure)
  - `createOppReceiver({mac, stagingDir}) -> {start, cancel, onContacts}`

- [ ] **Step 1: Write the failing guard test**

Create `test/opp-guard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { isAcceptableTransfer } = require('../src/main/backend/linux/opp');

const MAC = '44:CD:0E:AD:5E:34';
const opts = { mac: MAC, maxBytes: 5 * 1024 * 1024 };
const good = { name: 'contacts.vcf', type: 'text/vcard', size: 2048, destination: MAC };

test('accepts a vcard push from the paired handset', () => {
  assert.deepStrictEqual(isAcceptableTransfer(good, opts), { ok: true, reason: null });
});

test('accepts the x-vcard mime variant', () => {
  const r = isAcceptableTransfer({ ...good, type: 'text/x-vcard' }, opts);
  assert.strictEqual(r.ok, true);
});

test('rejects a push from any other device', () => {
  const r = isAcceptableTransfer({ ...good, destination: '30:BB:7D:21:99:DA' }, opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /device/i);
});

test('rejects non-vcard content types', () => {
  for (const type of ['image/jpeg', 'application/octet-stream', 'text/plain']) {
    const r = isAcceptableTransfer({ ...good, type }, opts);
    assert.strictEqual(r.ok, false, `should reject ${type}`);
    assert.match(r.reason, /type/i);
  }
});

test('rejects oversized transfers', () => {
  const r = isAcceptableTransfer({ ...good, size: 50 * 1024 * 1024 }, opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /size/i);
});

test('falls back to the filename extension when type is missing', () => {
  assert.strictEqual(isAcceptableTransfer({ ...good, type: null }, opts).ok, true);
  assert.strictEqual(
    isAcceptableTransfer({ ...good, name: 'photo.jpg', type: null }, opts).ok, false);
});

test('rejects path traversal in the pushed filename', () => {
  const r = isAcceptableTransfer({ ...good, name: '../../.bashrc.vcf' }, opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /name/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/opp-guard.test.js`
Expected: FAIL - `Cannot find module '.../linux/opp'`

- [ ] **Step 3: Write `src/main/backend/linux/opp.js`**

```js
'use strict';
const dbus = require('dbus-next');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sessionBus, unwrap, getInterface } = require('./bus');
const { createEmitter } = require('../interface');
const { parseVCards } = require('../../../shared/vcard');

const OBEX = 'org.bluez.obex';
const AGENT_PATH = '/konnect/obex/agent';
const VCARD_TYPES = new Set(['text/vcard', 'text/x-vcard', 'text/directory']);
const MAX_BYTES = 5 * 1024 * 1024;

// Trust boundary (spec 6.3). Incoming OBEX is device input: validate the
// sender, the content type, the size and the filename before touching disk.
function isAcceptableTransfer(transfer, { mac, maxBytes = MAX_BYTES } = {}) {
  const { name, type, size, destination } = transfer || {};

  if (!destination || destination.toUpperCase() !== String(mac).toUpperCase()) {
    return { ok: false, reason: 'push from an unexpected device' };
  }
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, reason: 'unsafe file name' };
  }
  // Transfer1.Size is D-Bus uint64, and dbus-next marshals that as a BigInt
  // by default (bigIntCompat is false and nothing here overrides it). A
  // `typeof size === 'number'` test is therefore FALSE for every real push,
  // so the cap never fires and an unbounded transfer is authorised. Measured:
  // 500MB as a Number is rejected, the same value as a BigInt was accepted.
  // Normalise instead of type-testing; Number() handles both shapes, and a
  // non-numeric value becomes NaN and is refused.
  if (size !== undefined && size !== null) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes > maxBytes) {
      return { ok: false, reason: `transfer size ${size} exceeds limit` };
    }
  }
  const declared = (type || '').toLowerCase();
  if (declared) {
    if (!VCARD_TYPES.has(declared)) return { ok: false, reason: `unsupported content type ${type}` };
  } else if (!/\.vcf$/i.test(name)) {
    return { ok: false, reason: 'unsupported content type (no vcf extension)' };
  }
  return { ok: true, reason: null };
}

function createOppReceiver({ mac, stagingDir = path.join(os.tmpdir(), 'konnect-import') }) {
  const emitter = createEmitter();
  let active = false;
  let agentRegistered = false;
  const seen = new Set();

  const { Interface, method } = dbus.interface;

  class KonnectAgent extends Interface {
    // obexd calls this before accepting a push. Returning a path accepts it;
    // throwing rejects it.
    async AuthorizePush(transferPath) {
      if (!active) throw new dbus.DBusError(`${OBEX}.Error.Rejected`, 'import not in progress');

      const bus = sessionBus();
      const props = await getInterface(bus, OBEX, transferPath, 'org.freedesktop.DBus.Properties');
      const t = unwrap(await props.GetAll('org.bluez.obex.Transfer1'));

      // The session object carries the peer address.
      const sessionPath = transferPath.replace(/\/transfer\d+$/, '');
      const sProps = await getInterface(bus, OBEX, sessionPath, 'org.freedesktop.DBus.Properties');
      const s = unwrap(await sProps.GetAll('org.bluez.obex.Session1'));

      const verdict = isAcceptableTransfer(
        { name: t.Name, type: t.Type, size: t.Size, destination: s.Source || s.Destination },
        { mac });
      if (!verdict.ok) {
        throw new dbus.DBusError(`${OBEX}.Error.Rejected`, verdict.reason);
      }

      await fs.mkdir(stagingDir, { recursive: true });
      const target = path.join(stagingDir, `${Date.now()}-${path.basename(t.Name)}`);
      // Awaited: obexd does not start the transfer until AuthorizePush returns,
      // so attaching the listener here guarantees it is in place before any
      // Status change can fire. Fire-and-forget could miss a small push that
      // completes during watchTransfer's own getInterface round trip - the
      // contact would be silently lost and the staging file leaked - and any
      // rejection during setup would surface as an unhandled rejection.
      await watchTransfer(transferPath, target);
      return target;
    }

    Cancel() { /* obexd calls this if the peer aborts; nothing to undo */ }
  }

  KonnectAgent.configureMembers({
    methods: {
      AuthorizePush: { inSignature: 'o', outSignature: 's' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  });

  const agent = new KonnectAgent(`${OBEX}.Agent1`);

  async function watchTransfer(transferPath, target) {
    const bus = sessionBus();
    const props = await getInterface(bus, OBEX, transferPath, 'org.freedesktop.DBus.Properties');
    const onChanged = async (iface, changed) => {
      const c = unwrap(changed);
      if (c.Status !== 'complete') return;
      props.off('PropertiesChanged', onChanged);
      try {
        const text = await fs.readFile(target, 'utf8');
        const cards = parseVCards(text);
        const fresh = cards.filter((c) => !seen.has(c.uid));
        for (const c of fresh) seen.add(c.uid);
        if (fresh.length) emitter.emit(fresh);
      } catch (err) {
        console.error('failed to read pushed vcard:', err.message);
      } finally {
        await fs.unlink(target).catch(() => {});
      }
    };
    props.on('PropertiesChanged', onChanged);
  }

  return {
    async start() {
      const bus = sessionBus();
      if (!agentRegistered) {
        bus.export(AGENT_PATH, agent);
        const mgr = await getInterface(bus, OBEX, '/org/bluez/obex', 'org.bluez.obex.AgentManager1');
        await mgr.RegisterAgent(AGENT_PATH);
        agentRegistered = true;
      }
      seen.clear();
      active = true;
    },

    async cancel() {
      active = false;
      if (!agentRegistered) return;
      try {
        const bus = sessionBus();
        const mgr = await getInterface(bus, OBEX, '/org/bluez/obex', 'org.bluez.obex.AgentManager1');
        await mgr.UnregisterAgent(AGENT_PATH);
        bus.unexport(AGENT_PATH, agent);
      } catch { /* already gone */ }
      agentRegistered = false;
    },

    onContacts(cb) { return emitter.on(cb); },
  };
}

module.exports = { isAcceptableTransfer, createOppReceiver };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/opp-guard.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire OPP into `src/main/backend/linux/index.js`**

Add `const { createOppReceiver } = require('./opp');`, create `const opp = createOppReceiver({ mac });`, and replace the three stubs:

```js
    startContactImport: () => opp.start(),
    cancelContactImport: () => opp.cancel(),
    onContacts: (cb) => opp.onContacts(cb),
```

- [ ] **Step 6: Persist imported contacts in `src/main/ipc.js`**

Replace the `backend.onContacts` line in `registerIpc` so imports reach the store:

```js
  backend.onContacts((list) => {
    const result = store.upsertContacts(list);
    broadcast('contacts:changed', { contacts: store.listContacts(), result });
  });
```

- [ ] **Step 7: Replace the contacts section in `src/renderer/index.html`**

```html
<section id="view-contacts" class="view">
  <h1>Contacts</h1>
  <div class="import-box">
    <button id="ct-import" class="primary">Import from handset</button>
    <button id="ct-cancel" hidden>Cancel</button>
    <ol id="ct-steps" hidden>
      <li>On the JioPhone open <strong>Contacts</strong></li>
      <li>Choose <strong>Options - Share / Send via Bluetooth</strong></li>
      <li>Select <strong>this PC</strong> as the destination</li>
    </ol>
    <p id="ct-result" class="muted"></p>
  </div>
  <input id="ct-search" placeholder="Search contacts" autocomplete="off">
  <table id="contacts-table">
    <thead><tr><th>Name</th><th>Number</th><th></th></tr></thead>
    <tbody id="contacts-body"></tbody>
  </table>
  <div id="contacts-empty" class="empty" hidden>
    <p><strong>No contacts yet.</strong></p>
    <p class="muted">
      The handset does not allow the PC to pull its phonebook, so contacts are
      sent from the phone instead. Use Import from handset above.
    </p>
  </div>
</section>
```

- [ ] **Step 8: Append contacts styles to `src/renderer/styles.css`**

```css
.import-box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; max-width: 560px; margin-bottom: 20px; }
.import-box ol { margin: 14px 0 0; padding-left: 20px; color: var(--muted); line-height: 1.9; }
#ct-search { width: 100%; max-width: 360px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: inherit; }
```

- [ ] **Step 9: Append contacts logic to `src/renderer/app.js`**

```js
// ---- contacts -----------------------------------------------------------
let allContacts = [];

function drawContacts() {
  const q = $('#ct-search').value.trim().toLowerCase();
  const rows = q
    ? allContacts.filter((c) =>
        c.name.toLowerCase().includes(q) || c.number_e164.includes(q))
    : allContacts;

  const body = $('#contacts-body');
  body.innerHTML = '';
  for (const c of rows) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = c.name;
    const num = document.createElement('td');
    num.textContent = c.number_e164;
    const act = document.createElement('td');
    const callBtn = document.createElement('button');
    callBtn.textContent = 'Call';
    callBtn.addEventListener('click', () => {
      $('#d-number').value = c.number_e164;
      showView('dialer');
    });
    act.append(callBtn);
    tr.append(name, num, act);
    body.append(tr);
  }
  const empty = allContacts.length === 0;
  $('#contacts-empty').hidden = !empty;
  $('#contacts-table').hidden = empty;
}

async function loadContacts() {
  allContacts = await window.konnect.listContacts();
  drawContacts();
}

$('#ct-search').addEventListener('input', drawContacts);

$('#ct-import').addEventListener('click', async () => {
  await window.konnect.importContacts();
  $('#ct-steps').hidden = false;
  $('#ct-cancel').hidden = false;
  $('#ct-import').disabled = true;
  $('#ct-result').textContent = 'Waiting for the handset to send contacts...';
});

$('#ct-cancel').addEventListener('click', async () => {
  await window.konnect.cancelImport();
  $('#ct-steps').hidden = true;
  $('#ct-cancel').hidden = true;
  $('#ct-import').disabled = false;
  $('#ct-result').textContent = '';
});

window.konnect.onContacts(({ contacts, result }) => {
  allContacts = contacts;
  drawContacts();
  $('#ct-result').textContent =
    `Imported ${result.added} new and updated ${result.updated} existing contacts.`;
});
```

Extend the nav handler to load contacts on entry:

```js
    if (b.dataset.view === 'contacts') loadContacts();
```

- [ ] **Step 10: Verify against the handset**

Run: `npm start`, open Contacts, click Import from handset, then send a contact from the JioPhone over Bluetooth.
Expected: the contact appears in the table and the result line reports the counts. Send the same contact twice; the second time reports `0 new, 1 updated`. Capture one real `.vcf` from the staging directory and add it as a fixture to `test/vcard.test.js` if its encoding differs from the assumptions in Task 3.

- [ ] **Step 11: Commit**

```bash
git add src/main/backend/linux/opp.js src/main/backend/linux/index.js src/main/ipc.js src/renderer test/opp-guard.test.js
git commit -m "feat: contacts import over obex object push with trust boundary"
```

---

### Task 14a: Recording toggle must not gate the stop path

Found by probe, not by a review: this fell between Task 7 (settings UI), Task 9
(call session) and Task 12 (recording), so no single task owned it.

`src/main/index.js:151` places the `record_calls` guard ABOVE the phase branch:

```js
onRecord: async ({ phase, call }) => {
  if (store.getSetting('record_calls') !== 'true') return;   // gates BOTH phases
```

So it gates `stop` as well as `start`. If the user switches recording off while
a call is running - exactly what a master toggle invites - the running
`pw-record` is never stopped. It keeps capturing handset audio AFTER the user
turned recording off, the WAV is never encoded or attached, and the process
survives until `recorder.dispose()` at app quit. That is a privacy defect, not
just a leak. Verified by driving the real handler: `startRecording` called for
`call-1`, `stopRecording` called for nothing.

**Files:**
- Create: `src/main/recording-policy.js`, `test/recording-policy.test.js`
- Modify: `src/main/index.js`, `src/main/backend/mock/index.js`

- [ ] **Step 1: Extract the handler so the policy can be tested at all**

It is currently inline in `src/main/index.js`, which cannot be required without
booting Electron. Create `src/main/recording-policy.js`:

```js
'use strict';

// The record_calls setting gates STARTING a recording, never stopping one.
// A recorder already running must always be stopped: gating 'stop' too means
// that switching recording off mid-call leaves pw-record capturing audio the
// user has just asked not to capture, with the file never encoded or attached.
function createRecordHandler({ store, backend, attachRecording }) {
  return async ({ phase, call }) => {
    if (phase === 'start' && store.getSetting('record_calls') !== 'true') return;
    try {
      if (phase === 'start') {
        await backend.startRecording(call.id);
      } else {
        const finalPath = await backend.stopRecording(call.id);
        if (finalPath) attachRecording(call.id, finalPath);
      }
    } catch (err) {
      console.error('recording failed:', err.message);
    }
  };
}

module.exports = { createRecordHandler };
```

In `src/main/index.js` replace the inline `onRecord` with:

```js
    onRecord: createRecordHandler({
      store, backend, attachRecording: (id, p) => callSession.attachRecording(id, p),
    }),
```

The `attachRecording` indirection is deliberate: `callSession` is still being
assigned when the handler is built, so it must be reached lazily.

- [ ] **Step 2: Make the mock honour the real backend's null contract**

`src/main/backend/mock/index.js` returns a fabricated path from
`stopRecording` unconditionally, while the real `recorder.stop()` returns
`null` when nothing was recording for that call. Once Step 1 lets `stop` run
for un-recorded calls, that divergence writes a phantom `recording_path` into
the call log for every call made with recording off - and Task 14 then exports
it as a recording that does not exist.

```js
    // Mirrors recorder.stop(): null when nothing was recording for this call.
    async startRecording(callId) { recorded.add(callId); return `/tmp/konnect-mock-${callId}.wav`; },
    async stopRecording(callId) {
      return recorded.delete(callId) ? `/tmp/konnect-mock-${callId}.opus` : null;
    },
```

with `const recorded = new Set();` beside the existing `timers` set, and
`recorded.clear()` in `dispose()`.

- [ ] **Step 3: Write the regression test**

`test/recording-policy.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createRecordHandler } = require('../src/main/recording-policy');

function harness(initial) {
  const calls = { started: [], stopped: [], attached: [] };
  let setting = initial;
  const handler = createRecordHandler({
    store: { getSetting: () => setting },
    backend: {
      startRecording: async (id) => { calls.started.push(id); },
      stopRecording: async (id) => { calls.stopped.push(id); return `/tmp/${id}.opus`; },
    },
    attachRecording: (id, p) => calls.attached.push([id, p]),
  });
  return { handler, calls, set: (v) => { setting = v; } };
}

test('a recording started before the toggle was switched off is still stopped', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'c1' } });
  h.set('false');                              // user switches recording off mid-call
  await h.handler({ phase: 'stop', call: { id: 'c1' } });
  assert.deepStrictEqual(h.calls.stopped, ['c1'], 'recorder left running after toggle off');
  assert.deepStrictEqual(h.calls.attached, [['c1', '/tmp/c1.opus']]);
});

test('the toggle still prevents a recording from starting', async () => {
  const h = harness('false');
  await h.handler({ phase: 'start', call: { id: 'c2' } });
  assert.deepStrictEqual(h.calls.started, []);
});

test('a backend failure is logged, not thrown into the call event handler', async () => {
  const handler = createRecordHandler({
    store: { getSetting: () => 'true' },
    backend: { startRecording: async () => { throw new Error('pw-record missing'); } },
    attachRecording: () => {},
  });
  await assert.doesNotReject(() => handler({ phase: 'start', call: { id: 'c3' } }));
});
```

- [ ] **Step 4: Verify**

Run: `npm test`. Expected: all prior tests plus 3 new ones pass.

### Task 14: Export - CSV and PDF report

Spec section 8. PDF comes free from Chromium, so the report is a styled HTML page rather than a layout library.

**Files:**
- Create: `src/main/export.js`
- Modify: `src/main/ipc.js` (export channels)
- Modify: `src/main/preload.js` (expose export)
- Modify: `src/renderer/index.html` / `app.js` (export controls)
- Test: `test/export.test.js`

**Interfaces:**
- Consumes: `Store.listCalls`, `Store.listContacts`, `Store.callStats` (Task 2)
- Produces:
  - `toCsv(rows, columns) -> string` (pure)
  - `callsToCsv(rows) -> string`, `contactsToCsv(rows) -> string`, `contactsToVcf(rows) -> string`
  - `reportHtml({stats, rows, range}) -> string`
  - `writeReportPdf({html, outPath}) -> Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `test/export.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { toCsv, callsToCsv, contactsToVcf, reportHtml } = require('../src/main/export');
const { parseVCards } = require('../src/shared/vcard');

test('toCsv writes a header row and values in column order', () => {
  const out = toCsv([{ a: 1, b: 'x' }], [['a', 'A'], ['b', 'B']]);
  assert.strictEqual(out, 'A,B\r\n1,x\r\n');
});

test('fields containing commas, quotes or newlines are quoted and escaped', () => {
  const out = toCsv([{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'l1\nl2' }], [['v', 'V']]);
  assert.strictEqual(out, 'V\r\n"a,b"\r\n"say ""hi"""\r\n"l1\nl2"\r\n');
});

test('null and undefined become empty fields, not the string null', () => {
  assert.strictEqual(toCsv([{ v: null }, { v: undefined }], [['v', 'V']]), 'V\r\n\r\n\r\n');
});

test('a leading formula character is neutralised', () => {
  // Spreadsheet formula injection: a pushed contact name could start with =
  const out = toCsv([{ v: '=1+1' }, { v: '+cmd' }, { v: '-x' }, { v: '@y' }], [['v', 'V']]);
  assert.strictEqual(out, "V\r\n'=1+1\r\n'+cmd\r\n'-x\r\n'@y\r\n");
});

test('callsToCsv labels a missed call distinctly', () => {
  const csv = callsToCsv([
    { direction: 'in', started_at: null, ended_at: '2026-09-01T12:00:00Z', number_e164: '+911', name: null, duration_s: 0, recording_path: null },
    { direction: 'out', started_at: '2026-09-01T12:00:00Z', ended_at: '2026-09-01T12:01:00Z', number_e164: '+912', name: 'Amit', duration_s: 60, recording_path: null },
  ]);
  assert.match(csv, /Missed/);
  assert.match(csv, /Outgoing/);
});

test('contactsToVcf emits one card per contact', () => {
  const vcf = contactsToVcf([
    { name: 'Amit', number_e164: '+919876543210' },
    { name: 'Priya', number_e164: '+919812345678' },
  ]);
  assert.strictEqual((vcf.match(/BEGIN:VCARD/g) || []).length, 2);
  assert.match(vcf, /FN:Amit/);
  assert.match(vcf, /TEL;TYPE=CELL:\+919876543210/);
});

test('a newline in a contact name cannot inject a second vCard property', () => {
  // Names come from the handset over OPP. Unescaped, this adds a TEL that
  // sorts ahead of the real number in any address book the file is imported
  // into. Round-tripped through our own parser: one number, the real one.
  const vcf = contactsToVcf([
    { name: 'Ann\r\nTEL;TYPE=CELL:+99999999', number_e164: '+919812345678' },
  ]);
  assert.strictEqual((vcf.match(/^TEL/gm) || []).length, 1, 'extra TEL injected');
  const [card] = parseVCards(vcf);
  assert.deepStrictEqual(card.numbers, ['+919812345678']);
});

test('structural characters in a name are escaped, not emitted raw', () => {
  const vcf = contactsToVcf([{ name: 'Doe;John, Jr\\', number_e164: '+911' }]);
  assert.match(vcf, /FN:Doe\\;John\\, Jr\\\\/);
});

test('reportHtml escapes contact names so a pushed name cannot inject markup', () => {
  const html = reportHtml({
    stats: { total: 1, in: 1, out: 0, missed: 0, talkTimeSeconds: 60, topContacts: [{ name: '<img src=x onerror=alert(1)>', number: '+911', count: 1 }] },
    rows: [],
    range: { from: null, to: null },
  });
  assert.ok(!html.includes('<img src=x'), 'raw markup leaked into the report');
  assert.match(html, /&lt;img/);
});

test('reportHtml includes the headline figures', () => {
  const html = reportHtml({
    stats: { total: 4, in: 1, out: 3, missed: 1, talkTimeSeconds: 210, topContacts: [] },
    rows: [], range: { from: '2026-08-01', to: '2026-09-01' },
  });
  assert.match(html, /Total calls/);
  assert.match(html, />4</);
  assert.match(html, /2026-08-01/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/export.test.js`
Expected: FAIL - `Cannot find module '../src/main/export'`

- [ ] **Step 3: Write `src/main/export.js`**

```js
'use strict';

// A field beginning with = + - @ is interpreted as a formula by Excel and
// LibreOffice. Contact names arrive from the handset, so neutralise them.
function csvField(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const head = columns.map(([, label]) => csvField(label)).join(',');
  const body = rows.map((row) => columns.map(([key]) => csvField(row[key])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

function directionLabel(row) {
  if (row.direction === 'in' && !row.started_at) return 'Missed';
  return row.direction === 'in' ? 'Incoming' : 'Outgoing';
}

function callsToCsv(rows) {
  const decorated = rows.map((r) => ({ ...r, kind: directionLabel(r) }));
  return toCsv(decorated, [
    ['kind', 'Direction'], ['name', 'Name'], ['number_e164', 'Number'],
    ['started_at', 'Started'], ['ended_at', 'Ended'],
    ['duration_s', 'Duration (s)'], ['recording_path', 'Recording'],
  ]);
}

function contactsToCsv(rows) {
  return toCsv(rows, [['name', 'Name'], ['number_e164', 'Number'], ['type', 'Type']]);
}

// RFC 2426 2.4.2: backslash, comma, semicolon and newlines are STRUCTURAL in
// a vCard text value and must be escaped. Contact names arrive from the
// handset over OPP, so an unescaped name is an injection vector rather than a
// formatting nicety. Measured against our own parser: a contact named
// "Ann\r\nTEL;TYPE=CELL:+99999999" round-trips as a card carrying TWO numbers,
// with the injected one FIRST - so it becomes the primary number when the file
// is imported into another address book. Backslash must be replaced first or
// it re-escapes the escapes added after it.
function vcardText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function contactsToVcf(rows) {
  return rows.map((c) => [
    'BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardText(c.name)}`,
    `TEL;TYPE=CELL:${vcardText(c.number_e164)}`, 'END:VCARD',
  ].join('\r\n')).join('\r\n') + '\r\n';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function hms(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function reportHtml({ stats, rows, range }) {
  const period = range.from || range.to
    ? `${esc(range.from || 'start')} to ${esc(range.to || 'today')}`
    : 'All time';

  const tiles = [
    ['Total calls', stats.total], ['Incoming', stats.in], ['Outgoing', stats.out],
    ['Missed', stats.missed], ['Talk time', hms(stats.talkTimeSeconds)],
  ].map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  const top = stats.topContacts.map((c) =>
    `<tr><td>${esc(c.name)}</td><td>${esc(c.number)}</td><td>${esc(c.count)}</td></tr>`).join('');

  const recent = rows.slice(0, 50).map((r) =>
    `<tr><td>${esc(directionLabel(r))}</td><td>${esc(r.name || 'Unknown')}</td>` +
    `<td>${esc(r.number_e164)}</td><td>${esc(r.ended_at)}</td>` +
    `<td>${esc(r.duration_s)}s</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Konnect call report</title>
<style>
  body { font: 12px system-ui, sans-serif; color: #14161a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .period { color: #666; margin-bottom: 20px; }
  .tiles { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .tile { border: 1px solid #ddd; border-radius: 8px; padding: 10px 14px; min-width: 110px; }
  .tile span { display: block; color: #666; font-size: 10px; text-transform: uppercase; }
  .tile strong { font-size: 17px; }
  h2 { font-size: 14px; margin: 22px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
  th { color: #666; font-size: 10px; text-transform: uppercase; }
</style></head><body>
<h1>Konnect call report</h1>
<div class="period">${period}</div>
<div class="tiles">${tiles}</div>
<h2>Top contacts</h2>
<table><thead><tr><th>Name</th><th>Number</th><th>Calls</th></tr></thead><tbody>${top}</tbody></table>
<h2>Recent calls</h2>
<table><thead><tr><th>Direction</th><th>Name</th><th>Number</th><th>When</th><th>Duration</th></tr></thead><tbody>${recent}</tbody></table>
</body></html>`;
}

// Electron-only: renders the report in an offscreen window and prints to PDF.
async function writeReportPdf({ html, outPath }) {
  const { BrowserWindow } = require('electron');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  // Chromium blocks top-level navigation to a data: URL. Measured on the
  // Electron in this repo: data: + offscreen HAPPENS to load, but data: +
  // show:false fails outright with ERR_FAILED - so the planned version was
  // leaning on an offscreen quirk to bypass a deliberate security block, and
  // an Electron upgrade could close it. loadFile works in BOTH window modes.
  // It also avoids encodeURIComponent inflating the page 2.9x for Devanagari
  // contact names, which this app expects to see.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konnect-report-'));
  const page = path.join(dir, 'report.html');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await fs.writeFile(page, html, 'utf8');
    await win.loadFile(page);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.writeFile(outPath, pdf);
    return outPath;
  } finally {
    win.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = {
  toCsv, callsToCsv, contactsToCsv, contactsToVcf, reportHtml, writeReportPdf,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/export.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add export channels to `src/main/ipc.js`**

`ipc.js` already requires `node:fs/promises` as `fs` and already has a
`writeFile(p, body)` helper that creates the parent directory first - use it
rather than calling `fs.writeFile` directly. Add to the requires:

```js
const { dialog } = require('electron');
const { callsToCsv, contactsToCsv, contactsToVcf, reportHtml, writeReportPdf } = require('./export');
```

Add to the `handlers` object:

```js
    'export:calls-csv': async () => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-calls.csv' });
      if (!filePath) return null;
      await writeFile(filePath, callsToCsv(store.listCalls({ limit: 100000 })));
      return filePath;
    },
    'export:contacts-csv': async () => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-contacts.csv' });
      if (!filePath) return null;
      await writeFile(filePath, contactsToCsv(store.listContacts()));
      return filePath;
    },
    'export:contacts-vcf': async () => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-contacts.vcf' });
      if (!filePath) return null;
      await writeFile(filePath, contactsToVcf(store.listContacts()));
      return filePath;
    },
    'export:report-pdf': async (_e, range) => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-report.pdf' });
      if (!filePath) return null;
      const opts = range || {};
      const html = reportHtml({
        stats: store.callStats(opts),
        rows: store.listCalls({ ...opts, limit: 1000 }),
        range: { from: opts.from || null, to: opts.to || null },
      });
      return writeReportPdf({ html, outPath: filePath });
    },
```

- [ ] **Step 6: Expose export in `src/main/preload.js`**

```js
  exportCallsCsv: () => ipcRenderer.invoke('export:calls-csv'),
  exportContactsCsv: () => ipcRenderer.invoke('export:contacts-csv'),
  exportContactsVcf: () => ipcRenderer.invoke('export:contacts-vcf'),
  exportReportPdf: (range) => ipcRenderer.invoke('export:report-pdf', range),
```

- [ ] **Step 7: Add export controls to the call log view**

In `src/renderer/index.html`, inside `#view-calls` after the `.filters` div:

```html
  <div class="filters">
    <button id="x-calls">Export call log (CSV)</button>
    <button id="x-report">Export report (PDF)</button>
    <button id="x-contacts">Export contacts (CSV)</button>
    <button id="x-vcf">Export contacts (vCard)</button>
  </div>
```

In `src/renderer/app.js`:

```js
// ---- export -------------------------------------------------------------
function wireExport(id, fn) {
  $(id).addEventListener('click', async () => {
    try {
      const out = await fn();
      if (out) alert(`Saved to ${out}`);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  });
}
wireExport('#x-calls', () => window.konnect.exportCallsCsv());
wireExport('#x-report', () => window.konnect.exportReportPdf(currentRange()));
wireExport('#x-contacts', () => window.konnect.exportContactsCsv());
wireExport('#x-vcf', () => window.konnect.exportContactsVcf());
```

- [ ] **Step 8: Verify end to end**

Run: `npm start`, make sure at least one call and one contact exist, then use each export button.
Expected: the CSV opens in a spreadsheet with correct columns; the PDF shows the stat tiles, top contacts and recent calls; the vCard file imports into another address book.

- [ ] **Step 9: Commit**

```bash
git add src/main/export.js src/main/ipc.js src/main/preload.js src/renderer test/export.test.js
git commit -m "feat: csv, vcard and pdf report export"
```

---

## Verification checklist

Run before calling the project done. Every item was validated against the physical handset during phase 0 or is directly derived from it.

- [ ] `npm test` passes (expected: 5 + 8 + 20 + 6 + 6 + 6 + 7 + 4 + 7 + 8 = 77 tests)
- [ ] `KONNECT_MOCK=1 npm start` runs the whole UI with no handset present
- [ ] Setup view reports all four checks green on a configured machine
- [ ] Status view shows real operator, signal and battery
- [ ] Outgoing call reaches `active` and the timer starts on answer, not on dial
- [ ] Incoming call raises a notification and window while the main window is hidden
- [ ] Answering from the PC connects the call; audio is audible both directions
- [ ] A recording has **different** audio on left and right channels (identical means the `pw-link` step silently failed)
- [ ] Call log shows the explanatory empty state on a fresh profile
- [ ] Missed calls appear as Missed, not Incoming with zero duration
- [ ] Contact import from the handset adds contacts, and a repeat import updates rather than duplicates
- [ ] All four exports produce openable files

---

## Self-review notes

**Spec coverage.** Section 2 verified capabilities drive tasks 4, 5 and 12. Section 2.2 (PBAP dead end) is enforced by Global Constraints and implemented as OPP in task 13. Section 3 architecture is task 1. Section 4 setup is task 6. Section 5 data model is task 2; 5.1 single-writer call log is task 9 plus the empty state in task 11. Section 6 contacts is task 13, with 6.4 vCard parsing pulled forward into task 3. Section 7 recording is task 12, with 7.1 and 7.2 encoded as Global Constraints. Section 8 export is task 14. Section 9 tray and background is tasks 7 and 10. Section 10 testing is distributed across every task.

**Deliberately deferred.** Contact photos (spec section 11, marked deferred there). DTMF during a held call. Multi-call and conference handling — oFono reports `three-way-calling` in `Handsfree.Features`, but the spec does not require it and the UI assumes one active call.

**Known cross-task coupling.** Task 12 depends on `onRecord` and `attachRecording` introduced in task 9; the ordering inside `callsession.js` (`onRecord` stop fires before `persist`) is what lets a recording path reach the row. Changing that order silently drops recording paths.
