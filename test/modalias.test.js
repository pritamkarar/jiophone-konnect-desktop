const test = require('node:test');
const assert = require('node:assert');
const { parseModalias, describePnp } = require('../src/shared/modalias');

test('parses the F120B modalias into vendor, product and firmware version', () => {
  assert.deepStrictEqual(parseModalias('bluetooth:v001Dp1200d1436'), {
    vendor: '001D', product: '1200', version: '20.3.6',
  });
});

test('version 0xJJMN decodes as JJ.M.N in decimal', () => {
  assert.strictEqual(parseModalias('bluetooth:v0001p0002d0100').version, '1.0.0');
  assert.strictEqual(parseModalias('bluetooth:v0001p0002d0A1F').version, '10.1.15');
});

test('hex digits are normalised to upper case', () => {
  const p = parseModalias('bluetooth:v001dp12aBd1436');
  assert.strictEqual(p.vendor, '001D');
  assert.strictEqual(p.product, '12AB');
});

test('a USB modalias, garbage, empty, null and undefined are all null', () => {
  for (const s of ['usb:v1D6Bp0002d0510dc09dsc00dp00ic09isc00ip00in00', 'bluetooth:v001D', 'hello', '', null, undefined, 42]) {
    assert.strictEqual(parseModalias(s), null, `expected null for ${JSON.stringify(s)}`);
  }
});

test('describePnp names Qualcomm for vendor 001D and falls back to the raw vendor otherwise', () => {
  assert.strictEqual(describePnp({ vendor: '001D', product: '1200', version: '20.3.6' }),
    'Qualcomm 001D:1200 · firmware 20.3.6');
  assert.strictEqual(describePnp({ vendor: '000F', product: '0001', version: '1.0.0' }),
    'Vendor 000F · product 0001 · firmware 1.0.0');
  assert.strictEqual(describePnp(null), '');
});
