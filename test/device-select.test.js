const test = require('node:test');
const assert = require('node:assert');
const { pickBootstrapMac, shouldReconnect } = require('../src/main/device-select');

const F120B = { mac: '44:CD:0E:AD:5E:34', name: 'F120B', paired: true, connected: false };
const ONEPLUS = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', paired: true, connected: true };
const UNPAIRED = { mac: 'AA:BB:CC:DD:EE:FF', name: 'Random', paired: false, connected: true };

test('a stored mac always wins, even over a connected device', () => {
  assert.strictEqual(pickBootstrapMac(F120B.mac, [ONEPLUS, F120B]), F120B.mac);
});

test('a stored mac wins even when that device is not currently present', () => {
  assert.strictEqual(pickBootstrapMac('11:22:33:44:55:66', [ONEPLUS]), '11:22:33:44:55:66');
});

test('with no stored mac, prefers a connected paired device', () => {
  assert.strictEqual(pickBootstrapMac(null, [F120B, ONEPLUS]), ONEPLUS.mac);
});

test('with no stored mac and none connected, takes the first paired device', () => {
  assert.strictEqual(pickBootstrapMac(null, [F120B]), F120B.mac);
});

test('never picks an unpaired device', () => {
  assert.strictEqual(pickBootstrapMac(null, [UNPAIRED]), null);
});

test('returns null when there is nothing to pick', () => {
  assert.strictEqual(pickBootstrapMac(null, []), null);
  assert.strictEqual(pickBootstrapMac(null, undefined), null);
  assert.strictEqual(pickBootstrapMac('', []), null);
});

test('a stored address that no longer parses is ignored, not trusted', () => {
  // Self-healing: the app falls back to BlueZ resolution instead of throwing
  // on every launch with a value the user cannot clear from the UI.
  assert.strictEqual(pickBootstrapMac('not-a-mac', [F120B]), F120B.mac);
  assert.strictEqual(pickBootstrapMac('11:22:33', [F120B]), F120B.mac);
  assert.strictEqual(pickBootstrapMac('not-a-mac', []), null);
});

test('a well-formed stored address is still honoured', () => {
  assert.strictEqual(pickBootstrapMac('11:22:33:44:55:66', [F120B]), '11:22:33:44:55:66');
});

// Startup reconnect (spec: "reconnect the handset that was already connected").
// Pure for the same reason pickBootstrapMac is: the rule is worth testing, and
// BlueZ is not available to a unit test.
test('reconnects a chosen handset that is not currently connected', () => {
  assert.strictEqual(shouldReconnect({ storedMac: F120B.mac, connected: false }), true);
});

test('does not reconnect when BlueZ already has the link', () => {
  // The phone reconnected on its own before Konnect started. Connect() here
  // would be a pointless D-Bus round trip.
  assert.strictEqual(shouldReconnect({ storedMac: F120B.mac, connected: true }), false);
});

test('does not reconnect on a first run, where onboarding drives the connect', () => {
  // device_mac is deliberately unset until the wizard confirms a handset, so
  // an auto-connect here would race the wizard's own Connect() on the same
  // device. The backend may already be BOUND to a bootstrap mac at this point
  // - binding is not choosing.
  assert.strictEqual(shouldReconnect({ storedMac: '', connected: false }), false);
  assert.strictEqual(shouldReconnect({ storedMac: null, connected: false }), false);
});

test('a stored address that no longer parses does not trigger a connect', () => {
  // Mirrors pickBootstrapMac: devicePathFor() would throw on it during
  // startup, and this call is detached, so the throw would be unhandled.
  assert.strictEqual(shouldReconnect({ storedMac: 'not-a-mac', connected: false }), false);
});

// The 30s status poll re-evaluates this on every tick, not just once at
// startup. The single startup attempt can land in the login-handoff window and
// lose the link 4s later (verified in the journal: SLC at 215s, dropped at
// 219s), and nothing else ever retried - so the app showed "handset modem
// offline" for the whole session. Because the rule is keyed off the SETTING, a
// bound handset stays eligible across repeated disconnected reads and only
// stops being eligible once the link is genuinely up - which is exactly the
// retry/stop behaviour the poll now relies on.
test('a stored handset stays eligible for reconnect while it reports disconnected', () => {
  const storedMac = F120B.mac;
  // Three consecutive polls with the link still down: each must still say yes.
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(shouldReconnect({ storedMac, connected: false }), true);
  }
  // The tick after the link comes up must stop retrying.
  assert.strictEqual(shouldReconnect({ storedMac, connected: true }), false);
});
