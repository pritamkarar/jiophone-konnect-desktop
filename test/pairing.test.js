const test = require('node:test');
const assert = require('node:assert');
const { createPairing } = require('../src/main/backend/linux/pairing');

const F120B = '44:CD:0E:AD:5E:34';
const PATH = '/org/bluez/hci0/dev_44_CD_0E_AD_5E_34';

function harness({ registerFails = false, pairError = null, trustError = null } = {}) {
  const exported = {};
  const bus = {
    export(path, iface) { exported.path = path; exported.iface = iface; },
    unexport() { exported.path = null; },
  };
  const mgr = {
    async RegisterAgent(path, cap) {
      if (registerFails) throw new Error('Already Exists');
      exported.registered = [path, cap];
    },
    async UnregisterAgent() { exported.registered = null; },
  };
  const device = { async Pair() { if (pairError) throw new Error(pairError); exported.paired = true; } };
  const props = {
    async Set(iface, name, variant) {
      if (trustError) throw new Error(trustError);
      exported.trusted = [iface, name, variant.value];
    },
  };
  const getInterfaceFn = async (_b, _s, path, iface) => {
    if (iface === 'org.bluez.AgentManager1') return mgr;
    if (path === PATH && iface === 'org.freedesktop.DBus.Properties') return props;
    if (path === PATH) return device;
    throw new Error('unexpected ' + path + ' ' + iface);
  };
  return { exported, opts: { getInterfaceFn, systemBusFn: () => bus } };
}

test('register succeeds and never requests the default agent', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  assert.strictEqual(await p.register(), true);
  assert.strictEqual(h.exported.registered[1], 'KeyboardDisplay');
});

test('register returns false rather than throwing when the name is taken', async () => {
  const h = harness({ registerFails: true });
  const p = createPairing(h.opts);
  assert.strictEqual(await p.register(), false);
});

test('RequestConfirmation emits a zero-padded 6-digit passkey', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  const seen = [];
  p.onRequest((r) => seen.push(r));
  const pending = h.exported.iface.RequestConfirmation(PATH, 1234);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [{ mac: F120B, passkey: '001234' }]);
  p.confirm(true);
  await pending;
});

test('confirm(false) rejects the pending D-Bus reply', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.onRequest(() => {});
  const pending = h.exported.iface.RequestConfirmation(PATH, 42);
  await new Promise((r) => setImmediate(r));
  p.confirm(false);
  await assert.rejects(() => pending);
});

test('AuthorizeService accepts only the device being paired', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.setTarget(F120B);
  await h.exported.iface.AuthorizeService(PATH, '0000111e-0000-1000-8000-00805f9b34fb');
  await assert.rejects(
    () => h.exported.iface.AuthorizeService('/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF', 'x'),
    /Rejected|not the device/i);
});

test('pair() surfaces the real reason on failure', async () => {
  const h = harness({ pairError: 'AuthenticationTimeout' });
  const p = createPairing(h.opts);
  await assert.rejects(() => p.pair(F120B), /AuthenticationTimeout/);
});

test('Release settles a still-open RequestConfirmation instead of leaving it dangling', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.onRequest(() => {});
  const pending = h.exported.iface.RequestConfirmation(PATH, 7);
  await new Promise((r) => setImmediate(r));
  h.exported.iface.Release();
  await assert.rejects(() => pending);
});

test('unregister() settles a still-open RequestConfirmation instead of leaving it dangling', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.onRequest(() => {});
  const pending = h.exported.iface.RequestConfirmation(PATH, 7);
  await new Promise((r) => setImmediate(r));
  await p.unregister();
  await assert.rejects(() => pending);
});

test('a second RequestConfirmation supersedes and rejects the first, rather than abandoning it', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.onRequest(() => {});
  const first = h.exported.iface.RequestConfirmation(PATH, 1);
  await new Promise((r) => setImmediate(r));
  const OTHER_PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
  const second = h.exported.iface.RequestConfirmation(OTHER_PATH, 2);
  await assert.rejects(() => first, /superseded/i);
  p.confirm(true);
  await second;
});

// R4: the brief's confirm(ok) resolved a pending RequestPinCode with a
// hardcoded '0000'. Spec 5.1 requires RequestPinCode always go to the user;
// silently guessing a PIN and sending it to an unverified peer is the
// opposite of that. Instead we reject outright - a legacy-PIN handset must
// be paired in system Bluetooth settings.
test('RequestPinCode rejects rather than guessing a PIN', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  await assert.rejects(
    () => h.exported.iface.RequestPinCode(PATH),
    /Rejected|PIN|legacy/i);
});

// Unimplemented Agent1 methods reached the remote as
// org.freedesktop.DBus.Error.UnknownMethod - opaque, and with nothing the
// user can do about it. Every one of them must say the same actionable thing
// RequestPinCode says.
test('the unimplemented agent methods reject with an actionable message, not UnknownMethod', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  for (const call of [
    () => h.exported.iface.RequestPasskey(PATH),
    () => h.exported.iface.DisplayPinCode(PATH, '0000'),
    () => h.exported.iface.RequestAuthorization(PATH),
  ]) {
    await assert.rejects(call, /system Bluetooth settings/i);
  }
});

// targetMac is the ONLY thing standing between AuthorizeService and
// auto-approving a device. Left set after a pairing attempt it kept approving
// that mac for the life of the process, long after the user stopped pairing.
test('pair() releases the auto-authorise target whatever the outcome', async () => {
  for (const pairError of [null, 'AuthenticationTimeout']) {
    const h = harness({ pairError });
    const p = createPairing(h.opts);
    await p.register();
    await p.pair(F120B).catch(() => {});
    await assert.rejects(
      () => h.exported.iface.AuthorizeService(PATH, '0000111e-0000-1000-8000-00805f9b34fb'),
      /not the device being paired/i,
      `target still set after a pair that ${pairError ? 'failed' : 'succeeded'}`);
  }
});

// The unexport used to share a try with UnregisterAgent, so a throw from
// bluetoothd stranded our Agent1 object on the bus with `registered` already
// false - nothing would ever unexport it.
test('unregister() unexports the agent even when UnregisterAgent throws', async () => {
  const h = harness();
  h.opts.getInterfaceFn = async (_b, _s, path, iface) => {
    if (iface === 'org.bluez.AgentManager1') {
      return {
        async RegisterAgent(p2, cap) { h.exported.registered = [p2, cap]; },
        async UnregisterAgent() { throw new Error('org.freedesktop.DBus.Error.NoReply'); },
      };
    }
    throw new Error('unexpected ' + path + ' ' + iface);
  };
  const p = createPairing(h.opts);
  await p.register();
  assert.strictEqual(h.exported.path, '/konnect/pairing/agent');
  await p.unregister();
  assert.strictEqual(h.exported.path, null, 'the object must not be stranded on the bus');
});

// ---- Trusted ------------------------------------------------------------
// Every other Bluetooth manager (GNOME's panel, KDE's, bluetoothctl's
// `trust`) marks a handset trusted when it pairs. Konnect did not, and the
// gap only became visible once "Forget this handset" started unpairing: this
// F120B had been trusted for days by GNOME, was re-paired through Konnect,
// and came back untrusted. Untrusted means BlueZ asks an agent to authorise
// every service the phone offers, and this agent answers only for the device
// being paired RIGHT NOW - so the handset's own reconnection attempts are
// refused, oFono's HFP modem never powers on, and the dialer reports
// "handset modem offline".

test('a successful pair marks the handset trusted', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.pair(F120B);
  assert.deepStrictEqual(h.exported.trusted, ['org.bluez.Device1', 'Trusted', true]);
});

test('a failed pair does not mark anything trusted', async () => {
  const h = harness({ pairError: 'org.bluez.Error.AuthenticationFailed' });
  const p = createPairing(h.opts);
  await assert.rejects(() => p.pair(F120B));
  assert.strictEqual(h.exported.trusted, undefined);
});

test('a pair that succeeds but cannot be trusted is still a successful pair', async () => {
  // The bond exists at this point. Throwing here would tell onboarding the
  // pairing failed when the handset is, in fact, paired - leaving the user to
  // "retry" a pairing that would then report "already paired".
  const h = harness({ trustError: 'org.freedesktop.DBus.Error.AccessDenied' });
  const p = createPairing(h.opts);
  await p.pair(F120B);
  assert.strictEqual(h.exported.paired, true);
});
