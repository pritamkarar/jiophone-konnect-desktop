const test = require('node:test');
const assert = require('node:assert');
const { createBackend } = require('../src/main/backend');
const { BACKEND_METHODS, UnsupportedPlatformError } = require('../src/main/backend/interface');
const { createLinuxBackend } = require('../src/main/backend/linux');

test('mock backend implements every method in the contract', () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  for (const name of BACKEND_METHODS) {
    assert.strictEqual(typeof backend[name], 'function', `missing ${name}`);
  }
});

test('windows backend throws UnsupportedPlatformError on any call', async () => {
  const backend = createBackend({ platform: 'win32', mock: false });
  await assert.rejects(() => backend.getStatus(), UnsupportedPlatformError);
});

test('mock reports a connected handset', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const status = await backend.getStatus();
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.operator, 'JIO');
  assert.strictEqual(typeof status.battery, 'number');
});

test('mock emits a call lifecycle ending in disconnected', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const seen = [];
  backend.onCall((c) => seen.push(c.state));
  const id = await backend.dial('+919876543210');
  assert.strictEqual(typeof id, 'string');
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(seen.includes('dialing'), `saw ${seen}`);
  assert.ok(seen.includes('active'), `saw ${seen}`);
  await backend.hangup(id);
  assert.strictEqual(seen.at(-1), 'disconnected');
});

test('unsubscribe stops delivery', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  let count = 0;
  const off = backend.onCall(() => { count += 1; });
  off();
  await backend.dial('+919876543210');
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(count, 0);
});

test('cancelContactImport prevents contact delivery', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  let delivered = false;
  backend.onContacts(() => { delivered = true; });
  await backend.startContactImport();
  await backend.cancelContactImport();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(delivered, false);
});

// The unbound backend is what every user with no paired phone gets on first
// run, and it is the one shape no hardware test will ever reach. It must
// satisfy the same contract as the bound backend and the mock.
test('unbound linux backend implements every method in the contract', () => {
  const backend = createLinuxBackend({ mac: null });
  for (const name of BACKEND_METHODS) {
    assert.strictEqual(typeof backend[name], 'function', `missing ${name}`);
  }
});

test('unbound linux backend reports no handset rather than throwing', async () => {
  const backend = createLinuxBackend({ mac: null });
  const status = await backend.getStatus();
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.error, 'No handset selected');
  // Subscription methods must return real unsubscribe functions, or callers
  // that store the return value crash on cleanup.
  for (const name of ['onDeviceStatus', 'onCall', 'onContacts', 'onCallVolume']) {
    assert.strictEqual(typeof backend[name](() => {}), 'function', `${name} must return an unsubscribe fn`);
  }
  await assert.rejects(() => backend.dial('+911234567890'), /No handset selected/);
});

test('mock backend exposes an adapter namespace', () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  assert.strictEqual(typeof backend.adapter, 'object');
  for (const m of ['getPower', 'setPower', 'onPower', 'startScan', 'stopScan',
                   'onDiscovered', 'registerAgent', 'unregisterAgent', 'pair', 'confirm',
                   'onPairingRequest']) {
    assert.strictEqual(typeof backend.adapter[m], 'function', `missing adapter.${m}`);
  }
  // Shape, not just presence: the real onPower is async and ipc.js .catch()es
  // it, so a mock run must have the same shape production does - a sync mock
  // is what hid an unhandled rejection that killed main at startup.
  const unsub = backend.adapter.onPower(() => {});
  assert.ok(typeof unsub?.then === 'function', 'adapter.onPower must be async');
  return unsub.then((off) => assert.strictEqual(typeof off, 'function'));
});

test('mock adapter reports a powered radio and discovers the JioPhone', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  assert.strictEqual(await backend.adapter.getPower(), true);
  const seen = [];
  backend.adapter.onDiscovered((d) => seen.push(d));
  await backend.adapter.startScan();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(seen.some((d) => d.name === 'F120B'), 'mock must offer a discoverable handset');
  await backend.adapter.stopScan();
});

test('windows backend has no adapter namespace, so callers must guard', () => {
  const backend = createBackend({ platform: 'win32', mock: false });
  assert.strictEqual(backend.adapter, undefined);
});

// Onboarding runs on the unbound backend, so a scan or agent registration
// started from there is exactly as likely to be live at teardown as in the
// bound branch. dispose() must not let a failure in either teardown call
// throw - a leaked discovery drains the handset battery and degrades every
// other Bluetooth link on the machine.
test('unbound linux backend dispose() resolves even when the adapter module rejects', async () => {
  const adapterModule = require('../src/main/backend/linux/adapter');
  const originalStopScan = adapterModule.stopScan;
  let called = false;
  adapterModule.stopScan = async () => {
    called = true;
    throw new Error('simulated D-Bus failure');
  };
  try {
    const backend = createLinuxBackend({ mac: null });
    await assert.doesNotReject(() => backend.dispose());
    // Proves dispose() actually calls stopScan (not just that it would
    // tolerate a failure it never triggers) - this is what would have
    // failed before adapter.stopScan() was wired into the unbound dispose().
    assert.strictEqual(called, true, 'dispose() must call adapter.stopScan()');
  } finally {
    adapterModule.stopScan = originalStopScan;
  }
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('mock: a second incoming call arrives as waiting; answering it holds the first; swap and merge follow', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const calls = new Map();
  backend.onCall((c) => calls.set(c.id, c));

  const a = await backend.dial('+919876543210');
  await settle();
  assert.strictEqual(calls.get(a).state, 'active');

  const b = backend.simulateIncoming('+919804464251');
  assert.strictEqual(calls.get(b).state, 'waiting', 'a second inbound call must be waiting, not incoming');

  await backend.answer(b);
  assert.strictEqual(calls.get(a).state, 'held', 'answering the waiting call must hold the first');
  assert.strictEqual(calls.get(b).state, 'active');

  await backend.swapCalls();
  assert.strictEqual(calls.get(a).state, 'active');
  assert.strictEqual(calls.get(b).state, 'held');

  await backend.createMultiparty();
  assert.strictEqual(calls.get(a).multiparty, true);
  assert.strictEqual(calls.get(b).multiparty, true);
  assert.strictEqual(calls.get(b).state, 'active');

  await backend.hangup(a);
  assert.strictEqual(calls.get(a).state, 'disconnected');
  assert.strictEqual(calls.get(b).state, 'disconnected', 'hanging up a conference ends every member');
  backend.dispose();
});

test('mock refuses a dial while a call is active and allows one once every call is held', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const calls = new Map();
  backend.onCall((c) => calls.set(c.id, c));
  const a = await backend.dial('+919876543210');
  await settle();
  await assert.rejects(() => backend.dial('+919804464251'), /put it on hold/);
  await backend.swapCalls();
  assert.strictEqual(calls.get(a).state, 'held');
  const b = await backend.dial('+919804464251');
  await settle();
  assert.strictEqual(calls.get(b).state, 'active');
  assert.strictEqual(calls.get(a).state, 'held');
  backend.dispose();
});

test('mock status carries handsfree features, no subscriber numbers, and a non-real pnp', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const s = await backend.getStatus();
  assert.deepStrictEqual(s.features, ['three-way-calling', 'release-all-held', 'create-multiparty']);
  assert.deepStrictEqual(s.numbers, []);
  assert.deepStrictEqual(s.pnp, { vendor: '0000', product: '0000', version: '0.0.0' });
});
