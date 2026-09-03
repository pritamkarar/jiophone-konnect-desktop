'use strict';
const {
  systemBus, devicePathFor, unwrap, getInterface, isAbsentError, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const BLUEZ = 'org.bluez';
const PROPS = 'org.freedesktop.DBus.Properties';

// BlueZ owns connection state and the model name.
//
// Battery is NOT reliably here. BlueZ populates org.bluez.Battery1 from the
// HFP battery indicator it receives as the HFP handler - but in this project
// oFono owns the HFP connection, so BlueZ never sees the indicator and drops
// the interface entirely. Verified on the target handset: Battery1 is absent
// while oFono reports BatteryChargeLevel. This read stays as an opportunistic
// fallback; the real source is oFono's Handsfree interface (Task 5).
//
// listDevices needs no device path - it walks BlueZ's whole object tree - so
// it must remain reachable when no handset is bound. Without this the wizard
// could never show a list on a machine that has never chosen a device.
async function listDevicesUnbound(getInterfaceFn = getInterface, systemBusFn = systemBus) {
  const bus = systemBusFn();
  const om = await getInterfaceFn(bus, BLUEZ, '/', 'org.freedesktop.DBus.ObjectManager');
  const objects = await om.GetManagedObjects();
  const out = [];
  for (const ifaces of Object.values(objects)) {
    const d = ifaces['org.bluez.Device1'];
    if (!d) continue;
    const p = unwrap(d);
    out.push({
      mac: p.Address, name: p.Alias || p.Name || p.Address,
      paired: Boolean(p.Paired), connected: Boolean(p.Connected),
    });
  }
  return out;
}

// getInterfaceFn/systemBusFn are injection seams with real defaults. They
// exist so connect(mac)'s path selection can be regression-tested without
// opening the system bus - a test that called the real one would genuinely
// dial whichever handset it targeted.
function createDeviceMonitor({
  mac, getInterfaceFn = getInterface, systemBusFn = systemBus,
} = {}) {
  const emitter = createEmitter();
  const path = devicePathFor(mac);
  let propsIface = null;
  let ensuring = null;
  let onChanged = null;

  function ensure() {
    if (propsIface) return Promise.resolve(propsIface);
    // Memoise the in-flight PROMISE, not just its result. getStatus() is fired
    // on every PropertiesChanged and BlueZ emits several in a burst during a
    // connect, so concurrent callers would each build their own proxy and
    // register their own listener - of which only the last is tracked, leaving
    // the rest attached forever. Measured: 5 concurrent calls leak 4 listeners
    // without this, 0 with it.
    if (ensuring) return ensuring;
    const p = (async () => {
      const bus = systemBusFn();
      const iface = await getInterfaceFn(bus, BLUEZ, path, PROPS);
      onChanged = (name, changed) => {
        if (name !== 'org.bluez.Device1' && name !== 'org.bluez.Battery1') return;
        emitter.emit(unwrap(changed));
      };
      iface.on('PropertiesChanged', onChanged);
      propsIface = iface;
      return iface;
    })();
    ensuring = p;
    // Clear on failure so a later call retries instead of reusing a dead promise.
    p.catch(() => { if (ensuring === p) ensuring = null; });
    return p;
  }

  // Returns {props, error}. An absent interface is normal here - BlueZ drops
  // org.bluez.Battery1 entirely because oFono owns HFP - so that stays quiet.
  // Anything else (bus unreachable, bluetoothd restarting) is a real fault and
  // must NOT masquerade as "the handset is disconnected".
  async function readAll(ifaceName) {
    try {
      const proxy = await ensure();
      return { props: unwrap(await proxy.GetAll(ifaceName)), error: null };
    } catch (err) {
      return isAbsentError(err)
        ? { props: {}, error: null }
        : { props: {}, error: describeDBusError(err) };
    }
  }

  return {
    async getStatus() {
      const dev = await readAll('org.bluez.Device1');
      const bat = await readAll('org.bluez.Battery1');
      const error = dev.error || bat.error || null;
      if (error) console.error('[konnect] BlueZ read failed:', error);
      return {
        connected: Boolean(dev.props.Connected),
        model: dev.props.Alias || dev.props.Name || null,
        battery: typeof bat.props.Percentage === 'number' ? bat.props.Percentage : null,
        error,
      };
    },

    listDevices() { return listDevicesUnbound(getInterfaceFn, systemBusFn); },

    // Honours an explicit MAC so a device chosen from listDevices() can be
    // connected, not just the configured default. Silently ignoring the
    // argument would connect to the wrong handset.
    async connect(targetMac) {
      const bus = systemBusFn();
      const target = targetMac ? devicePathFor(targetMac) : path;
      const dev = await getInterfaceFn(bus, BLUEZ, target, 'org.bluez.Device1');
      await dev.Connect();
    },

    async disconnect() {
      const bus = systemBusFn();
      const dev = await getInterfaceFn(bus, BLUEZ, path, 'org.bluez.Device1');
      await dev.Disconnect();
    },

    onChange(cb) { return emitter.on(cb); },

    dispose() {
      if (propsIface && onChanged) propsIface.off('PropertiesChanged', onChanged);
      propsIface = null;
      // Clear the memo too, or a later ensure() hands back the stale promise
      // whose listener was just detached - reads would work while change
      // notifications stayed permanently dead.
      ensuring = null;
      onChanged = null;
    },
  };
}

createDeviceMonitor.listDevicesUnbound = listDevicesUnbound;

module.exports = { createDeviceMonitor };
