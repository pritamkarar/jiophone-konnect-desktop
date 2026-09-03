'use strict';
const dbus = require('dbus-next');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  systemBus, unwrap, getInterface, isAbsentError, describeDBusError, devicePathFor,
} = require('./bus');
const { createEmitter } = require('../interface');

const BLUEZ = 'org.bluez';
const PROPS = 'org.freedesktop.DBus.Properties';
const ADAPTER = 'org.bluez.Adapter1';
// Hardcoded to match bus.js's devicePathFor/modemPathFor, which already assume
// hci0. A multi-adapter machine is out of scope for this project.
const ADAPTER_PATH = '/org/bluez/hci0';

// dbus-next fails at proxy CONSTRUCTION for a path BlueZ does not export -
// a plain Error with no .type, which isAbsentError cannot classify. That is
// what a machine with no Bluetooth adapter actually looks like, so it must
// read as absent (null) rather than as a bus fault.
const NO_PROXY_RE = /interface not found in proxy object/i;
function isAdapterAbsent(err) {
  return isAbsentError(err) || NO_PROXY_RE.test(String(err && err.message || ''));
}

async function adapterProps({ getInterfaceFn = getInterface, systemBusFn = systemBus } = {}) {
  return getInterfaceFn(systemBusFn(), BLUEZ, ADAPTER_PATH, PROPS);
}

// null means NO ADAPTER, false means present but powered down. Collapsing the
// two would make 1a offer a "Turn on Bluetooth" button for hardware that does
// not exist.
async function getPower(opts = {}) {
  try {
    const props = await adapterProps(opts);
    const v = await props.Get(ADAPTER, 'Powered');
    return Boolean(v && typeof v === 'object' && 'value' in v ? v.value : v);
  } catch (err) {
    if (isAdapterAbsent(err)) return null;
    throw new Error(describeDBusError(err));
  }
}

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// BlueZ answers Busy to a Powered write made while it is still processing the
// rfkill unblock. Measured at well under a second on this hardware; 10 x 250ms
// is generous headroom without hanging the button on a genuinely stuck adapter.
const BUSY_RETRY_MS = 250;
const BUSY_RETRIES = 10;

async function setPower(on, opts = {}) {
  const { runFn = execFileAsync, sleepFn = sleep } = opts;
  try {
    // BlueZ REFUSES Powered=true on an rfkill soft-blocked adapter, with a bare
    // org.bluez.Error.Failed - and soft-blocked is how many machines boot. The
    // D-Bus write alone can never turn Bluetooth on; unblocking first is what
    // every desktop Bluetooth toggle does. logind puts an ACL for the active
    // seat user on /dev/rfkill, so this needs no root. Best-effort: a machine
    // without the binary (or without that ACL) still gets its write attempted,
    // and still sees BlueZ's own reason if the write fails.
    if (on) await runFn('rfkill', ['unblock', 'bluetooth']).catch(() => {});
    // Proxy resolution is INSIDE the try: an adapter that vanished between
    // the read and the write fails here, and every other error path in this
    // file funnels through describeDBusError because that string is what the
    // user is shown.
    const props = await adapterProps(opts);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await props.Set(ADAPTER, 'Powered', new dbus.Variant('b', Boolean(on)));
        break;
      } catch (err) {
        const busy = /\.Busy\b/i.test(describeDBusError(err));
        if (!on || !busy || attempt >= BUSY_RETRIES) throw err;
        await sleepFn(BUSY_RETRY_MS);
      }
    }
  } catch (err) {
    // polkit denials and a hardware-blocked radio land here. The user must see
    // the real reason: "could not turn on Bluetooth" with no cause is
    // unactionable.
    throw new Error(describeDBusError(err));
  }
  return Boolean(on);
}

async function onPower(cb, opts = {}) {
  let props;
  try {
    props = await adapterProps(opts);
  } catch (err) {
    // Absent adapter reads as "nothing to subscribe to", exactly as getPower
    // reads it as null - and for a sharper reason: ipc.js subscribes
    // fire-and-forget, so on a machine with no adapter (precisely the machine
    // onboarding state 1a exists to serve) a rejection here is an unhandled
    // rejection, which Node >= 15 turns into a dead main process at startup.
    if (isAdapterAbsent(err)) return () => {};
    throw new Error(describeDBusError(err));
  }
  const handler = (iface, changed) => {
    if (iface !== ADAPTER) return;
    const c = unwrap(changed);
    if ('Powered' in c) cb(Boolean(c.Powered));
  };
  props.on('PropertiesChanged', handler);
  return () => props.off('PropertiesChanged', handler);
}

const OM_PATH = '/';
const OM = 'org.freedesktop.DBus.ObjectManager';
const SCAN_TICK_MS = 1500;

function readDevice(ifaces) {
  const d = ifaces['org.bluez.Device1'];
  if (!d) return null;
  const p = unwrap(d);
  if (!p.Address) return null;
  return {
    mac: String(p.Address).toUpperCase(),
    name: p.Alias || p.Name || String(p.Address).toUpperCase(),
    icon: p.Icon ?? null,
    cls: typeof p.Class === 'number' ? p.Class : null,
    paired: Boolean(p.Paired),
    connected: Boolean(p.Connected),
    rssi: typeof p.RSSI === 'number' ? p.RSSI : null,
  };
}

// Exported for tests. `state.last` maps mac -> the JSON we last emitted, which
// is what makes this emit on CHANGE rather than on every tick - the renderer
// would otherwise rebuild its list 40 times a minute and fight the cursor.
// `state.last` is a Map so a mac already seen keeps its original insertion
// position on update: only a new mac is appended, only a vanished mac is
// removed. That keeps device order first-seen-stable across polls, even
// though GetManagedObjects' own key order is not a promise BlueZ makes.
async function _pollOnce(state, om, emit) {
  const objects = await om.GetManagedObjects();
  const present = new Set();
  for (const ifaces of Object.values(objects)) {
    const dev = readDevice(ifaces);
    if (!dev) continue;
    present.add(dev.mac);
    const key = JSON.stringify(dev);
    if (state.last.get(dev.mac) === key) continue;
    state.last.set(dev.mac, key);
    emit(dev);
  }
  for (const mac of [...state.last.keys()]) {
    if (present.has(mac)) continue;
    state.last.delete(mac);
    emit({ mac, gone: true });
  }
}

const discovered = createEmitter();
let scanState = null;

async function startScan(opts = {}) {
  if (scanState) return;
  // Claim the slot SYNCHRONOUSLY, before any await. Two proxy resolutions
  // and a StartDiscovery call follow, and a concurrent stopScan() reads
  // scanState with no await of its own - if we claimed it only after those
  // awaits, a stopScan() landing in the gap would see nothing running (and
  // do nothing) while this call went on to start discovery unopposed.
  const state = { last: new Map(), timer: null };
  scanState = state;
  const { getInterfaceFn = getInterface, systemBusFn = systemBus } = opts;
  const bus = systemBusFn();
  let adapter;
  let om;
  try {
    adapter = await getInterfaceFn(bus, BLUEZ, ADAPTER_PATH, ADAPTER);
    om = await getInterfaceFn(bus, BLUEZ, OM_PATH, OM);
  } catch (err) {
    // Release only OUR claim: scanState may already be null (a stopScan
    // beat us) or may belong to a different startScan that claimed it after
    // us, and nulling either of those out from under it is the other race.
    if (scanState === state) scanState = null;
    // describeDBusError like every other error path here: this message is
    // rendered verbatim by the onboarding card's error banner.
    throw new Error(describeDBusError(err));
  }
  if (scanState !== state) return; // a stopScan already cancelled us
  try {
    await adapter.StartDiscovery();
  } catch (err) {
    if (scanState === state) scanState = null;
    throw new Error(describeDBusError(err));
  }
  if (scanState !== state) {
    // Two ways to lose the claim, and only one means discovery is ours to
    // stop. Cleared outright: a stopScan superseded us, ran its own
    // StopDiscovery before our StartDiscovery resolved, and ours is now an
    // orphan we must undo. Taken over by a different state: that owner
    // started its own discovery on this same shared bus connection, and
    // stopping here would silently kill a live scan that is not ours.
    if (scanState === null) await adapter.StopDiscovery().catch(() => {});
    return;
  }
  const tick = async () => {
    if (scanState !== state) return;
    // A failed poll must not kill the scan loop: BlueZ briefly rejects
    // GetManagedObjects while an adapter is resetting.
    await _pollOnce(state, om, (d) => discovered.emit(d)).catch(() => {});
    if (scanState === state) state.timer = setTimeout(tick, SCAN_TICK_MS);
  };
  await tick();
}

async function stopScan(opts = {}) {
  const state = scanState;
  scanState = null;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  const { getInterfaceFn = getInterface, systemBusFn = systemBus } = opts;
  try {
    const adapter = await getInterfaceFn(systemBusFn(), BLUEZ, ADAPTER_PATH, ADAPTER);
    await adapter.StopDiscovery();
  } catch { /* adapter already gone, or never started */ }
}

// Drops the BlueZ bond, which is what makes "Forget this handset" mean forget
// rather than merely unbind. RemoveDevice disconnects implicitly, so there is
// no separate disconnect step.
//
// Deliberately NOT wrapped in stopScan's `catch {}`: this is the one adapter
// call that changes state outside Konnect, and a caller that cleared its own
// binding while the handset stayed paired needs to be able to say so. Failure
// policy lives in index.js's forgetDevice, not here.
//
// devicePathFor throws on an address that does not parse, before any bus call
// - asking BlueZ to remove a path we cannot name is not a thing to attempt.
async function removeDevice(mac, opts = {}) {
  const { getInterfaceFn = getInterface, systemBusFn = systemBus } = opts;
  const devicePath = devicePathFor(mac);
  const adapter = await getInterfaceFn(systemBusFn(), BLUEZ, ADAPTER_PATH, ADAPTER);
  await adapter.RemoveDevice(devicePath);
}

function onDiscovered(cb) { return discovered.on(cb); }

module.exports = {
  getPower, setPower, onPower, startScan, stopScan, onDiscovered, removeDevice,
  ADAPTER_PATH, _pollOnce,
};
