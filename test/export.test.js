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
