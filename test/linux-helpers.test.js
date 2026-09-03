const test = require('node:test');
const assert = require('node:assert');
const {
  modemPathFor, devicePathFor, unwrap, isAbsentError, describeDBusError, isValidMac,
} = require('../src/main/backend/linux/bus');
const { createDeviceMonitor } = require('../src/main/backend/linux/device');

test('modemPathFor builds the oFono HFP modem path', () => {
  assert.strictEqual(
    modemPathFor('44:CD:0E:AD:5E:34'),
    '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});

test('modemPathFor accepts lowercase and normalises to uppercase', () => {
  assert.strictEqual(
    modemPathFor('44:cd:0e:ad:5e:34'),
    '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});

test('devicePathFor builds the BlueZ device path', () => {
  assert.strictEqual(
    devicePathFor('44:CD:0E:AD:5E:34'),
    '/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});

test('malformed MAC throws rather than producing a silently wrong path', () => {
  assert.throws(() => modemPathFor('nonsense'), /invalid MAC/i);
  assert.throws(() => modemPathFor(''), /invalid MAC/i);
});

test('isValidMac accepts a well-formed address in either case', () => {
  assert.strictEqual(isValidMac('44:CD:0E:AD:5E:34'), true);
  assert.strictEqual(isValidMac('44:cd:0e:ad:5e:34'), true);
});

test('isValidMac rejects null, undefined, empty, non-strings and malformed addresses', () => {
  assert.strictEqual(isValidMac(null), false);
  assert.strictEqual(isValidMac(undefined), false);
  assert.strictEqual(isValidMac(''), false);
  assert.strictEqual(isValidMac(123456), false);
  assert.strictEqual(isValidMac('44:CD:0E:AD:5E'), false); // too short
  assert.strictEqual(isValidMac('44-CD-0E-AD-5E-34'), false); // wrong separators
});

test('unwrap strips Variant wrappers', () => {
  const dict = { Online: { value: true }, Name: { value: 'F120B' }, Strength: { value: 100 } };
  assert.deepStrictEqual(unwrap(dict), { Online: true, Name: 'F120B', Strength: 100 });
});

test('unwrap passes through plain values untouched', () => {
  assert.deepStrictEqual(unwrap({ a: 1, b: 'x' }), { a: 1, b: 'x' });
});

test('isAbsentError recognises an absent interface/property as expected', () => {
  assert.strictEqual(
    isAbsentError({ type: 'org.freedesktop.DBus.Error.UnknownInterface' }), true);
});

test('isAbsentError treats a real bus fault as NOT expected', () => {
  assert.strictEqual(
    isAbsentError({ type: 'org.freedesktop.DBus.Error.ServiceUnknown' }), false);
  assert.strictEqual(isAbsentError(new Error('connection timed out')), false);
});

test('describeDBusError prefers type, falls back to message, handles null', () => {
  assert.strictEqual(
    describeDBusError({ type: 'org.freedesktop.DBus.Error.UnknownInterface', message: 'nope' }),
    'org.freedesktop.DBus.Error.UnknownInterface');
  assert.strictEqual(describeDBusError({ message: 'connection timed out' }), 'connection timed out');
  assert.strictEqual(typeof describeDBusError(null), 'string');
});

test('describeDBusError prefers a real Error message over its generic name', () => {
  assert.strictEqual(describeDBusError(new Error('connection timed out')), 'connection timed out');
  assert.strictEqual(
    describeDBusError({ type: 'org.freedesktop.DBus.Error.ServiceUnknown' }),
    'org.freedesktop.DBus.Error.ServiceUnknown');
});

test('an absent BlueZ interface is not reported as a fault', () => {
  // BlueZ's real shape for a missing interface, captured from the handset.
  assert.strictEqual(isAbsentError({
    type: 'org.freedesktop.DBus.Error.InvalidArgs',
    name: 'DBusError',
    message: "No such interface 'org.bluez.Battery1'",
  }), true);
});

test('a malformed call is NOT mistaken for an absent interface', () => {
  // Same D-Bus error type, different message - a programming error that must
  // stay visible rather than being swallowed as "that interface isn't there".
  assert.strictEqual(isAbsentError({
    type: 'org.freedesktop.DBus.Error.InvalidArgs',
    name: 'DBusError',
    message: "Type of message, '(ss)', does not match expected type",
  }), false);
});

test('connect(mac) targets the requested device, not the configured default', async () => {
  const seen = [];
  const fakeGetInterface = async (_bus, _service, objPath) => {
    seen.push(objPath);
    return { Connect: async () => {}, Disconnect: async () => {} };
  };
  const monitor = createDeviceMonitor({
    mac: '44:CD:0E:AD:5E:34',
    getInterfaceFn: fakeGetInterface,
    systemBusFn: () => ({}),
  });

  await monitor.connect('30:BB:7D:21:99:DA');
  assert.strictEqual(seen[0], '/org/bluez/hci0/dev_30_BB_7D_21_99_DA');

  await monitor.connect();
  assert.strictEqual(seen[1], '/org/bluez/hci0/dev_44_CD_0E_AD_5E_34');
});
