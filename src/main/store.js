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
  source       TEXT NOT NULL DEFAULT 'handset',
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
  recording_path TEXT,
  recording_backup_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_ended ON calls (ended_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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

function openStore(path) {
  const db = new DatabaseSync(path);
  // node:sqlite has no pragma() helper; PRAGMAs go through exec().
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Existing rows backfill to 'handset': everything stored before Google
  // existed came off the handset over OPP.
  addColumn(db, 'contacts', 'source', `TEXT NOT NULL DEFAULT 'handset'`);
  // NULL means "not yet uploaded". That NULL is the retry queue - see spec 7.2.
  addColumn(db, 'calls', 'recording_backup_id', 'TEXT');

  const stmt = {
    insertContact: db.prepare(
      `INSERT INTO contacts (uid, name, number_e164, number_raw, type, synced_at, source)
       VALUES (@uid, @name, @number_e164, @number_raw, @type, @synced_at, @source)
       ON CONFLICT (uid, number_e164) DO UPDATE SET
         name = excluded.name, synced_at = excluded.synced_at,
         source = excluded.source`),
    // Where a handset row and a Google row share a number, the Google row
    // wins - it is the address book the user actively curates. The handset
    // row is not deleted, only outranked, so signing out restores it (see
    // deleteContactsBySource). Two unrelated handset contacts sharing a
    // number (a family landline, a shared work line) still both show,
    // exactly as before Google existed. Picking "any" Google row per number
    // (a plain EXISTS) is not enough: People genuinely produces two Google
    // rows on one number - the same person under two labels, or a merged
    // duplicate - and those must still collapse to one, so the surviving id
    // is pinned to the lowest-id Google row when one exists, else to the
    // row itself (COALESCE falls through to c.id, keeping every non-Google
    // row when no Google row claims that number).
    listContacts: db.prepare(
      `SELECT id, uid, name, number_e164, number_raw, type, source
       FROM contacts c
       WHERE c.id = COALESCE(
         (SELECT g.id FROM contacts g
          WHERE g.number_e164 = c.number_e164 AND g.source = 'google'
          ORDER BY g.id LIMIT 1),
         c.id)
       ORDER BY name COLLATE NOCASE, number_e164`),
    // Google first, then the original first-synced-wins tie-break within a source.
    findByNumber: db.prepare(
      `SELECT id, name FROM contacts WHERE number_e164 = ?
       ORDER BY (source = 'google') DESC, id LIMIT 1`),
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
    deleteBySource: db.prepare(`DELETE FROM contacts WHERE source = ?`),
    // Captured BEFORE the DELETE below, while contact_id still points at the
    // row about to be removed: exactly the calls this particular delete is
    // about to orphan via ON DELETE SET NULL. Scoping the repair to this set
    // (rather than to every call with contact_id IS NULL) matters because
    // insertCall freezes contact_id at call time - a call from a number with
    // no contact stays nameless even after that contact is later imported.
    // A blanket "WHERE contact_id IS NULL" repair would retroactively
    // resolve THAT call too, on the next unrelated deleteContactsBySource
    // call, even one that deletes zero rows - so whether an old call shows a
    // name would depend on whether the user happened to sign out of Google
    // afterwards. Scoping to ids captured pre-delete makes the repair touch
    // only what this delete actually orphaned.
    callsBySourceContact: db.prepare(
      `SELECT c.id FROM calls c JOIN contacts ct ON ct.id = c.contact_id
       WHERE ct.source = ?`),
    pendingRecordings: db.prepare(
      `SELECT id, recording_path FROM calls
       WHERE recording_path IS NOT NULL AND recording_backup_id IS NULL
       ORDER BY id`),
    markBackedUp: db.prepare(`UPDATE calls SET recording_backup_id = ? WHERE id = ?`),
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
    upsertContacts(contacts, source = 'handset') {
      const synced_at = new Date().toISOString();
      let added = 0;
      let updated = 0;
      // node:sqlite has no transaction() helper; drive it with exec().
      db.exec('BEGIN');
      try {
        for (const c of contacts) {
          // The loop variable is the NORMALISED number; c.raw[i] is the
          // handset's original formatting of that same number. Binding c.raw
          // itself here bound an ARRAY, which node:sqlite refuses - every real
          // import threw "cannot be bound to SQLite parameter 4" and the error
          // was swallowed upstream, so contacts import could never succeed.
          // It passed every test only because the tests hand-write card
          // literals with no `raw` at all, a shape the parser never emits.
          for (const [i, number] of c.numbers.entries()) {
            const existing = stmt.findByUidAndNumber.get(c.uid, number);
            stmt.insertContact.run({
              uid: c.uid, name: c.name, number_e164: number,
              number_raw: c.raw?.[i] ?? number, type: c.type || null, synced_at,
              source,
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

    deleteContactsBySource(source) {
      db.exec('BEGIN');
      try {
        const orphaned = stmt.callsBySourceContact.all(source).map((r) => r.id);
        const result = stmt.deleteBySource.run(source);
        if (orphaned.length) {
          // Re-resolve only the ids captured above, Google-first by
          // number_e164 - same order findByNumber uses - so a call that
          // just lost its Google contact falls back to the surviving
          // handset contact on that number. node:sqlite has no array
          // binding, so the placeholder list is built to size; the ids
          // themselves are still bound as params, never interpolated.
          const placeholders = orphaned.map(() => '?').join(',');
          db.prepare(
            `UPDATE calls SET contact_id = (
               SELECT id FROM contacts WHERE number_e164 = calls.number_e164
               ORDER BY (source = 'google') DESC, id LIMIT 1)
             WHERE id IN (${placeholders})`
          ).run(...orphaned);
        }
        db.exec('COMMIT');
        return Number(result.changes);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

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
      // Group by contact where one is known, else by number. contacts.id is
      // a per-(uid, number_e164) row id - a two-number contact has two such
      // rows, so grouping by contact_id still splits it. ct.uid is what's
      // actually shared across a contact's numbers, so group by that
      // instead; grouping by number alone (or by contact_id) splits a
      // two-number contact into two leaderboard rows with halved counts -
      // silently wrong for exactly the contact shape upsertContacts
      // explicitly supports.
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

    // The whole log, for the Drive backup. listCalls() defaults to limit 200;
    // passing that default would upload only the 200 most recent calls and
    // report success. SQLite treats a negative LIMIT as unbounded.
    listAllCalls() { return this.listCalls({ limit: -1 }); },

    pendingRecordingBackups() { return stmt.pendingRecordings.all(); },

    markRecordingBackedUp(id, fileId) { stmt.markBackedUp.run(fileId, id); },

    close() { db.close(); },
  };
}

module.exports = { openStore };
