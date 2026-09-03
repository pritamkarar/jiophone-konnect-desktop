const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { RECORDINGS_DIR } = require('../src/main/recordings');
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

test('a transient failure checking the cached folder id fails the pass rather than forking a duplicate', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'real-folder');
  // A working search-then-create path sits right behind the probe: if the
  // probe's 500 were mistaken for "gone", this would silently succeed and
  // hand back a duplicate folder instead of rejecting.
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/real-folder'), status: 500, body: {} },
    { match: (u) => u.includes('q=') && u.includes('files?'), status: 200, body: { files: [] } },
    { match: (u, o) => o.method === 'POST' && u.endsWith('/drive/v3/files'), status: 200, body: { id: 'duplicate-folder' } },
  ]);
  await assert.rejects(() => ensureFolder({ auth, store }));
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 0);
  assert.strictEqual(store.getSetting('google_folder_id'), 'real-folder');
  store.close();
});

test('a failed search for the folder fails the pass rather than creating blind', async () => {
  const store = openStore(':memory:');
  const auth = fakeAuth([
    { match: (u) => u.includes('files?'), status: 500, body: {} },
    { match: (u, o) => o.method === 'POST' && u.endsWith('/drive/v3/files'), status: 200, body: { id: 'blind-folder' } },
  ]);
  await assert.rejects(() => ensureFolder({ auth, store }));
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
    { match: (u) => u.includes('files?') && u.includes('q='), status: 200, body: { files: [] } },
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
    { match: (u) => u.includes('files?') && u.includes('q='), status: 200, body: { files: [] } },
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'log-2' } },
  ]);
  assert.strictEqual(await uploadLog({ auth, store, now: () => new Date() }), 'log-2');
  assert.strictEqual(store.getSetting('google_log_file_id'), 'log-2');
  store.close();
});

// I3: signOut clears google_log_file_id but the Drive file itself survives,
// so a re-sign-in with no cached id must adopt the existing call-log.json
// rather than fork a second one - the same fix Task 7 made to ensureFolder.
test('a call log found by searching the folder is adopted, not duplicated', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  // No cached google_log_file_id, e.g. right after a sign-out/sign-in cycle.
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } },
    { match: (u) => u.includes('files?') && u.includes('q='),
      status: 200, body: { files: [{ id: 'existing-log', name: LOG_FILE_NAME }] } },
  ]);
  assert.strictEqual(await uploadLog({ auth, store, now: () => new Date() }), 'existing-log');
  assert.strictEqual(store.getSetting('google_log_file_id'), 'existing-log');
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 0);
  store.close();
});

test('a failed search for the call log fails the pass rather than creating blind', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  // A working create path sits right behind the search: if a 500 were read
  // as "not found", this would silently succeed and fork a duplicate file
  // instead of rejecting - precisely the bug Task 7 fixed in ensureFolder.
  const auth = fakeAuth([
    { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } },
    { match: (u) => u.includes('files?') && u.includes('q='), status: 500, body: {} },
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'blind-log' } },
  ]);
  await assert.rejects(() => uploadLog({ auth, store, now: () => new Date() }));
  assert.strictEqual(auth.calls.filter((c) => c.method === 'POST').length, 0);
  assert.strictEqual(store.getSetting('google_log_file_id'), null);
  store.close();
});

const { uploadRecordings, createBackupRunner } = require('../src/main/google/backup');

function storeWithRecording() {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  const id = store.insertCall({ direction: 'in', number_e164: '+919000000001',
    ended_at: '2026-01-01T00:00:00Z', recording_path: 'call-1.opus' });
  return { store, id };
}

const folderOk = { match: (u) => u.includes('/files/folder-1'), status: 200, body: { id: 'folder-1', trashed: false } };
// storeWithRecording() never sets google_log_file_id, so uploadLog's
// search-before-create step (I3) always fires in these runner tests.
const logSearchEmpty = { match: (u) => u.includes('files?') && u.includes('q='), status: 200, body: { files: [] } };

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

// The fixture above stores a bare basename, but callsession writes whatever
// the recorder returns - an ABSOLUTE path under RECORDINGS_DIR. Every real
// recording therefore hit resolveRecordingPath's basename guard, threw, and
// was swallowed by the deleted-file catch, so nine recordings sat pending for
// days while each pass still reported success.
test('a recording stored by its absolute path still uploads', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_folder_id', 'folder-1');
  store.setSetting('google_backup_recordings', 'true');
  store.insertCall({ direction: 'in', number_e164: '+919000000009',
    ended_at: '2026-01-01T00:00:00Z',
    recording_path: path.join(RECORDINGS_DIR, 'call-9.opus') });
  const auth = fakeAuth([
    folderOk,
    { match: (u, o) => o.method === 'POST' && u.includes('uploadType=multipart'), status: 200, body: { id: 'rec-9' } },
  ]);
  const res = await uploadRecordings({ auth, store, readFile: async () => Buffer.from('OggS') });
  assert.strictEqual(res.uploaded, 1);
  assert.deepStrictEqual(store.pendingRecordingBackups(), []);
  store.close();
});

test('the runner records a timestamp and clears the error on success', async () => {
  const { store } = storeWithRecording();
  const auth = fakeAuth([
    folderOk,
    logSearchEmpty,
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
    logSearchEmpty,
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
    logSearchEmpty,
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

test('a disposed runner arms no timer and runNow does no work', async () => {
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
  runner.dispose();
  runner.schedule();
  assert.strictEqual(timers.length, 0, 'a disposed runner arms no timer');
  const res = await runner.runNow();
  assert.deepStrictEqual(res, { skipped: 'disposed' });
  assert.strictEqual(auth.calls.length, 0, 'a disposed runner issues no request');
  assert.strictEqual(store.getSetting('google_backup_at'), null);
  store.close();
});

test('a pass already in flight when disposed finishes quietly instead of writing or rejecting', async () => {
  const { store } = storeWithRecording();
  let release;
  const gate = new Promise((r) => { release = r; });
  const auth = fakeAuth([
    folderOk,
    logSearchEmpty,
    { match: (u, o) => o.method === 'POST', status: 200, body: { id: 'log-1' } },
  ]);
  const realFetch = auth.authedFetch;
  auth.authedFetch = async (u, o) => { await gate; return realFetch(u, o); };
  const runner = createBackupRunner({ auth, store, readFile: async () => Buffer.from('x') });
  const inFlight = runner.runNow();
  // Shutdown lands mid-request: dispose() must not make the settled promise
  // reject, and the finishing write must be skipped as if the pass never
  // completed - the next launch's retry queue picks up whatever was missed.
  runner.dispose();
  release();
  await assert.doesNotReject(inFlight);
  assert.strictEqual(store.getSetting('google_backup_at'), null,
    'a pass abandoned at shutdown must not claim a backup happened');
  store.close();
});
