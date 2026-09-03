'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { resolveRecordingPath } = require('../recordings');

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'JioPhone Konnect';
const LOG_FILE_NAME = 'call-log.json';
const RECORDING_MIME = { '.opus': 'audio/ogg', '.wav': 'audio/wav' };
const BACKUP_DEBOUNCE_MS = 5000;

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
//
// Only a genuine 404 or trashed:true means "gone, recreate" at either the
// probe or the search step. Any other non-ok response (a transient 5xx) is
// NOT proof the folder is gone - it throws instead, so the pass fails and
// retries later rather than abandoning a perfectly good folder for a
// duplicate. A Drive outage must make backup fail and retry, never fork data.
async function ensureFolder({ auth, store }) {
  const cached = store.getSetting('google_folder_id');
  if (cached) {
    const res = await auth.authedFetch(
      `${DRIVE_FILES}/${encodeURIComponent(cached)}?fields=id,trashed`);
    if (res.ok) {
      const folder = await res.json();
      if (!folder.trashed) return cached;
      // trashed: the user deleted it. Fall through and make a new one.
    } else if (res.status !== 404) {
      throw new Error(`could not check the Drive folder (${res.status})`);
    }
    // 404: the user deleted it. Fall through and make a new one rather than
    // failing every backup from here on.
  }

  const q = `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const search = await auth.authedFetch(
    `${DRIVE_FILES}?${new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' })}`);
  if (!search.ok) throw new Error(`could not search for the Drive folder (${search.status})`);
  const found = (await search.json()).files?.[0];
  if (found) { store.setSetting('google_folder_id', found.id); return found.id; }

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
  // Compact, not pretty-printed: the payload is machine-read (this test file's
  // own parser locates it by scanning for the literal `{"exportedAt"` prefix),
  // never hand-edited in Drive.
  const body = Buffer.from(JSON.stringify({
    exportedAt: now().toISOString(),
    account: store.getSetting('google_account') || null,
    calls: store.listAllCalls(),
  }));

  const patchExisting = (id) => auth.authedFetch(
    `${DRIVE_UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });

  const cached = store.getSetting('google_log_file_id');
  if (cached) {
    const res = await patchExisting(cached);
    if (res.ok) return cached;
    if (res.status !== 404) throw new Error(`call-log upload failed (${res.status})`);
    // 404: the user deleted it in Drive. Fall through to search/create.
  }

  // Search before create - mirrors ensureFolder (Task 7). A sign-out clears
  // google_log_file_id but leaves the Drive file itself in place, so with no
  // cached id every pass here used to create unconditionally, forking a new
  // call-log.json each sign-out/sign-in cycle. Scoped to the folder and
  // trashed=false so it can only ever find OUR file.
  //
  // Only an ok response with no match may proceed to create. A non-ok
  // response is NOT "not found" - it throws instead, so the pass fails and
  // retries later rather than treating a transient 500 as license to fork a
  // duplicate, which is exactly the bug Task 7 fixed in ensureFolder.
  const q = `name='${LOG_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
  const search = await auth.authedFetch(
    `${DRIVE_FILES}?${new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' })}`);
  if (!search.ok) throw new Error(`could not search for the call log (${search.status})`);
  const found = (await search.json()).files?.[0];
  if (found) {
    store.setSetting('google_log_file_id', found.id);
    // Adopting only the id (no immediate PATCH) mirrors ensureFolder exactly;
    // this pass's fresh body reaches Drive on the very next pass, which is
    // always close behind (call-end schedule(), a manual sync, or the
    // detached post-sign-in backup) and never more than one pass stale.
    return found.id;
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
    // The BASENAME, not the stored value. recording_path is the recorder's
    // absolute path, while resolveRecordingPath only accepts a bare name -
    // it is a traversal guard written for renderer input. Handing it the
    // full path threw straight into the catch below, which reads that as
    // "the user deleted the file", so every real recording was skipped on
    // every pass while the pass still reported success. The renderer's
    // playback path basenames it for exactly the same reason.
    const name = path.basename(row.recording_path);
    let data;
    try {
      data = await readFile(resolvePath(name));
    } catch (err) {
      // Genuinely deleted or moved files are left pending deliberately: if
      // one comes back from a filesystem backup it gets uploaded, and one
      // missing file must not stop the recordings after it. Logged, because
      // silence here is what hid the bug above for nine recordings.
      console.warn(`[konnect] recording not backed up (${name}): ${err.message}`);
      continue;
    }
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
  // Flipped by dispose() at shutdown. store.close() runs shortly after it,
  // so a pass still in flight at that point must not touch the store again -
  // a write against a closed database throws "statement has been finalized",
  // which would otherwise reach the .catch below and throw a second time out
  // of setError, as an unhandled rejection nothing is awaiting.
  let stopped = false;

  async function pass() {
    const logFileId = await uploadLog({ auth, store, now });
    const recordings = await uploadRecordings({ auth, store, readFile, resolvePath });
    // Abandoned at quit: the next launch's pendingRecordingBackups()/cached
    // ids pick up exactly where this one left off, so skipping the finishing
    // write here loses nothing but a stale timestamp.
    if (stopped) return { logFileId, recordingsUploaded: recordings.uploaded };
    // Written only after both halves succeeded, so Settings never claims a
    // backup that did not happen.
    store.setSetting('google_backup_at', now().toISOString());
    auth.clearError?.();
    return { logFileId, recordingsUploaded: recordings.uploaded };
  }

  async function runNow() {
    if (stopped) return { skipped: 'disposed' };
    if (!auth.isSignedIn()) return { skipped: 'signed-out' };
    // One pass at a time: two would race on recording_backup_id and upload the
    // same audio twice.
    if (inFlight) return inFlight;
    inFlight = pass()
      .catch((err) => {
        if (stopped) return { skipped: 'disposed' };
        auth.setError?.(err.message);
        return { error: err.message };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  // Calls ending back to back are one pass, not one each.
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeoutImpl(() => { timer = null; return runNow(); }, delayMs);
    timer.unref?.();
  }

  // Called from before-quit, synchronously and before store.close(). Never
  // awaits the network - that would delay quit by up to a request timeout,
  // worse than the bug it fixes. It only makes an in-flight pass harmless.
  function dispose() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    runNow, schedule, dispose,
  };
}

module.exports = {
  DRIVE_FILES, DRIVE_UPLOAD, FOLDER_NAME, LOG_FILE_NAME,
  multipartBody, createFile, ensureFolder, uploadLog,
  uploadRecordings, createBackupRunner,
};
