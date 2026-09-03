const test = require('node:test');
const assert = require('node:assert');
const {
  getPower, setPower, onPower, _pollOnce, startScan, stopScan, removeDevice,
} = require('../src/main/backend/linux/adapter');

function fakeBus({
  powered = true, absent = false, absentObject = false, setError = null, busError = null,
  busyTimes = 0, runError = null,
} = {}) {
  const calls = [];
  const ran = [];
  // PropertiesChanged listeners, so onPower's unsubscribe can be observed to
  // actually detach rather than merely to be a function.
  const listeners = [];
  const props = {
    async Get(iface, name) {
      calls.push(['Get', iface, name]);
      if (absent) {
        const e = new Error("No such interface 'org.bluez.Adapter1'");
        e.type = 'org.freedesktop.DBus.Error.InvalidArgs';
        throw e;
      }
      return { signature: 'b', value: powered };
    },
    async Set(iface, name, variant) {
      calls.push(['Set', iface, name, variant.value]);
      if (busyTimes > 0) { busyTimes -= 1; throw new Error('org.bluez.Error.Busy'); }
      if (setError) throw new Error(setError);
      powered = variant.value;
    },
    on(name, fn) { if (name === 'PropertiesChanged') listeners.push(fn); },
    off(name, fn) {
      const i = name === 'PropertiesChanged' ? listeners.indexOf(fn) : -1;
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  let getInterfaceFn = async () => props;
  if (absentObject) {
    getInterfaceFn = async () => {
      // dbus-next fails at proxy construction for a missing path: plain Error, no .type
      const e = new Error('interface not found in proxy object: org.freedesktop.DBus.Properties');
      throw e;
    };
  } else if (busError) {
    getInterfaceFn = async () => { throw new Error(busError); };
  }
  const emit = (iface, changed) => { for (const fn of [...listeners]) fn(iface, changed); };
  const runFn = async (cmd, args) => {
    ran.push([cmd, ...args]);
    if (runError) throw new Error(runError);
    return { stdout: '', stderr: '' };
  };
  return {
    calls, ran, emit, listeners,
    opts: {
      getInterfaceFn, systemBusFn: () => ({}), runFn, sleepFn: async () => {},
    },
  };
}

test('getPower reads Adapter1.Powered', async () => {
  const f = fakeBus({ powered: true });
  assert.strictEqual(await getPower(f.opts), true);
  assert.deepStrictEqual(f.calls[0], ['Get', 'org.bluez.Adapter1', 'Powered']);
});

test('getPower distinguishes off from absent', async () => {
  assert.strictEqual(await getPower(fakeBus({ powered: false }).opts), false);
  assert.strictEqual(await getPower(fakeBus({ absent: true }).opts), null);
});

test('getPower handles proxy construction failure (no adapter object)', async () => {
  assert.strictEqual(await getPower(fakeBus({ absentObject: true }).opts), null);
});

// onPower is subscribed fire-and-forget from ipc.js, so a rejection here is
// an unhandled rejection - fatal to the main process on Node >= 15. The
// machine with no adapter is exactly the one onboarding state 1a exists to
// serve, so it must NOT be the machine the app dies on. The absent-adapter
// failure is the real dbus-next shape: a plain Error with no .type, thrown at
// proxy construction (which is why isAbsentError alone cannot classify it).
test('onPower on a machine with no adapter resolves to a no-op unsubscribe', async () => {
  const f = fakeBus({ absentObject: true });
  const unsub = await onPower(() => { throw new Error('must never be called'); }, f.opts);
  assert.strictEqual(typeof unsub, 'function');
  unsub();                                  // and calling it must be safe
});

test('onPower still surfaces a real bus fault, described', async () => {
  const f = fakeBus({ busError: 'connection refused' });
  await assert.rejects(() => onPower(() => {}, f.opts), /connection refused/);
});

test('onPower reports Powered changes and its unsubscribe detaches', async () => {
  const f = fakeBus();
  const seen = [];
  const unsub = await onPower((p) => seen.push(p), f.opts);
  f.emit('org.bluez.Adapter1', { Powered: { signature: 'b', value: false } });
  f.emit('org.bluez.Device1', { Powered: { signature: 'b', value: true } }); // other interface
  f.emit('org.bluez.Adapter1', { Discovering: { signature: 'b', value: true } }); // other property
  unsub();
  f.emit('org.bluez.Adapter1', { Powered: { signature: 'b', value: true } });
  assert.deepStrictEqual(seen, [false], 'events after unsubscribe must not reach the callback');
  assert.strictEqual(f.listeners.length, 0, 'the listener must actually be detached');
});

test('setPower writes a boolean variant', async () => {
  const f = fakeBus({ powered: false });
  assert.strictEqual(await setPower(true, f.opts), true);
  assert.deepStrictEqual(f.calls[0], ['Set', 'org.bluez.Adapter1', 'Powered', true]);
});

test('setPower surfaces the real reason rather than swallowing it', async () => {
  const f = fakeBus({ setError: 'rfkill: Operation not permitted' });
  await assert.rejects(() => setPower(true, f.opts), /rfkill/);
});

// BlueZ refuses Powered=true outright (org.bluez.Error.Failed) while the
// adapter is rfkill soft-blocked - the default state after a reboot on many
// machines. Powering on means unblocking first, exactly as every desktop
// Bluetooth toggle does; the D-Bus write alone can never succeed.
test('setPower(true) unblocks rfkill before writing Powered', async () => {
  const f = fakeBus({ powered: false });
  assert.strictEqual(await setPower(true, f.opts), true);
  assert.deepStrictEqual(f.ran, [['rfkill', 'unblock', 'bluetooth']]);
  assert.deepStrictEqual(f.calls[0], ['Set', 'org.bluez.Adapter1', 'Powered', true]);
});

// Turning OFF is a plain D-Bus write: soft-blocking the radio behind the
// user's back is not what "turn off Bluetooth in Konnect" asks for.
test('setPower(false) leaves rfkill alone', async () => {
  const f = fakeBus({ powered: true });
  assert.strictEqual(await setPower(false, f.opts), false);
  assert.deepStrictEqual(f.ran, []);
});

// The unblock lands asynchronously: BlueZ answers Busy to a Powered write
// made while it is still processing the rfkill transition. Verified on
// hardware - unblock, immediate Set, org.bluez.Error.Busy, powered a moment
// later. Without the retry the button reports failure on the happy path.
test('setPower(true) retries while BlueZ is busy with the rfkill transition', async () => {
  const f = fakeBus({ powered: false, busyTimes: 3 });
  assert.strictEqual(await setPower(true, f.opts), true);
  assert.strictEqual(f.calls.length, 4, 'three Busy answers then the write that stuck');
});

test('setPower(true) gives up on persistent Busy rather than looping forever', async () => {
  const f = fakeBus({ powered: false, busyTimes: Infinity });
  await assert.rejects(() => setPower(true, f.opts), /Busy/);
  assert.ok(f.calls.length <= 12, `bounded retries, got ${f.calls.length}`);
});

// A machine without the rfkill binary, or one where the seat ACL on
// /dev/rfkill is missing, must still get its Powered write attempted - and
// must still see BlueZ's own reason if that write fails.
test('setPower(true) still writes Powered when rfkill is unavailable', async () => {
  const f = fakeBus({ powered: false, runError: 'spawn rfkill ENOENT' });
  assert.strictEqual(await setPower(true, f.opts), true);
  assert.deepStrictEqual(f.calls[0], ['Set', 'org.bluez.Adapter1', 'Powered', true]);
});

function managed(devices) {
  const out = {};
  for (const d of devices) {
    out[`/org/bluez/hci0/dev_${d.mac.replace(/:/g, '_')}`] = {
      'org.bluez.Device1': {
        Address: { value: d.mac }, Alias: { value: d.name },
        Icon: d.icon === undefined ? undefined : { value: d.icon },
        Class: d.cls === undefined ? undefined : { value: d.cls },
        Paired: { value: Boolean(d.paired) }, Connected: { value: Boolean(d.connected) },
        RSSI: d.rssi === undefined ? undefined : { value: d.rssi },
      },
    };
  }
  return out;
}

test('_pollOnce emits each newly seen device once', async () => {
  const seen = [];
  const state = { last: new Map() };
  const om = { GetManagedObjects: async () => managed([{ mac: '44:CD:0E:AD:5E:34', name: 'F120B' }]) };
  await _pollOnce(state, om, (d) => seen.push(d));
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.strictEqual(seen.length, 1, 'unchanged device must not re-emit');
  assert.strictEqual(seen[0].mac, '44:CD:0E:AD:5E:34');
  assert.strictEqual(seen[0].name, 'F120B');
});

test('_pollOnce re-emits when a late Class arrives', async () => {
  const seen = [];
  const state = { last: new Map() };
  let cls;
  const om = { GetManagedObjects: async () => managed([{ mac: '44:CD:0E:AD:5E:34', name: 'F120B', cls }]) };
  await _pollOnce(state, om, (d) => seen.push(d));
  cls = 0x5a020c;
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1].cls, 0x5a020c);
});

test('_pollOnce emits a gone marker when a device disappears', async () => {
  const seen = [];
  const state = { last: new Map() };
  let list = [{ mac: '44:CD:0E:AD:5E:34', name: 'F120B' }];
  const om = { GetManagedObjects: async () => managed(list) };
  await _pollOnce(state, om, (d) => seen.push(d));
  list = [];
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.deepStrictEqual(seen[1], { mac: '44:CD:0E:AD:5E:34', gone: true });
});

test('_pollOnce ignores non-device objects', async () => {
  const seen = [];
  const state = { last: new Map() };
  const om = { GetManagedObjects: async () => ({ '/org/bluez/hci0': { 'org.bluez.Adapter1': {} } }) };
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.strictEqual(seen.length, 0);
});

// Regression for the check-then-act race: startScan checked `if (scanState)`
// then awaited two proxy resolutions BEFORE claiming scanState, so a
// stopScan() landing in that window saw no scan running (did nothing) while
// the in-flight startScan went on to call StartDiscovery unopposed. The fake
// bus below stalls only the Adapter1 proxy (both startScan and stopScan
// resolve it) so a stopScan() can be fired while startScan is mid-await,
// exactly like a renderer close path racing a scan that just began.
test('a stopScan racing a mid-flight startScan never leaves discovery unreachable', async () => {
  const calls = [];
  let releaseAdapterProxy;
  const adapterProxyReady = new Promise((resolve) => { releaseAdapterProxy = resolve; });
  const adapterIface = {
    async StartDiscovery() { calls.push('StartDiscovery'); },
    async StopDiscovery() { calls.push('StopDiscovery'); },
  };
  const omIface = { GetManagedObjects: async () => ({}) };
  const getInterfaceFn = async (bus, service, path, iface) => {
    if (iface === 'org.bluez.Adapter1') { await adapterProxyReady; return adapterIface; }
    return omIface;
  };
  const opts = { getInterfaceFn, systemBusFn: () => ({}) };

  const startPromise = startScan(opts);
  const stopPromise = stopScan(opts); // fired while startScan is stuck resolving the adapter proxy
  releaseAdapterProxy();
  await Promise.all([startPromise, stopPromise]);

  // Outcome, not internals: a discovery must never be started and then left
  // with nobody able to reach it.
  const startedThenStopped = calls[0] === 'StartDiscovery' && calls.includes('StopDiscovery');
  const neverStarted = !calls.includes('StartDiscovery');
  assert.ok(startedThenStopped || neverStarted, `unexpected call sequence: ${calls.join(',')}`);

  await stopScan(opts); // must still be safe to call with nothing running
});

// Regression for R10: the round-1 fix's post-StartDiscovery cleanup stopped
// discovery whenever `scanState !== state`, but that condition is true for
// TWO different reasons - cleared outright (ours to undo) vs taken over by a
// later startScan (not ours to touch). This races the first startScan's own
// StartDiscovery call being in flight - not its proxy resolution, which the
// round-1 pre-StartDiscovery check (`if (scanState !== state) return;`)
// already guards, so a stall there can never reach the buggy line at all -
// against a stopScan + a second, later startScan that claims and completes
// first. Only StartDiscovery's OWN promise settling after that supersession
// can exercise the bug.
test('a startScan superseded by a later startScan must not stop that scan\'s discovery', async () => {
  const calls = [];
  let releaseFirstStart;
  const firstStartGate = new Promise((resolve) => { releaseFirstStart = resolve; });
  let firstStartClaimed = false;
  const adapterIface = {
    async StartDiscovery() {
      calls.push('StartDiscovery');
      if (!firstStartClaimed) {
        firstStartClaimed = true;
        await firstStartGate; // only the first caller's StartDiscovery stalls
      }
    },
    async StopDiscovery() { calls.push('StopDiscovery'); },
  };
  const omIface = { GetManagedObjects: async () => ({}) };
  const getInterfaceFn = async (bus, service, path, iface) => (
    iface === 'org.bluez.Adapter1' ? adapterIface : omIface
  );
  const opts = { getInterfaceFn, systemBusFn: () => ({}) };

  const firstStart = startScan(opts);
  // Let the first call actually reach and invoke StartDiscovery (and stall
  // inside it) before racing it with a stop and a second start.
  await new Promise((resolve) => { setImmediate(resolve); });
  await stopScan(opts); // supersedes the first call while its StartDiscovery is in flight
  await startScan(opts); // a second, later start claims ownership and completes
  releaseFirstStart(); // now let the first call's stalled StartDiscovery resolve
  await firstStart;

  // Outcome, not internals: the sequence must not end with the second scan's
  // StartDiscovery immediately followed by a StopDiscovery - that would be
  // the first (superseded) call silently killing the second scan's live
  // discovery.
  assert.notDeepStrictEqual(
    calls.slice(-2), ['StartDiscovery', 'StopDiscovery'],
    `unexpected call sequence: ${calls.join(',')}`,
  );

  await stopScan(opts); // clean up the second scan's real discovery + timer
});

// ---- removeDevice (unpair) ----------------------------------------------
// Forgetting a handset now drops the BlueZ bond too, so this is the one
// adapter call that changes state outside Konnect. It reports failure rather
// than swallowing it (stopScan's `catch {}` is right for a scan nobody is
// waiting on, wrong here) - main decides what a failed unpair means.

function fakeAdapter({ error = null } = {}) {
  const calls = [];
  const iface = {
    async RemoveDevice(devicePath) {
      calls.push(devicePath);
      if (error) throw new Error(error);
    },
  };
  return { calls, opts: { getInterfaceFn: async () => iface, systemBusFn: () => ({}) } };
}

test('removeDevice unpairs the device at its BlueZ object path', async () => {
  const f = fakeAdapter();
  await removeDevice('44:CD:0E:AD:5E:34', f.opts);
  assert.deepStrictEqual(f.calls, ['/org/bluez/hci0/dev_44_CD_0E_AD_5E_34']);
});

test('removeDevice refuses a mac that is not one, without calling BlueZ', async () => {
  // devicePathFor throws on a bad address. Reaching RemoveDevice with a
  // hand-built path would ask BlueZ to delete something we cannot name.
  const f = fakeAdapter();
  await assert.rejects(() => removeDevice('not-a-mac', f.opts));
  assert.deepStrictEqual(f.calls, []);
});

test('removeDevice surfaces a BlueZ failure instead of swallowing it', async () => {
  // The caller has to be able to tell the user the handset is still paired.
  const f = fakeAdapter({ error: 'org.bluez.Error.DoesNotExist' });
  await assert.rejects(() => removeDevice('44:CD:0E:AD:5E:34', f.opts),
    /DoesNotExist/);
});
