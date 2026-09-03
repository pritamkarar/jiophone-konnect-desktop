'use strict';
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');

// This literal is duplicated in src/main/backend/linux/recorder.js's
// createRecorder({ outputDir }) default - there is no shared constant
// between main and the linux backend, and recorder.js is under a standing
// constraint not to be touched from here. The two must stay in step: drift
// between them silently 404s playback, since this module resolves recording
// paths against RECORDINGS_DIR while the recorder writes files wherever its
// own default points.
const RECORDINGS_DIR = path.join(os.homedir(), 'Konnect', 'recordings');

// The renderer asks for a recording by BASENAME only. recording_path comes out
// of the database, so treating it as a filesystem path without a guard is a
// traversal sink. Three independent checks: it must be a string, it must be
// its own basename (kills separators, absolute paths and ../x), and it must
// still resolve inside the directory (kills bare ".." and ".", whose basename
// is themselves).
function resolveRecordingPath(name, dir = RECORDINGS_DIR) {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) {
    throw new Error('invalid recording name');
  }
  if (name !== path.basename(name)) throw new Error('invalid recording name');
  const full = path.resolve(dir, name);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('invalid recording name');
  }
  return full;
}

// The filename lives in the URL PATH, never the host. Registering the scheme
// as `standard` - required for the range requests <audio> needs to seek -
// makes Chromium canonicalize the URL before the handler ever sees it: the
// host is ASCII-lowercased and gains a trailing slash, which destroys the
// uppercase hex a recording basename carries from the handset MAC. Path
// components survive canonicalization intact, so konnect-rec://rec/<name>
// round-trips exactly.
function nameFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

// Recordings are Ogg-Opus, or raw WAV when the Opus encode failed.
const MIME = { '.opus': 'audio/ogg', '.wav': 'audio/wav' };

// Electron's net.fetch() does NOT honour a Range header on a file:// URL - it
// answers 200 with the whole body regardless (verified against Electron 44.1.0
// with three forwarding styles plus an HTTP cross-check). <audio> issues range
// requests when the user seeks, so this handler implements them itself rather
// than delegating and hoping.
//
// Three-way result, not two: RFC 7233 says a header that fails to PARSE must
// be ignored (serve 200, the whole file) - only a header that parses but has
// out-of-bounds numbers is "unsatisfiable" (416). Collapsing those into one
// falsy value would 416 a player that sent us garbage, when it could have
// gotten the whole file instead.
//   - null            -> header didn't match the grammar at all
//   - 'unsatisfiable' -> header parsed, but start > end or start >= size
//   - {start, end}    -> a valid, in-bounds range
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // "bytes=-N" means the LAST N bytes, not bytes 0..N. Getting this
    // backwards serves the wrong audio for a seek near the end of a call.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable';
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

function registerRecordingProtocol({ protocol, dir = RECORDINGS_DIR }) {
  protocol.handle('konnect-rec', async (request) => {
    let full;
    try {
      full = resolveRecordingPath(nameFromUrl(request.url), dir);
    } catch {
      return new Response('bad recording name', { status: 400 });
    }

    let size;
    try {
      size = (await fsp.stat(full)).size;
    } catch {
      return new Response('recording not found', { status: 404 });
    }

    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    // The scheme is registered corsEnabled, but the privilege only permits
    // the request - the response still has to opt in. '*' is safe here: no
    // origin outside this app can resolve konnect-rec:// at all.
    const base = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    const parsed = parseRange(request.headers.get('range'), size);

    if (parsed === 'unsatisfiable') {
      // 416 must carry the real size or the player cannot recover by asking
      // for a valid range. Returned before any file is opened.
      return new Response('range not satisfiable', {
        status: 416,
        headers: { ...base, 'Content-Range': `bytes */${size}` },
      });
    }

    // Decide status, headers and stream options up front, then open the file
    // exactly ONCE, guarded - the file can be deleted between the stat above
    // and this open, and an unguarded open throws inside the handler.
    const range = parsed; // {start, end} for a valid Range, null for none/unparseable
    const status = range ? 206 : 200;
    const headers = range
      ? { ...base, 'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}` }
      : { ...base, 'Content-Length': String(size) };
    const streamOpts = range
      ? { start: range.start, end: range.end, autoClose: true }
      : { autoClose: true };

    let handle;
    try {
      handle = await fsp.open(full, 'r');
    } catch {
      return new Response('recording not found', { status: 404 });
    }
    return new Response(Readable.toWeb(handle.createReadStream(streamOpts)), { status, headers });
  });
}

module.exports = {
  RECORDINGS_DIR, resolveRecordingPath, nameFromUrl, parseRange, registerRecordingProtocol,
};
