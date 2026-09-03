const test = require('node:test');
const assert = require('node:assert');
const { INITIAL, reduce } = require('../src/shared/onboarding-state');

const on = (s) => reduce(s, { type: 'adapter', present: true, powered: true });
const F120B = { mac: '44:CD:0E:AD:5E:34', name: 'F120B', paired: false };
const PAIRED = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', paired: true };

test('starts in bt-off', () => {
  assert.strictEqual(INITIAL.name, 'bt-off');
});

test('powering on moves to scanning', () => {
  assert.strictEqual(on(INITIAL).name, 'scanning');
});

test('powering off from any state returns to bt-off', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'adapter', present: true, powered: false });
  assert.strictEqual(s.name, 'bt-off');
});

test('an absent adapter records that there is nothing to turn on', () => {
  const s = reduce(INITIAL, { type: 'adapter', present: false, powered: false, reason: 'no adapter' });
  assert.strictEqual(s.name, 'bt-off');
  assert.strictEqual(s.adapter.present, false);
});

test('discovered devices accumulate and dedupe by mac', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'scan-device', device: { ...F120B, name: 'F120B ' } });
  assert.strictEqual(s.devices.length, 1);
  assert.strictEqual(s.devices[0].name, 'F120B ');
});

// Two files pay real complexity for list stability - adapter.js keeps a Map so
// an updated device holds its insertion position, and rank.js tiebreaks on
// index "so the list does not reshuffle under the user's cursor" - and a
// filter-then-push here defeated both, sending every updated device to the end
// on every 1.5s poll tick.
test('an updated device keeps its position in the list', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'scan-device', device: PAIRED });
  s = reduce(s, { type: 'scan-device', device: { ...F120B, name: 'F120B (JioPhone)' } });
  assert.deepStrictEqual(s.devices.map((d) => d.mac), [F120B.mac, PAIRED.mac]);
  assert.strictEqual(s.devices[0].name, 'F120B (JioPhone)', 'the update itself must land');
});

// rank.js orders on RSSI, which moves on nearly every tick: keeping the live
// reading would re-sort the rows under the cursor even with position held.
// Rank on first sight, then hold still.
test('an updated device keeps the rssi it was first ranked with', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: { ...F120B, rssi: -55 } });
  s = reduce(s, { type: 'scan-device', device: { ...F120B, rssi: -80 } });
  assert.strictEqual(s.devices[0].rssi, -55);
});

// ...unless there was no reading to rank by. A device BlueZ already knows but
// has not yet seen in this discovery has no RSSI, and freezing that null would
// pin it to the bottom of its group for the whole session.
test('a device first seen without an rssi adopts the first real reading', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: { ...F120B, rssi: null } });
  s = reduce(s, { type: 'scan-device', device: { ...F120B, rssi: -62 } });
  assert.strictEqual(s.devices[0].rssi, -62);
});

test('a gone device is removed', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'scan-gone', mac: F120B.mac });
  assert.deepStrictEqual(s.devices, []);
});

test('picking an UNPAIRED device goes to pairing', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  assert.strictEqual(s.name, 'pairing');
  assert.strictEqual(s.target, F120B.mac);
});

test('picking an ALREADY-PAIRED device skips pairing entirely', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: PAIRED });
  s = reduce(s, { type: 'pick', mac: PAIRED.mac });
  assert.strictEqual(s.name, 'connecting');
});

test('the passkey lands on the pairing state', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'passkey', mac: F120B.mac, passkey: '001234' });
  assert.strictEqual(s.passkey, '001234');
});

test('a failed pair returns to scanning WITH the reason', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'pair-failed', reason: 'AuthenticationTimeout' });
  assert.strictEqual(s.name, 'scanning');
  assert.match(s.error, /AuthenticationTimeout/);
  assert.strictEqual(s.passkey, null, 'a stale passkey must not survive');
});

test('pair-ok then connect-ok reaches connected with checks', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'pair-ok' });
  assert.strictEqual(s.name, 'connecting');
  s = reduce(s, { type: 'connect-ok', checks: [{ label: 'HFP', ok: true }] });
  assert.strictEqual(s.name, 'connected');
  assert.strictEqual(s.checks.length, 1);
});

// State 1e must not claim a connection the code declined to make: during
// blocking onboarding the backend is unbound, connect() rejects by design and
// the renderer skips it, so `connected` is what the card's copy branches on.
test('connect-ok records whether the link was actually brought up', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  const linked = reduce(s, { type: 'connect-ok', checks: [] });
  assert.strictEqual(linked.connected, true, 'a plain connect-ok still means connected');
  const skipped = reduce(s, { type: 'connect-ok', connected: false, checks: [] });
  assert.strictEqual(skipped.name, 'connected');
  assert.strictEqual(skipped.connected, false);
});

test('agent-unavailable marks the flow degraded without leaving the state machine', () => {
  const s = reduce(on(INITIAL), { type: 'agent-unavailable', reason: 'Already Exists' });
  assert.strictEqual(s.degraded, true);
  assert.strictEqual(s.name, 'scanning');
});

test('cancel from pairing returns to scanning and clears the passkey', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'passkey', mac: F120B.mac, passkey: '001234' });
  s = reduce(s, { type: 'cancel' });
  assert.strictEqual(s.name, 'scanning');
  assert.strictEqual(s.passkey, null);
});

test('reduce never mutates its input', () => {
  const before = on(INITIAL);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'scan-device', device: F120B });
  assert.strictEqual(JSON.stringify(before), snapshot);
});

test('an unknown event returns the same state object', () => {
  const s = on(INITIAL);
  assert.strictEqual(reduce(s, { type: 'nonsense' }), s);
});

// --- boot decision --------------------------------------------------------
// Regression: the app booted straight to the dialer while bound to a handset
// that no longer exists in BlueZ. The bootstrap returned early on the mere
// presence of a persisted device_mac, never asking whether that device is
// still there. Observed on real hardware: device_mac "44:CD:0E:AD:5E:34",
// listDevices() reporting only a different phone, getStatus() erroring with
// "interface not found in proxy object" - and no onboarding.
const { decideOnboarding } = require('../src/shared/onboarding-state');

const BOOT_MAC = '44:CD:0E:AD:5E:34';
const BOOT_OTHER = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', paired: true, connected: false };
const BOOT_STORED = { mac: BOOT_MAC, name: 'F120B', paired: true, connected: true };

test('a stored handset that is still paired does not reopen onboarding', () => {
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: BOOT_MAC, devices: [BOOT_STORED, BOOT_OTHER] }),
    { open: false, blocking: false });
});

test('a stored handset that has vanished from BlueZ opens onboarding', () => {
  // The reported bug, with the exact state observed on the machine.
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: BOOT_MAC, devices: [BOOT_OTHER] }),
    { open: true, blocking: false });
});

test('a stored handset that is merely unpaired now opens onboarding', () => {
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: BOOT_MAC, devices: [{ ...BOOT_STORED, paired: false }] }),
    { open: true, blocking: true });
});

test('a vanished handset with nothing else paired blocks', () => {
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: BOOT_MAC, devices: [] }),
    { open: true, blocking: true });
});

test('no stored handset but a paired device present opens onboarding dismissibly', () => {
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: null, devices: [BOOT_OTHER] }),
    { open: true, blocking: false });
});

test('no stored handset and nothing paired blocks', () => {
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: null, devices: [] }),
    { open: true, blocking: true });
});

test('a device list that could not be read is treated as nothing paired', () => {
  // listDevices() rejecting must not be read as "your handset is fine".
  assert.deepStrictEqual(
    decideOnboarding({ deviceMac: BOOT_MAC, devices: null }),
    { open: true, blocking: true });
});

test('selecting a device highlights it without starting anything', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'select', mac: F120B.mac });
  assert.strictEqual(s.selected, F120B.mac);
  // Still on the list: nothing is paired or connected until Connect fires.
  assert.strictEqual(s.name, 'scanning');
  assert.strictEqual(s.target, null);
});

test('selecting a device that is not in the list is ignored', () => {
  const s = reduce(on(INITIAL), { type: 'select', mac: F120B.mac });
  assert.strictEqual(s.selected, null);
});

test('losing the radio clears the selection with the device list', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'select', mac: F120B.mac });
  s = reduce(s, { type: 'adapter', present: true, powered: false });
  assert.strictEqual(s.selected, null);
});
