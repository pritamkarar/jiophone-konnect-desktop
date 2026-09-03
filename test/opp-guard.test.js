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

// Transfer1.Size is D-Bus uint64, which dbus-next marshals as a native
// BigInt, not a number - a real push never hands isAcceptableTransfer a
// plain number. A typeof-based guard silently never fires against this
// shape; regression-test it directly rather than trusting the number-typed
// tests above to stand in for it.
test('rejects an oversized transfer reported as a BigInt (the real D-Bus shape)', () => {
  const r = isAcceptableTransfer({ ...good, size: BigInt(50 * 1024 * 1024) }, opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /size/i);
});

test('accepts an in-range transfer reported as a BigInt', () => {
  const r = isAcceptableTransfer({ ...good, size: BigInt(2048) }, opts);
  assert.strictEqual(r.ok, true);
});
