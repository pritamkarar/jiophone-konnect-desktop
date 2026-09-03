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

test('a QP soft break colliding with an RFC fold does not leak a stray =', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1',
    'FN;ENCODING=QUOTED-PRINTABLE:Amit =',
    ' Sharma',
    'TEL;CELL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'Amit Sharma');
});

test('a dangling = must not swallow the next property', () => {
  const cards = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1',
    'FN;ENCODING=QUOTED-PRINTABLE:Amit=',
    'TEL;CELL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(cards.length, 1);
  assert.deepStrictEqual(cards[0].numbers, ['+919876543210']);
});

test('base64 = padding must not swallow the next property', () => {
  const cards = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Amit',
    'PHOTO;ENCODING=BASE64:AAAA==',
    'TEL;CELL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(cards.length, 1);
  assert.deepStrictEqual(cards[0].numbers, ['+919876543210']);
});

test('UTF-8 quoted-printable with no CHARSET declared still decodes correctly', () => {
  const [c] = parseVCards([
    'BEGIN:VCARD', 'VERSION:2.1',
    'FN;ENCODING=QUOTED-PRINTABLE:=E0=A4=85=E0=A4=AE=E0=A4=BF=E0=A4=A4',
    'TEL:9876543210', 'END:VCARD',
  ].join('\r\n'));
  assert.strictEqual(c.name, 'अमित');
});
