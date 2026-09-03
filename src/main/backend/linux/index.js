'use strict';
const { createDeviceMonitor } = require('./device');
const { createTelephony, verifyLinkFor } = require('./telephony');
const { createRecorder } = require('./recorder');
const { createOppReceiver } = require('./opp');
const { createEmitter } = require('../interface');
const audio = require('./audio');
const adapter = require('./adapter');
const { createPairing } = require('./pairing');
const { shouldReconnect } = require('../../device-select');

const STATUS_POLL_MS = 30000;

const NO_HANDSET = 'No handset selected';

// One pairing instance per process: the agent is a bus-name registration, not
// a per-handset object, and registering twice would fail the second time.
const pairing = createPairing();

// Assembled from adapter.js and pairing.js, mirroring how `audio` is
// assembled. Identical in both branches BECAUSE onboarding runs in the
// unbound one - see spec §4.1.
function adapterNamespace() {
  return {
    getPower: () => adapter.getPower(),
    setPower: (on) => adapter.setPower(on),
    onPower: (cb) => adapter.onPower(cb),
    startScan: () => adapter.startScan(),
    stopScan: () => adapter.stopScan(),
    onDiscovered: (cb) => adapter.onDiscovered(cb),
    removeDevice: (mac) => adapter.removeDevice(mac),
    registerAgent: () => pairing.register(),
    unregisterAgent: () => pairing.unregister(),
    pair: (mac) => pairing.pair(mac),
    confirm: (ok) => pairing.confirm(ok),
    onPairingRequest: (cb) => pairing.onRequest(cb),
  };
}

function createUnboundBackend() {
  const statusEmitter = createEmitter();
  const reject = async () => { throw new Error(NO_HANDSET); };
  return {
    // The one capability that must still work with no device bound.
    listDevices: () => createDeviceMonitor.listDevicesUnbound(),
    audio: {
      listAudioDevices: () => audio.listAudioDevices(),
      getPcVolume: (n) => audio.getPcVolume(n),
      setPcVolume: (n, p) => audio.setPcVolume(n, p),
      getMicMute: (n) => audio.getMicMute(n),
      setMicMute: (n, on) => audio.setMicMute(n, on),
      startRing: (o) => audio.startRing(o),
      stopRing: () => audio.stopRing(),
      // routingEmitter is module-level in audio.js, not tied to a bound
      // handset, so this stays available even with no device paired - the
      // same reason ipc.js's `if (backend.audio)` subscription must not
      // throw when the backend is unbound.
      onRouting: (cb) => audio.onRouting(cb),
    },
    adapter: adapterNamespace(),
    connect: reject,
    disconnect: reject,
    async getStatus() {
      return {
        connected: false, model: null, battery: null, signal: null,
        operator: null, roaming: false, error: NO_HANDSET,
      };
    },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },
    dial: reject, answer: reject, hangup: reject, sendDtmf: reject,
    onCall() { return () => {}; },
    startContactImport: reject, cancelContactImport: async () => {},
    onContacts() { return () => {}; },
    startRecording: reject, stopRecording: async () => null,
    // A user with nothing bound must still be able to verify the handset
    // they just picked in the wizard - that is the whole point of targetMac.
    // With no mac at all (e.g. Settings' own Verify, which never passes one
    // while unbound) there is nothing to probe.
    verifyLink: (targetMac) => (targetMac
      ? verifyLinkFor(targetMac)
      : Promise.resolve({ ok: false, reason: NO_HANDSET, checks: [] })),
    getCallVolume: async () => ({ speaker: null, microphone: null, muted: false, error: NO_HANDSET }),
    setCallVolume: reject,
    onCallVolume() { return () => {}; },
    async ensureOnline() { throw new Error(NO_HANDSET); },
    // audio.stopRing() is module-level state shared with the bound backend -
    // a ring:test fired while unbound (no handset paired yet) must not
    // outlive the app either. Same for adapter/pairing: onboarding runs in
    // THIS branch, so a scan or an agent registration started from here is
    // exactly as likely to be live at teardown as in the bound branch - a
    // leaked discovery drains the handset battery and degrades every other
    // Bluetooth link on the machine, and a leaked agent blocks the next one.
    async dispose() {
      await adapter.stopScan().catch(() => {});
      await pairing.unregister().catch(() => {});
      audio.stopRing();
    },
  };
}

function createLinuxBackend({ mac = null, getSetting = () => null } = {}) {
  // mac === null is a real state: nothing is paired, or the user has not
  // chosen yet. Every path helper throws on a null mac by design, so build a
  // backend that answers honestly instead of constructing D-Bus proxies for
  // a device that does not exist. listDevices still works - it is how the
  // wizard populates its picker.
  if (!mac) return createUnboundBackend();

  const device = createDeviceMonitor({ mac });
  const telephony = createTelephony({ mac });
  const recorder = createRecorder();
  const opp = createOppReceiver({ mac });
  const statusEmitter = createEmitter();
  let statusPoll = null;
  // Guards against a slow Connect() stacking on the next poll tick.
  let reconnecting = false;

  const api = {
    listDevices: () => device.listDevices(),
    connect: (m) => device.connect(m),
    disconnect: () => device.disconnect(),
    audio: {
      listAudioDevices: () => audio.listAudioDevices(),
      getPcVolume: (n) => audio.getPcVolume(n),
      setPcVolume: (n, p) => audio.setPcVolume(n, p),
      getMicMute: (n) => audio.getMicMute(n),
      setMicMute: (n, on) => audio.setMicMute(n, on),
      startRing: (o) => audio.startRing(o),
      stopRing: () => audio.stopRing(),
      onRouting: (cb) => audio.onRouting(cb),
    },
    adapter: adapterNamespace(),

    async getStatus() {
      const [d, n, b] = await Promise.all([
        device.getStatus(), telephony.getNetwork(), telephony.getBattery(),
      ]);
      return {
        connected: d.connected,
        model: d.model,
        // oFono first: BlueZ's Battery1 is absent while oFono owns HFP.
        battery: b.battery ?? d.battery,
        signal: n.signal, operator: n.operator, roaming: n.roaming,
        // A BlueZ fault outranks an oFono one: if the device link is down,
        // "handset modem offline" is a symptom, not the cause.
        error: d.error ?? n.error ?? b.error ?? null,
      };
    },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },

    dial: (number) => telephony.dial(number),
    answer: (id) => telephony.answer(id),
    hangup: (id) => telephony.hangup(id),
    sendDtmf: (d) => telephony.sendDtmf(d),
    onCall: (cb) => telephony.onCall(cb),

    startContactImport: () => opp.start(),
    cancelContactImport: () => opp.cancel(),
    onContacts: (cb) => opp.onContacts(cb),

    startRecording: (callId) => recorder.start(callId),
    stopRecording: (callId) => recorder.stop(callId),

    // All four delegate straight to telephony.js. verifyLink forwards
    // targetMac so the wizard can check a handset that isn't bound yet (see
    // telephony.js's verifyLink/verifyLinkFor).
    verifyLink: (targetMac) => telephony.verifyLink(targetMac),
    getCallVolume: () => telephony.getCallVolume(),
    setCallVolume: (patch) => telephony.setCallVolume(patch),
    onCallVolume: (cb) => telephony.onCallVolume(cb),

    async ensureOnline() { return telephony.ensureOnline(); },
    // opp.cancel() unregisters the OBEX agent - this PC must not be a
    // standing drop target as a property of our own code, not merely
    // because obexd's disconnect watch happens to clean up after us.
    // Each step is isolated: a throw in one used to skip every later one, so
    // a failure in device/telephony teardown orphaned the recorder's
    // pw-record and ffmpeg children. Returns the OBEX unregister so the
    // caller can await it - see the bounded race in index.js.
    async dispose() {
      // A leaked discovery drains the handset battery and degrades every
      // other Bluetooth link on the machine.
      await adapter.stopScan().catch(() => {});
      await pairing.unregister().catch(() => {});
      if (statusPoll) clearInterval(statusPoll);
      statusPoll = null;
      for (const step of [device.dispose, telephony.dispose, recorder.dispose, audio.stopRing]) {
        try { step(); } catch (err) { console.error('[konnect] dispose step failed:', err.message); }
      }
      return opp.cancel().catch(() => {});
    },
  };

  device.onChange(async () => { statusEmitter.emit(await api.getStatus()); });

  // Routing is applied at call start because the SCO nodes do not exist before
  // then - there is nothing to link to while the line is idle. This fires on
  // the SAME trigger as recording (first transition to `active`) so the two
  // cannot disagree about when call audio exists, and it runs whether or not
  // recording is enabled.
  const routed = new Set();
  telephony.onCall((call) => {
    if (call.state === 'disconnected') { routed.delete(call.id); return; }
    if (call.state !== 'active' || routed.has(call.id)) return;
    routed.add(call.id);
    // Naming a device IS the opt-in to Konnect-owned routing; there is no
    // separate mode setting to agree with. Both pickers left on "System
    // default" means there is nothing to route, and routing anyway would link
    // nothing and then report that as a failure the user cannot act on.
    const sink = getSetting('audio_sink');
    const source = getSetting('audio_source');
    if (!sink && !source) return;
    audio.applyRouting({ sink, source })
      .catch((err) => console.error('[konnect] routing failed:', err.message));
  });

  // device.onChange is a BlueZ PropertiesChanged, and it is the ONLY thing
  // that fires statusEmitter - but battery, signal and operator all come from
  // oFono, which nothing subscribes to and nothing polls. Measured against the
  // live handset: 35s produced zero status events, so the status card and the
  // tray tooltip froze at their launch values for the whole session while the
  // battery actually moved. Polling getStatus is cheaper and more robust than
  // subscribing to NetworkRegistration and Handsfree separately, and it is
  // all reads with its own error classification.
  statusPoll = setInterval(async () => {
    try {
      const status = await api.getStatus();
      statusEmitter.emit(status);
      // Self-healing reconnect. index.js's reconnectHandset() fires exactly
      // once at startup, and under autostart-at-login that attempt lands in the
      // login-handoff window: the link comes up, then the outgoing session's
      // audio stack tears it down seconds later (verified on the target
      // machine - oFono SLC at 215s, BlueZ dropped it at 219s). Nothing else
      // ever retried, so the app sat on "handset modem offline" for the whole
      // session though the handset was paired, trusted and in range. Keyed off
      // the SETTING via the same predicate as the startup path, so first-run
      // onboarding still owns the initial connect and this never races its
      // wizard; the in-flight guard stops a slow Connect() from stacking.
      if (!reconnecting && shouldReconnect({
        storedMac: getSetting('device_mac'), connected: status.connected,
      })) {
        reconnecting = true;
        device.connect(mac)
          .catch((err) => console.warn('[konnect] poll reconnect failed:', err.message))
          .finally(() => { reconnecting = false; });
      }
    } catch (err) {
      console.error('[konnect] status poll failed:', err.message);
    }
  }, STATUS_POLL_MS);
  statusPoll.unref?.();

  return api;
}

module.exports = { createLinuxBackend };
