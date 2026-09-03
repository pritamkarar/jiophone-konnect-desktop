const test = require('node:test');
const assert = require('node:assert');
const { macFromPath } = require('../src/main/backend/linux/bus');
const { isPhone, rankDiscovered, signalLabel, signalBars } = require('../src/shared/rank');

const F120B = { mac: '44:CD:0E:AD:5E:34', name: 'F120B', icon: null, cls: null, paired: false, rssi: -55 };
const ONEPLUS = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', icon: 'phone', cls: 0x5a020c, paired: true, rssi: -70 };
const BUDS = { mac: 'AA:BB:CC:DD:EE:FF', name: 'Sony WH-1000XM4', icon: 'audio-headset', cls: 0x240404, paired: false, rssi: -40 };

test('macFromPath reverses devicePathFor', () => {
  assert.strictEqual(macFromPath('/org/bluez/hci0/dev_44_CD_0E_AD_5E_34'), '44:CD:0E:AD:5E:34');
});

test('macFromPath returns null for a non-device path', () => {
  assert.strictEqual(macFromPath('/org/bluez/hci0'), null);
  assert.strictEqual(macFromPath(''), null);
  assert.strictEqual(macFromPath(null), null);
});

test('isPhone accepts the Icon hint', () => {
  assert.strictEqual(isPhone(ONEPLUS), true);
});

test('isPhone accepts CoD major class 0x02 with no Icon', () => {
  assert.strictEqual(isPhone({ ...F120B, cls: 0x5a020c }), true);
});

test('isPhone rejects a headset', () => {
  assert.strictEqual(isPhone(BUDS), false);
});

test('a device with neither Icon nor Class is not yet a phone, but is NOT dropped', () => {
  const { phones, others } = rankDiscovered([F120B]);
  assert.strictEqual(isPhone(F120B), false);
  assert.deepStrictEqual(phones, []);
  assert.deepStrictEqual(others.map((d) => d.mac), [F120B.mac]);
});

test('phones rank above a closer non-phone', () => {
  const { phones, others } = rankDiscovered([BUDS, ONEPLUS]);
  assert.deepStrictEqual(phones.map((d) => d.mac), [ONEPLUS.mac]);
  assert.deepStrictEqual(others.map((d) => d.mac), [BUDS.mac]);
});

test('a late-arriving Class promotes a device into phones', () => {
  const before = rankDiscovered([F120B]);
  assert.strictEqual(before.phones.length, 0);
  const after = rankDiscovered([{ ...F120B, cls: 0x5a020c }]);
  assert.strictEqual(after.phones.length, 1);
});

test('within a group, stronger RSSI comes first', () => {
  const near = { ...ONEPLUS, mac: '11:11:11:11:11:11', rssi: -30 };
  const { phones } = rankDiscovered([ONEPLUS, near]);
  assert.deepStrictEqual(phones.map((d) => d.mac), [near.mac, ONEPLUS.mac]);
});

test('missing RSSI sorts last but is kept, and ties keep input order', () => {
  const a = { ...ONEPLUS, mac: '11:11:11:11:11:11', rssi: null };
  const b = { ...ONEPLUS, mac: '22:22:22:22:22:22', rssi: null };
  const { phones } = rankDiscovered([a, b, ONEPLUS]);
  assert.deepStrictEqual(phones.map((d) => d.mac), [ONEPLUS.mac, a.mac, b.mac]);
});

test('signalLabel buckets RSSI, and says so when there is no reading', () => {
  assert.strictEqual(signalLabel(-45), 'Strong signal');
  assert.strictEqual(signalLabel(-60), 'Strong signal');   // inclusive edge
  assert.strictEqual(signalLabel(-61), 'Fair signal');
  assert.strictEqual(signalLabel(-80), 'Fair signal');
  assert.strictEqual(signalLabel(-81), 'Weak signal');
  // A device BlueZ already knew about has no RSSI - never call that weak.
  assert.strictEqual(signalLabel(null), 'Signal unknown');
  assert.strictEqual(signalLabel(undefined), 'Signal unknown');
});

test('signalBars fills one block per quarter of oFono\'s percentage', () => {
  assert.strictEqual(signalBars(100), '\u2582\u2584\u2586\u2588');
  assert.strictEqual(signalBars(76), '\u2582\u2584\u2586\u2588');
  assert.strictEqual(signalBars(75), '\u2582\u2584\u2586');
  assert.strictEqual(signalBars(1), '\u2582');
  assert.strictEqual(signalBars(0), '');
  // No reading is not the same as no signal - both render empty, but neither
  // may be turned into a bar the handset never reported.
  assert.strictEqual(signalBars(null), '');
  assert.strictEqual(signalBars(-5), '');
  assert.strictEqual(signalBars(140), '\u2582\u2584\u2586\u2588');
});
