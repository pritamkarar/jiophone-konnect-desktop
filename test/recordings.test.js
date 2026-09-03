const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveRecordingPath, nameFromUrl, parseRange } = require('../src/main/recordings');

const DIR = '/home/u/Konnect/recordings';

test('resolves a plain basename inside the recordings directory', () => {
  assert.strictEqual(
    resolveRecordingPath('1788278920104-voicecall01.opus', DIR),
    path.join(DIR, '1788278920104-voicecall01.opus'));
});

test('preserves case - basenames contain uppercase hex from the MAC', () => {
  assert.strictEqual(
    resolveRecordingPath('1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34_voicecall01.opus', DIR),
    path.join(DIR, '1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34_voicecall01.opus'));
});

test('rejects traversal, absolute paths and separators', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b', '..', '.', '', 'a\0b']) {
    assert.throws(() => resolveRecordingPath(bad, DIR), /invalid recording name/i,
      `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('rejects non-strings', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => resolveRecordingPath(bad, DIR), /invalid recording name/i);
  }
});

test('nameFromUrl preserves uppercase and decodes percent-escapes', () => {
  assert.strictEqual(
    nameFromUrl('konnect-rec://rec/1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34.opus'),
    '1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34.opus');
  assert.strictEqual(nameFromUrl('konnect-rec://rec/a%20b.opus'), 'a b.opus');
});

// Regression guard. The first attempt put the filename in the HOST component,
// where Chromium lowercased it and appended a trailing slash before the
// handler ran - so every real request 400'd while unit tests built from
// hand-written URL strings stayed green.
test('the name comes from the path, never the host', () => {
  assert.strictEqual(nameFromUrl('konnect-rec://rec/AbC.opus'), 'AbC.opus');
  assert.strictEqual(nameFromUrl('konnect-rec://rec/X.opus').includes('/'), false);
});

test('a traversal attempt through the URL is rejected by the guard', () => {
  assert.throws(
    () => resolveRecordingPath(nameFromUrl('konnect-rec://rec/..%2F..%2Fetc%2Fpasswd'), DIR),
    /invalid recording name/i);
});

// parseRange is pure and drives what bytes get read off disk, so it is
// covered on exact {start, end} values rather than just truthiness.
const SIZE = 10000;

test('parseRange: bytes=0-1023', () => {
  assert.deepStrictEqual(parseRange('bytes=0-1023', SIZE), { start: 0, end: 1023 });
});

test('parseRange: open-ended bytes=500- runs to the last byte', () => {
  assert.deepStrictEqual(parseRange('bytes=500-', SIZE), { start: 500, end: SIZE - 1 });
});

test('parseRange: suffix bytes=-500 resolves to the LAST 500 bytes, not the first', () => {
  assert.deepStrictEqual(parseRange('bytes=-500', SIZE), { start: SIZE - 500, end: SIZE - 1 });
});

test('parseRange: an end past EOF is clamped to size-1', () => {
  assert.deepStrictEqual(parseRange('bytes=9900-99999', SIZE), { start: 9900, end: SIZE - 1 });
});

// RFC 7233: a header that PARSES but is out of bounds is "unsatisfiable"
// (caller returns 416), distinct from a header that fails to parse at all
// (caller ignores it and serves 200) - see the two dedicated tests below for
// that distinction directly. These two were 200-well-formed-but-out-of-range
// before finding 4's fix; they now return 'unsatisfiable', not null.
test('parseRange: start >= size is not satisfiable', () => {
  assert.strictEqual(parseRange('bytes=10000-', SIZE), 'unsatisfiable');
  assert.strictEqual(parseRange(`bytes=${SIZE}-${SIZE + 5}`, SIZE), 'unsatisfiable');
});

test('parseRange: start after end is not satisfiable', () => {
  assert.strictEqual(parseRange('bytes=500-100', SIZE), 'unsatisfiable');
});

test('parseRange: malformed headers return null, not "unsatisfiable" - the caller must serve 200, not 416', () => {
  for (const bad of ['garbage', 'bytes=', 'bytes=-', 'bytes=abc-def', '1023-2047']) {
    assert.strictEqual(parseRange(bad, SIZE), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('parseRange: an empty or absent header returns null', () => {
  assert.strictEqual(parseRange('', SIZE), null);
  assert.strictEqual(parseRange(undefined, SIZE), null);
  assert.strictEqual(parseRange(null, SIZE), null);
});

// A comma means multiple ranges. We only implement the single-range grammar,
// so this must fail to match entirely (null, whole file served) rather than
// being treated as satisfiable or unsatisfiable.
test('parseRange: a multi-range header does not match our single-range grammar', () => {
  assert.strictEqual(parseRange('bytes=0-99,200-299', SIZE), null);
});

test('parseRange: bytes=-0 is a well-formed but zero-length suffix, so unsatisfiable', () => {
  assert.strictEqual(parseRange('bytes=-0', SIZE), 'unsatisfiable');
});

test('parseRange: bytes=0-0 is a valid one-byte range', () => {
  assert.deepStrictEqual(parseRange('bytes=0-0', SIZE), { start: 0, end: 0 });
});

// A zero-byte file (an Opus encode that produced nothing, say) has no valid
// byte offset at all, so ANY well-formed range on it is unsatisfiable - and a
// malformed header on it still falls back to null, exactly as with a normal
// file, because malformed-vs-unsatisfiable never depends on size.
test('parseRange: on a zero-byte file, a well-formed range is unsatisfiable and a malformed one is null', () => {
  assert.strictEqual(parseRange('bytes=0-0', 0), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.strictEqual(parseRange('garbage', 0), null);
});
