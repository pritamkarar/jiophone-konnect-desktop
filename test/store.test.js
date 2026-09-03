// Pin the zone before anything constructs a Date. The local-day filter test
// below is only meaningful under a non-UTC offset: on a UTC machine a 02:00
// local call stores as 02:00Z the same day, so the assertion holds against the
// broken code too and the test silently stops discriminating on CI.
process.env.TZ = 'Asia/Kolkata';

const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');
const { parseVCards } = require('../src/shared/vcard');

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

test('a call in the early hours of a local day stays on that day', () => {
  const s = fresh();
  // 02:00 local. In any positive-offset zone this is stored as the PREVIOUS
  // day in UTC, which is exactly what the naive text comparison got wrong.
  const local = new Date('2026-09-01T02:00:00');
  s.insertCall({ direction: 'out', number_e164: '+919876543210',
    started_at: local.toISOString(), ended_at: local.toISOString(),
    duration_s: 60, recording_path: null });
  assert.strictEqual(s.listCalls({ from: '2026-09-01', to: '2026-09-01' }).length, 1);
  assert.strictEqual(s.listCalls({ from: '2026-08-31', to: '2026-08-31' }).length, 0);
  s.close();
});

test('a different contact claiming a number already on file is added, not updated', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'a', name: 'Amit', numbers: ['+919876543210'] }]);
  const r = s.upsertContacts([{ uid: 'z', name: 'Zara', numbers: ['+919876543210'] }]);
  assert.deepStrictEqual(r, { added: 1, updated: 0 });
  assert.strictEqual(s.listContacts().length, 2);
  s.close();
});

test('callStats.topContacts merges a contact\'s multiple numbers into one row', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'a', name: 'Amit', numbers: ['+919876543210', '+919800000000'] }]);
  s.insertCall({ direction: 'out', number_e164: '+919876543210', started_at: '2026-09-01T12:00:00+05:30', ended_at: '2026-09-01T12:01:00+05:30', duration_s: 60, recording_path: null });
  s.insertCall({ direction: 'out', number_e164: '+919876543210', started_at: '2026-09-01T12:00:00+05:30', ended_at: '2026-09-01T12:01:00+05:30', duration_s: 60, recording_path: null });
  s.insertCall({ direction: 'out', number_e164: '+919800000000', started_at: '2026-09-01T12:00:00+05:30', ended_at: '2026-09-01T12:01:00+05:30', duration_s: 60, recording_path: null });
  const st = s.callStats({});
  const amit = st.topContacts.filter((c) => c.name === 'Amit');
  assert.strictEqual(amit.length, 1);
  assert.strictEqual(amit[0].count, 3);
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

test('anonymous calls are excluded from top contacts but still counted', () => {
  const s = openStore(':memory:');
  for (let i = 0; i < 3; i += 1) {
    s.insertCall({ direction: 'in', number_e164: 'unknown', started_at: '2026-09-01T12:00:00Z',
      ended_at: '2026-09-01T12:01:00Z', duration_s: 60, recording_path: null });
  }
  s.insertCall({ direction: 'out', number_e164: '+919876543210', started_at: '2026-09-01T12:00:00Z',
    ended_at: '2026-09-01T12:00:30Z', duration_s: 30, recording_path: null });
  const stats = s.callStats({});
  assert.strictEqual(stats.total, 4, 'anonymous calls still count in totals');
  assert.deepStrictEqual(stats.topContacts.map((c) => c.number), ['+919876543210']);
  s.close();
});

// Every other upsertContacts test in this file hand-writes a card literal.
// That is the mock's shape, not the parser's: the parser also emits `raw`, as
// an ARRAY, which node:sqlite refuses to bind. Real imports threw
// "cannot be bound to SQLite parameter 4", opp.js swallowed it, and contacts
// import could never succeed while the whole suite stayed green. This test
// exists specifically to exercise the shape the handset actually produces.
test('a card straight from the vCard parser can be stored', () => {
  const s = fresh();
  const cards = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Amit Sharma',
    'TEL;CELL:+91 98765 43210', 'END:VCARD', '',
  ].join('\r\n'));
  assert.strictEqual(cards.length, 1, 'parser produced no card');

  assert.deepStrictEqual(s.upsertContacts(cards), { added: 1, updated: 0 });
  const [row] = s.listContacts();
  assert.strictEqual(row.name, 'Amit Sharma');
  assert.strictEqual(row.number_e164, '+919876543210');
  s.close();
});

test('number_raw keeps the handset formatting of its own number', () => {
  const s = fresh();
  // The middle TEL duplicates the first after normalisation and the parser
  // drops it, so an index-matched raw is only correct if the parser keeps the
  // two arrays parallel - it previously did not, and raw[1] then described a
  // different number than numbers[1].
  const cards = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Amit',
    'TEL;CELL:+91 98765 43210', 'TEL;HOME:09876543210', 'TEL;WORK:+919812345678',
    'END:VCARD', '',
  ].join('\r\n'));
  const [card] = cards;
  assert.strictEqual(card.numbers.length, card.raw.length, 'numbers/raw desynced');

  s.upsertContacts(cards);
  const rows = s.listContacts().sort((a, b) => a.number_e164.localeCompare(b.number_e164));
  assert.deepStrictEqual(rows.map((r) => r.number_e164), ['+919812345678', '+919876543210']);
  s.close();
});

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

test('two google contacts sharing a number collapse to one row; two handset contacts sharing a number still both show', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'google:people/a', name: 'Amma', numbers: ['+919876543210'] }], 'google');
  s.upsertContacts([{ uid: 'google:people/b', name: 'Amma (work)', numbers: ['+919876543210'] }], 'google');
  const googleRows = s.listContacts().filter((r) => r.number_e164 === '+919876543210');
  assert.strictEqual(googleRows.length, 1, 'two google rows on one number must collapse to one');

  s.upsertContacts([{ uid: 'h1', name: 'Amit', numbers: ['+919812345678'] }]);
  s.upsertContacts([{ uid: 'h2', name: 'Zara', numbers: ['+919812345678'] }]);
  const handsetRows = s.listContacts().filter((r) => r.number_e164 === '+919812345678');
  assert.strictEqual(handsetRows.length, 2, 'two handset rows on one number must both still show');
  s.close();
});

test('deleting a google contact re-points its calls to the surviving handset contact on the same number', () => {
  const s = fresh();
  s.upsertContacts([{ uid: 'h1', name: 'Mom', numbers: ['+919876543210'] }]);
  s.upsertContacts([{ uid: 'google:people/c1', name: 'Amma', numbers: ['+919876543210'] }], 'google');
  s.insertCall({ direction: 'in', number_e164: '+919876543210', ended_at: '2026-01-01T00:00:00Z' });
  s.insertCall({ direction: 'in', number_e164: '+919000000099', ended_at: '2026-01-01T00:01:00Z' });
  const byNumber = (n) => s.listCalls().find((c) => c.number_e164 === n);
  assert.strictEqual(byNumber('+919876543210').name, 'Amma');

  s.deleteContactsBySource('google');
  assert.strictEqual(byNumber('+919876543210').name, 'Mom', 'call orphaned by the delete must fall back to the surviving contact');
  assert.strictEqual(byNumber('+919000000099').name, null, 'a call whose number never had a contact stays nameless');
  s.close();
});

test('deleteContactsBySource never touches a call it did not orphan', () => {
  const s = fresh();
  // 1. A call from a number with no contact yet - contact_id is frozen null.
  s.insertCall({ direction: 'in', number_e164: '+919111111111', ended_at: '2026-01-01T00:00:00Z' });
  // 2. Importing a contact for that number afterwards does not retroactively
  // attribute the call - insertCall already ran. Existing, pre-task contract.
  s.upsertContacts([{ uid: 'later', name: 'Later Added', numbers: ['+919111111111'] }]);
  assert.strictEqual(s.listCalls()[0].name, null);
  // 3. An unrelated google sign-out that deletes nothing must not repair it either -
  // the call was never orphaned by any delete, so it must stay exactly as it was.
  assert.strictEqual(s.deleteContactsBySource('google'), 0);
  assert.strictEqual(s.listCalls()[0].name, null);
  s.close();
});
