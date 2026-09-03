'use strict';
const { createEmitter } = require('../interface');

const MOCK_CONTACTS = [
  { uid: 'mock-1', name: 'Amit Sharma', numbers: ['+919876543210'] },
  { uid: 'mock-2', name: 'Priya Nair', numbers: ['+919812345678'] },
];

// Drives the renderer with no hardware. Call states advance on timers that
// mirror the real oFono sequence observed in the phase 0 spike.
function createMockBackend() {
  const statusEmitter = createEmitter();
  const callEmitter = createEmitter();
  const contactsEmitter = createEmitter();
  const timers = new Set();
  const recorded = new Set();
  let seq = 0;
  let current = null;

  const later = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  let importTimer = null;

  const status = {
    connected: true, model: 'F120B', battery: 80,
    signal: 100, operator: 'JIO', roaming: false, error: null,
  };

  function emitCall(state, extra = {}) {
    if (!current) return;
    current = { ...current, state, ...extra };
    callEmitter.emit(current);
  }

  return {
    async listDevices() {
      // Placeholder address: the mock must not carry the real handset's
      // BD_ADDR. The real address belongs in settings and test fixtures.
      return [{ mac: '00:11:22:33:44:55', name: 'F120B (mock)', paired: true, connected: true }];
    },
    async connect() {},
    async disconnect() {},
    async getStatus() { return { ...status }; },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },

    async dial(number) {
      const id = `mock-call-${++seq}`;
      current = { id, direction: 'out', state: 'dialing', number, name: null, startedAt: null };
      later(0, () => emitCall('dialing'));
      later(60, () => emitCall('alerting'));
      later(120, () => emitCall('active', { startedAt: new Date().toISOString() }));
      return id;
    },
    async answer() { emitCall('active', { startedAt: new Date().toISOString() }); },
    async hangup() { emitCall('disconnected'); current = null; },
    async sendDtmf() {},
    onCall(cb) { return callEmitter.on(cb); },

    // Mock-only, deliberately NOT part of the backend contract: lets the
    // incoming-call window and its notification be exercised without ringing a
    // real phone. Without it the only way to test task 10 is a real call.
    simulateIncoming(number = '+919804464251', name = null) {
      const id = `mock-call-${++seq}`;
      current = { id, direction: 'in', state: 'incoming', number, name, startedAt: null };
      callEmitter.emit(current);
      return id;
    },

    async startContactImport() {
      importTimer = later(50, () => contactsEmitter.emit(MOCK_CONTACTS));
    },
    async cancelContactImport() {
      if (!importTimer) return;
      clearTimeout(importTimer);
      timers.delete(importTimer);
      importTimer = null;
    },
    onContacts(cb) { return contactsEmitter.on(cb); },

    // Mirrors recorder.stop(): null when nothing was recording for this call.
    async startRecording(callId) { recorded.add(callId); return `/tmp/konnect-mock-${callId}.wav`; },
    async stopRecording(callId) {
      return recorded.delete(callId) ? `/tmp/konnect-mock-${callId}.opus` : null;
    },

    async verifyLink(_mac) {
      return { ok: true, reason: null, checks: [
        { label: 'Modem online', ok: true },
        { label: 'Telephony available', ok: true },
        { label: 'Call volume readable', ok: true },
      ] };
    },
    async getCallVolume() { return { speaker: 50, microphone: 50, muted: false, error: null }; },
    async setCallVolume() {},
    onCallVolume() { return () => {}; },

    adapter: (() => {
      const discovered = createEmitter();
      const pairingRequests = createEmitter();
      // The bt-off card (artboard 1a) is otherwise unreachable in mock,
      // where the radio is always on.
      let powered = process.env.KONNECT_MOCK_BT_OFF !== '1';
      let timer = null;
      return {
        async getPower() { return powered; },
        async setPower(on) { powered = Boolean(on); return powered; },
        // async, matching the real adapter.onPower: ipc.js subscribes
        // fire-and-forget and .catch()es the result, so a sync mock would
        // give a mock run a different shape than production - which is how a
        // crash-at-startup bug survived ten reviews.
        async onPower() { return () => {}; },
        async startScan() {
          timer = setTimeout(() => {
            // Artboard 1b is the scan that has found no phone yet, which the
            // default mock skips past in 30ms. The flag holds it there by
            // turning up only things that do not rank as handsets.
            if (process.env.KONNECT_MOCK_NO_PHONE === '1') {
              discovered.emit({ mac: 'AA:BB:CC:00:00:01', name: 'Living Room TV', icon: 'video-display',
                cls: 0x000424, paired: false, connected: false, rssi: -71 });
              discovered.emit({ mac: 'AA:BB:CC:00:00:02', name: 'WH-1000XM4', icon: 'audio-headphones',
                cls: 0x240404, paired: false, connected: false, rssi: -63 });
              return;
            }
            discovered.emit({ mac: '44:CD:0E:AD:5E:34', name: 'F120B', icon: 'phone',
              cls: 0x5a020c, paired: false, connected: false, rssi: -55 });
            // A second handset and some clutter, so the 1c list, its selection
            // and the "other devices" expander all have something to show.
            discovered.emit({ mac: 'B8:12:7A:C0:44:1E', name: 'JioPhone 2 (Riya)', icon: 'phone',
              cls: 0x5a020c, paired: false, connected: false, rssi: -84 });
            discovered.emit({ mac: 'AA:BB:CC:00:00:01', name: 'Living Room TV', icon: 'video-display',
              cls: 0x000424, paired: false, connected: false, rssi: -71 });
            discovered.emit({ mac: 'AA:BB:CC:00:00:02', name: 'WH-1000XM4', icon: 'audio-headphones',
              cls: 0x240404, paired: false, connected: false, rssi: -63 });
          }, 30);
        },
        async stopScan() { if (timer) clearTimeout(timer); timer = null; },
        onDiscovered(cb) { return discovered.on(cb); },
        // Nothing to unpair without a bus; forgetDevice only needs it to resolve.
        async removeDevice() {},
        async registerAgent() { return true; },
        async unregisterAgent() {},
        async pair(mac) {
          setTimeout(() => pairingRequests.emit({ mac, passkey: '001234' }), 10);
        },
        confirm() {},
        onPairingRequest(cb) { return pairingRequests.on(cb); },
      };
    })(),

    // matches the dispose() every backend exposes, so main can call it
    // uniformly; also stops test suites leaking timers
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      recorded.clear();
    },
  };
}

module.exports = { createMockBackend };
