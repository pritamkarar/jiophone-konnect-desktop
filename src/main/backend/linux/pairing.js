'use strict';
const dbus = require('dbus-next');
const {
  systemBus, getInterface, devicePathFor, macFromPath, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const BLUEZ = 'org.bluez';
const AGENT_PATH = '/konnect/pairing/agent';
const PROPS = 'org.freedesktop.DBus.Properties';
// KeyboardDisplay is what makes BlueZ choose numeric comparison - the
// six-digit code shown on both sides - which is exactly the canvas's 1d.
const CAPABILITY = 'KeyboardDisplay';

function createPairing({ getInterfaceFn = getInterface, systemBusFn = systemBus } = {}) {
  const requests = createEmitter();
  let pending = null;      // { resolve, reject } for the open Agent1 reply
  let targetMac = null;    // the ONLY device we will auto-authorise
  let registered = false;
  let agent = null;

  const { Interface } = dbus.interface;

  // A still-open reply must always be settled before `pending` is dropped or
  // overwritten - otherwise that Promise (and the BlueZ caller awaiting its
  // D-Bus reply) hangs forever. Every place that clears/replaces `pending`
  // routes through here so that rule lives in one spot.
  function settlePending(type, message) {
    if (!pending) return;
    const p = pending;
    pending = null;
    p.reject(new dbus.DBusError(`${BLUEZ}.${type}`, message));
  }

  class KonnectPairingAgent extends Interface {
    // Numeric comparison. Hold the D-Bus reply open until the user answers.
    RequestConfirmation(devicePath, passkey) {
      // A second request while one is still open would otherwise silently
      // abandon the first caller's reply - settle it before overwriting.
      settlePending('Error.Rejected', 'superseded by a new pairing request');
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        requests.emit({
          mac: macFromPath(devicePath),
          passkey: String(passkey).padStart(6, '0'),
        });
      });
    }

    // Legacy PIN handsets. Spec 5.1: RequestPinCode must always go to the
    // user, never be silently answered. Konnect's pairing screen is numeric
    // comparison only (R4) - there is no PIN-entry UI to route this to, so
    // we reject with an actionable message rather than guess a PIN and send
    // it to an unverified peer. The user falls back to system Bluetooth
    // settings for this handset.
    // async so a synchronous throw here becomes a rejected Promise rather
    // than a same-tick JS exception - real dbus-next dispatch handles both
    // (handlers.js wraps the call in try/catch either way), but callers that
    // invoke this member directly - the test harness, matching the pattern
    // used throughout this codebase's D-Bus mocks - need a Promise to reject.
    async RequestPinCode() {
      throw new dbus.DBusError(
        `${BLUEZ}.Error.Rejected`,
        'this handset requires a legacy PIN, which Konnect does not support - pair it in your system Bluetooth settings');
    }

    // The same rule as RequestPinCode, for the rest of the Agent1 surface we
    // deliberately do not implement. Without these, a display-only or
    // keyboard-only remote gets org.freedesktop.DBus.Error.UnknownMethod,
    // which reaches the user as an opaque failure with nothing to do about
    // it; the message below at least names the way out. async for the same
    // reason as RequestPinCode above.
    async RequestPasskey() {
      throw new dbus.DBusError(
        `${BLUEZ}.Error.Rejected`,
        'this handset asks Konnect to type a passkey, which it cannot do - pair it in your system Bluetooth settings');
    }

    async DisplayPinCode() {
      throw new dbus.DBusError(
        `${BLUEZ}.Error.Rejected`,
        'this handset requires a legacy PIN, which Konnect does not support - pair it in your system Bluetooth settings');
    }

    // Not AuthorizeService: this is the no-input just-works variant, where
    // nothing on either side identifies WHICH device is asking beyond a path
    // we never showed the user. Auto-approving it would be the standing
    // security hole AuthorizeService exists to avoid.
    async RequestAuthorization() {
      throw new dbus.DBusError(
        `${BLUEZ}.Error.Rejected`,
        'this handset cannot show a pairing code, so Konnect cannot confirm it - pair it in your system Bluetooth settings');
    }

    DisplayPasskey(devicePath, passkey) {
      requests.emit({
        mac: macFromPath(devicePath),
        passkey: String(passkey).padStart(6, '0'),
      });
    }

    // The ONLY method answered without asking the user, and only for the
    // device the user is actively pairing. An agent that authorises any
    // caller is a standing security hole. async for the same reason as
    // RequestPinCode above - a rejected Promise, not a same-tick throw.
    async AuthorizeService(devicePath) {
      const mac = macFromPath(devicePath);
      if (!targetMac || mac !== targetMac) {
        throw new dbus.DBusError(`${BLUEZ}.Error.Rejected`, 'not the device being paired');
      }
    }

    Cancel() { settlePending('Error.Canceled', 'cancelled'); }

    // BlueZ calls Release after the agent is already unregistered (spec:
    // "there is no need to unregister the agent, because when this method
    // gets called it has already been unregistered"). If a RequestConfirmation
    // or RequestPinCode reply is still open at that point, it must still be
    // settled - leaving it pending would dangle that Promise forever (nothing
    // else will ever resolve it) and make a later confirm() call a silent
    // no-op, since confirm() only acts when `pending` is set.
    Release() { settlePending('Error.Canceled', 'agent released'); }
  }

  KonnectPairingAgent.configureMembers({
    methods: {
      RequestConfirmation: { inSignature: 'ou', outSignature: '' },
      RequestPinCode: { inSignature: 'o', outSignature: 's' },
      RequestPasskey: { inSignature: 'o', outSignature: 'u' },
      DisplayPinCode: { inSignature: 'os', outSignature: '' },
      RequestAuthorization: { inSignature: 'o', outSignature: '' },
      DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
      AuthorizeService: { inSignature: 'os', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
      Release: { inSignature: '', outSignature: '' },
    },
  });

  return {
    // Returns false rather than throwing: spec 7.1 requires onboarding to
    // degrade to the shipped select-and-connect flow when another agent
    // (GNOME, KDE) already holds the name.
    async register() {
      if (registered) return true;
      const bus = systemBusFn();
      agent = new KonnectPairingAgent(`${BLUEZ}.Agent1`);
      bus.export(AGENT_PATH, agent);
      try {
        const mgr = await getInterfaceFn(bus, BLUEZ, '/org/bluez', 'org.bluez.AgentManager1');
        // Deliberately NOT RequestDefaultAgent - that would make Konnect the
        // pairing handler for the whole desktop, including prompts started
        // from GNOME or KDE settings (spec 5.2).
        await mgr.RegisterAgent(AGENT_PATH, CAPABILITY);
      } catch {
        // The export above is unconditional, so this is never "not exported
        // yet" - it swallows an unexport that itself fails (a bus already
        // torn down), which must not mask the registration failure we are
        // reporting by returning false.
        try { bus.unexport(AGENT_PATH, agent); } catch { /* bus already gone */ }
        agent = null;
        return false;
      }
      registered = true;
      return true;
    },

    async unregister() {
      if (!registered) return;
      registered = false;
      settlePending('Error.Canceled', 'agent unregistered');
      const bus = systemBusFn();
      try {
        const mgr = await getInterfaceFn(bus, BLUEZ, '/org/bluez', 'org.bluez.AgentManager1');
        await mgr.UnregisterAgent(AGENT_PATH);
      } catch { /* already gone */ }
      // Separate try: `registered` is already false, so nothing will unexport
      // this object later. Sharing a try with UnregisterAgent above meant a
      // throw from bluetoothd (restarting, bus lost) stranded our Agent1
      // object on the bus for the life of the process.
      try { bus.unexport(AGENT_PATH, agent); } catch { /* bus already gone */ }
      agent = null;
    },

    setTarget(mac) { targetMac = mac ? String(mac).toUpperCase() : null; },

    async pair(mac) {
      targetMac = String(mac).toUpperCase();
      try {
        const device = await getInterfaceFn(systemBusFn(), BLUEZ, devicePathFor(mac), 'org.bluez.Device1');
      await device.Pair();
      // Trust the handset, exactly as GNOME's and KDE's Bluetooth panels do
      // on a successful pair. Without it BlueZ asks an agent to authorise
      // every service the phone offers, and THIS agent deliberately answers
      // only for the device being paired right now (see AuthorizeService) -
      // so the phone's own reconnection attempts are refused for the rest of
      // time, oFono's HFP modem never powers on, and the dialer reports
      // "handset modem offline" on a handset whose Bluetooth is plainly on.
      //
      // Best-effort: the bond already exists by this line. Throwing would
      // tell onboarding the pairing failed when the handset is in fact
      // paired, sending the user to retry something that would then come
      // back "already paired". Logged loudly instead - silence here is what
      // made the original bug take a full forget/re-pair cycle to notice.
      try {
        const props = await getInterfaceFn(
          systemBusFn(), BLUEZ, devicePathFor(mac), PROPS);
        await props.Set('org.bluez.Device1', 'Trusted', new dbus.Variant('b', true));
      } catch (err) {
        console.warn('[konnect] paired, but could not mark the handset trusted:',
          describeDBusError(err));
      }
      } catch (err) {
        throw new Error(describeDBusError(err));
      } finally {
        // The auto-authorise window closes with the pairing attempt, win or
        // lose. Left set, AuthorizeService keeps silently approving this mac
        // for the rest of the process - long after the user stopped pairing
        // anything - which is the standing hole targetMac exists to close.
        targetMac = null;
      }
    },

    confirm(ok) {
      if (!pending) return;
      const p = pending;
      pending = null;
      if (ok) p.resolve();
      else p.reject(new dbus.DBusError(`${BLUEZ}.Error.Rejected`, 'user declined'));
    },

    onRequest(cb) { return requests.on(cb); },
  };
}

module.exports = { createPairing, AGENT_PATH };
