'use strict';
const { Variant } = require('dbus-next');
const {
  systemBus, modemPathFor, unwrap, getInterface, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const OFONO = 'org.ofono';

// oFono REMOVES its interfaces when the modem powers down, so a missing
// interface here does NOT mean "this feature is unavailable" the way BlueZ's
// absent Battery1 does - it means the handset link is down and the remedy is
// to reconnect. Reporting no operator and no signal with error: null would be
// indistinguishable from a phone that is connected but has no service.
// Verified against the live modem: dbus-next raises a plain Error (no .type)
// whose message is "interface not found in proxy object: org.ofono.X".
const MODEM_OFFLINE_RE = /interface not found in proxy object/i;

function describeTelephonyError(err) {
  const desc = describeDBusError(err);
  return MODEM_OFFLINE_RE.test(desc) ? 'handset modem offline' : desc;
}

// oFono call states observed on the handset during the phase 0 spike:
//   outgoing: dialing -> alerting -> active -> disconnected
//   incoming: incoming -> active -> disconnected
// StartTime appears only on the transition to active, which is why call
// duration must be measured from it and never from dial time.
const INBOUND_STATES = new Set(['incoming', 'waiting']);

// oFono has no Direction property, and both lifecycles above converge on
// 'active'. So direction can only be read from the FIRST state seen for a
// call - never from its current one.
function directionFor(rawProps) {
  return INBOUND_STATES.has((rawProps || {}).State || 'disconnected') ? 'in' : 'out';
}

function toCall(path, rawProps, direction) {
  const p = rawProps || {};
  const state = p.State || 'disconnected';
  return {
    id: path,
    // Latched by watchCall from the first state it ever saw for this path.
    // Deriving it from the current state made every ANSWERED incoming call
    // report 'out' the instant oFono moved it to 'active' - it logged, showed
    // and exported as Outgoing. A missed call never reaches 'active', which
    // is why this survived: only answered inbound calls were affected.
    // The fallback keeps direct callers working, and is the honest answer for
    // a call adopted mid-flight at startup, whose origin is unknowable.
    direction: direction || directionFor(p),
    state,
    number: p.LineIdentification || null,
    name: p.Name ? p.Name : null,
    startedAt: p.StartTime || null,
    // True for every member of a conference. Hanging one of them up needs
    // the manager, not the call (see hangup()).
    multiparty: p.Multiparty === true,
  };
}

function signalPercent(strength) {
  if (typeof strength !== 'number' || Number.isNaN(strength)) return null;
  return Math.max(0, Math.min(100, strength));
}

// CallVolume properties are D-Bus `y` (uint8). Out-of-range or non-numeric
// input must never reach SetProperty: dbus-next would either throw at
// marshal time or wrap around, and a wrapped value is a volume the user did
// not ask for on a device they are talking through.
function clampVolume(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

// Read-only. Three GetProperties calls, no state change, and above all no
// Dial: a wizard that rings the handset to prove the handset can ring is
// not an acceptable test.
//
// Standalone (not a method on a bound createTelephony()) so the wizard can
// verify a handset the user has SELECTED but not yet bound to - checking
// against modemPathFor(the bound mac) would certify a device the app is
// about to disconnect from, not the one about to be connected to.
async function verifyLinkFor(mac, { getInterfaceFn = getInterface, systemBusFn = systemBus } = {}) {
  const modemPath = modemPathFor(mac);
  async function iface(path, name) {
    return getInterfaceFn(systemBusFn(), OFONO, path, name);
  }
  const checks = [];
  let modem = null;
  try {
    const m = await iface(modemPath, 'org.ofono.Modem');
    modem = unwrap(await m.GetProperties());
    checks.push({ label: 'Handset modem is online', ok: modem.Online === true });
  } catch (err) {
    checks.push({ label: 'Handset modem is online', ok: false, detail: describeDBusError(err) });
  }
  const ifaces = (modem && modem.Interfaces) || [];
  checks.push({
    label: 'Telephony interface present',
    ok: ifaces.includes('org.ofono.VoiceCallManager'),
  });
  try {
    const cv = await iface(modemPath, 'org.ofono.CallVolume');
    await cv.GetProperties();
    checks.push({ label: 'Call volume readable', ok: true });
  } catch (err) {
    checks.push({ label: 'Call volume readable', ok: false, detail: describeDBusError(err) });
  }
  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, reason: failed ? failed.label : null, checks };
}

// getInterfaceFn/systemBusFn are injection seams with real defaults, the
// same pattern device.js uses - so call lifecycle and status reads can be
// regression-tested without opening the system bus.
function createTelephony({ mac, getInterfaceFn = getInterface, systemBusFn = systemBus }) {
  const emitter = createEmitter();
  const modemPath = modemPathFor(mac);
  const watched = new Map();   // call path -> { iface, handler }
  let managerIface = null;
  let starting = null;
  let handlers = null;

  async function iface(path, name) {
    return getInterfaceFn(systemBusFn(), OFONO, path, name);
  }

  // Powering the modem establishes the HFP connection. Never power it OFF to
  // work around an unrelated problem - it drops the whole ACL link and SDP
  // lookups then fail with "Unable to find service record" (spec section 2.2).
  async function ensureOnline() {
    const modem = await iface(modemPath, 'org.ofono.Modem');
    const props = unwrap(await modem.GetProperties());
    if (!props.Powered) {
      await modem.SetProperty('Powered', new (require('dbus-next').Variant)('b', true));
    }
    return true;
  }

  async function watchCall(path, initialProps) {
    if (watched.has(path)) return;
    const call = await iface(path, 'org.ofono.VoiceCall');
    const direction = directionFor(initialProps);
    const handler = (name, variant) => {
      const merged = { ...(watched.get(path)?.props || {}), [name]: variant.value };
      watched.set(path, { ...watched.get(path), props: merged });
      emitter.emit(toCall(path, merged, direction));
    };
    call.on('PropertyChanged', handler);
    watched.set(path, { iface: call, handler, props: initialProps, direction });
    emitter.emit(toCall(path, initialProps, direction));
  }

  function unwatchCall(path) {
    const entry = watched.get(path);
    if (!entry) return;
    entry.iface.off('PropertyChanged', entry.handler);
    watched.delete(path);
    // Only synthesize a terminal event if oFono did not already deliver one.
    // It normally sets State to 'disconnected' via PropertyChanged BEFORE
    // removing the call, so emitting again here hands every consumer two
    // identical terminal events for an ordinary hangup. The synthesis exists
    // for the case where a call vanishes with no terminal transition at all.
    // Correct under either ordering: exactly one terminal event each way.
    if (entry.props && entry.props.State !== 'disconnected') {
      emitter.emit({ ...toCall(path, entry.props, entry.direction), state: 'disconnected' });
    }
  }

  // Memoises the in-flight promise, not just its result - the same fix
  // device.js needed. onCall() calls start() lazily and dial() awaits it, so
  // two callers can overlap before the first proxy resolves; each would then
  // register its own CallAdded/CallRemoved listeners while only the last is
  // tracked, leaving the rest attached past dispose(). Measured: 3 concurrent
  // callers leak 4 listeners without this, 0 with it.
  function start() {
    if (managerIface) return Promise.resolve(managerIface);
    if (starting) return starting;
    const p = (async () => {
      const mgr = await iface(modemPath, 'org.ofono.VoiceCallManager');
      handlers = {
        added: (path, props) => { watchCall(path, unwrap(props)).catch(() => {}); },
        removed: (path) => unwatchCall(path),
      };
      mgr.on('CallAdded', handlers.added);
      mgr.on('CallRemoved', handlers.removed);
      managerIface = mgr;

      // Adopt any call already in progress when we attach.
      for (const [path, props] of await mgr.GetCalls()) {
        await watchCall(path, unwrap(props));
      }
      return mgr;
    })();
    starting = p;
    p.catch(() => { if (starting === p) starting = null; });
    return p;
  }

  return {
    ensureOnline,

    // One GetProperties, three answers. Battery comes from HFP's 0-5
    // `battchg` indicator (BlueZ's Battery1 is absent while oFono owns HFP,
    // see device.js); 20% per level matches what BlueZ reported before oFono
    // took over. Features is oFono's list of what the handset's AG advertised
    // (the F120B: three-way-calling, release-all-held, create-multiparty) and
    // gates the hold/swap/merge buttons. SubscriberNumbers is optional in
    // oFono and absent on the F120B, which answers AT+CNUM with nothing.
    async getHandsfree() {
      try {
        const hf = await iface(modemPath, 'org.ofono.Handsfree');
        const p = unwrap(await hf.GetProperties());
        const level = p.BatteryChargeLevel;
        return {
          battery: typeof level === 'number' ? Math.max(0, Math.min(100, level * 20)) : null,
          features: Array.isArray(p.Features) ? p.Features : [],
          numbers: Array.isArray(p.SubscriberNumbers) ? p.SubscriberNumbers : [],
          error: null,
        };
      } catch (err) {
        return { battery: null, features: [], numbers: [], error: describeTelephonyError(err) };
      }
    },

    async getNetwork() {
      try {
        const net = await iface(modemPath, 'org.ofono.NetworkRegistration');
        const p = unwrap(await net.GetProperties());
        return {
          operator: p.Name || null,
          signal: signalPercent(p.Strength),
          roaming: p.Status === 'roaming',
          error: null,
        };
      } catch (err) {
        return {
          operator: null, signal: null, roaming: false,
          error: describeTelephonyError(err),
        };
      }
    },

    async dial(number) {
      await ensureOnline();
      // start() returns the manager proxy, so there is no second round-trip.
      const mgr = await start();
      const path = await mgr.Dial(number, 'default');
      return path;
    },

    async answer(callId) {
      const call = await iface(callId, 'org.ofono.VoiceCall');
      await call.Answer();
    },

    async hangup(callId) {
      const call = await iface(callId, 'org.ofono.VoiceCall');
      await call.Hangup();
    },

    async sendDtmf(digits) {
      const mgr = await iface(modemPath, 'org.ofono.VoiceCallManager');
      await mgr.SendTones(String(digits));
    },

    onCall(cb) { start().catch(() => {}); return emitter.on(cb); },

    // targetMac lets the wizard verify a handset it has selected but not yet
    // bound to (verifyLinkFor probes ITS path, not this telephony's own).
    // Falls back to the bound mac so the existing Setup view - which checks
    // the bound device - is unchanged.
    verifyLink(targetMac) {
      return verifyLinkFor(targetMac || mac, { getInterfaceFn, systemBusFn });
    },

    async getCallVolume() {
      try {
        const cv = await iface(modemPath, 'org.ofono.CallVolume');
        const p = unwrap(await cv.GetProperties());
        return {
          speaker: p.SpeakerVolume ?? null,
          microphone: p.MicrophoneVolume ?? null,
          muted: Boolean(p.Muted),
          error: null,
        };
      } catch (err) {
        // Nulls, not zeros. A slider parked at 0 for a failed read is
        // indistinguishable from a handset genuinely muted.
        return { speaker: null, microphone: null, muted: false, error: describeTelephonyError(err) };
      }
    },

    async setCallVolume(patch) {
      const cv = await iface(modemPath, 'org.ofono.CallVolume');
      if (patch.speaker !== undefined) {
        await cv.SetProperty('SpeakerVolume', new Variant('y', clampVolume(patch.speaker)));
      }
      if (patch.microphone !== undefined) {
        await cv.SetProperty('MicrophoneVolume', new Variant('y', clampVolume(patch.microphone)));
      }
      if (patch.muted !== undefined) {
        await cv.SetProperty('Muted', new Variant('b', Boolean(patch.muted)));
      }
    },

    // The handset pushes its own volume-key presses back over HFP, so the
    // sliders have to follow rather than fight them.
    async onCallVolume(cb) {
      const cv = await iface(modemPath, 'org.ofono.CallVolume');
      let state = unwrap(await cv.GetProperties());
      const handler = (name, variant) => {
        state = { ...state, [name]: variant.value };
        cb({
          speaker: state.SpeakerVolume ?? null,
          microphone: state.MicrophoneVolume ?? null,
          muted: Boolean(state.Muted),
          error: null,
        });
      };
      cv.on('PropertyChanged', handler);
      // A real unsubscribe, not a fake one - ipc.js retries attaching this
      // on reconnect, and a no-op here would let listeners pile up across a
      // session that disconnects and reconnects more than once.
      return () => cv.off('PropertyChanged', handler);
    },

    dispose() {
      for (const path of [...watched.keys()]) {
        const entry = watched.get(path);
        entry.iface.off('PropertyChanged', entry.handler);
        watched.delete(path);
      }
      if (managerIface && handlers) {
        managerIface.off('CallAdded', handlers.added);
        managerIface.off('CallRemoved', handlers.removed);
      }
      managerIface = null;
      // Clear the memo too, or a later start() returns the stale promise whose
      // listeners were just detached.
      starting = null;
      handlers = null;
    },
  };
}

module.exports = {
  toCall, directionFor, signalPercent, createTelephony, describeTelephonyError, clampVolume,
  verifyLinkFor,
};
