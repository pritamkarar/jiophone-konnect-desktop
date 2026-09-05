const test = require('node:test');
const assert = require('node:assert');
const {
  toCall, directionFor, signalPercent, describeTelephonyError, createTelephony, verifyLinkFor,
} = require('../src/main/backend/linux/telephony');
const { modemPathFor } = require('../src/main/backend/linux/bus');

const MAC = '44:CD:0E:AD:5E:34';
const PATH = '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34/voicecall01';
const OTHER_MAC = '30:BB:7D:21:99:DA';

test('maps an outgoing dialing call', () => {
  const c = toCall(PATH, { State: 'dialing', LineIdentification: '+919876543210', Name: '' });
  assert.strictEqual(c.id, PATH);
  assert.strictEqual(c.direction, 'out');
  assert.strictEqual(c.state, 'dialing');
  assert.strictEqual(c.number, '+919876543210');
  assert.strictEqual(c.name, null);
  assert.strictEqual(c.startedAt, null);
});

test('maps an incoming call as inbound', () => {
  const c = toCall(PATH, { State: 'incoming', LineIdentification: '+919804464251' });
  assert.strictEqual(c.direction, 'in');
  assert.strictEqual(c.state, 'incoming');
});

test('alerting is outbound, waiting is inbound', () => {
  assert.strictEqual(toCall(PATH, { State: 'alerting' }).direction, 'out');
  assert.strictEqual(toCall(PATH, { State: 'waiting' }).direction, 'in');
});

test('StartTime is carried through only when present', () => {
  const active = toCall(PATH, { State: 'active', StartTime: '2026-09-01T12:04:29+0530' });
  assert.strictEqual(active.startedAt, '2026-09-01T12:04:29+0530');
  assert.strictEqual(toCall(PATH, { State: 'active' }).startedAt, null);
});

test('an empty Name becomes null rather than an empty string', () => {
  assert.strictEqual(toCall(PATH, { State: 'active', Name: '' }).name, null);
  assert.strictEqual(toCall(PATH, { State: 'active', Name: 'Amit' }).name, 'Amit');
});

test('signalPercent clamps and rejects nonsense', () => {
  assert.strictEqual(signalPercent(100), 100);
  assert.strictEqual(signalPercent(0), 0);
  assert.strictEqual(signalPercent(150), 100);
  assert.strictEqual(signalPercent(-5), 0);
  assert.strictEqual(signalPercent(undefined), null);
  assert.strictEqual(signalPercent('loud'), null);
});

test('a powered-down modem is reported as offline, not as no-service', () => {
  // The real dbus-next shape, captured from the handset with the modem off.
  const err = new Error('interface not found in proxy object: org.ofono.NetworkRegistration');
  assert.strictEqual(describeTelephonyError(err), 'handset modem offline');
});

test('other telephony failures pass through with their detail intact', () => {
  assert.strictEqual(
    describeTelephonyError({ type: 'org.freedesktop.DBus.Error.ServiceUnknown' }),
    'org.freedesktop.DBus.Error.ServiceUnknown');
  assert.strictEqual(
    describeTelephonyError(new Error('connection timed out')), 'connection timed out');
});

// What the live F120B reports (spec 2026-09-05 §2): no SubscriberNumbers.
const DEFAULT_HANDSFREE = {
  BatteryChargeLevel: { value: 4 },
  Features: { value: ['three-way-calling', 'echo-canceling-and-noise-reduction', 'release-all-held', 'create-multiparty'] },
};

// Fakes org.ofono over dbus-next's getInterfaceFn/systemBusFn injection
// seams (the same pattern device.js's tests use) so createTelephony's real
// watchCall/unwatchCall/start logic runs against scripted signals instead of
// the live bus. One fake object per (path, interface name), so a test can
// grab it back out of `registry` and fire signals on it. Manager and call
// method invocations are recorded in order so routing can be asserted.
// `handsfree: null` simulates the modem being offline for that interface.
function fakeOfono({ calls = [], handsfree = DEFAULT_HANDSFREE } = {}) {
  const registry = new Map();
  const vcmListenerCounts = { CallAdded: 0, CallRemoved: 0 };
  const managerCalls = [];
  const callCalls = [];

  function makeEmitter() {
    const listeners = new Map();
    return {
      on(event, cb) { listeners.set(event, cb); },
      off(event, cb) { if (listeners.get(event) === cb) listeners.delete(event); },
      emit(event, ...args) { const cb = listeners.get(event); if (cb) cb(...args); },
    };
  }

  function getOrCreate(path, ifaceName, build) {
    const key = `${path}|${ifaceName}`;
    if (!registry.has(key)) registry.set(key, build());
    return registry.get(key);
  }

  const getInterfaceFn = async (_bus, _service, path, ifaceName) => {
    if (ifaceName === 'org.ofono.Modem') {
      return getOrCreate(path, ifaceName, () => ({
        GetProperties: async () => ({ Powered: { value: true } }),
        SetProperty: async () => {},
      }));
    }
    if (ifaceName === 'org.ofono.Handsfree') {
      // dbus-next's real wording when oFono has dropped the interface.
      if (!handsfree) throw new Error('interface not found in proxy object: org.ofono.Handsfree');
      return getOrCreate(path, ifaceName, () => ({ GetProperties: async () => handsfree }));
    }
    if (ifaceName === 'org.ofono.VoiceCallManager') {
      return getOrCreate(path, ifaceName, () => {
        const e = makeEmitter();
        const record = (name) => async () => { managerCalls.push(name); };
        return {
          ...e,
          on(event, cb) {
            if (event === 'CallAdded' || event === 'CallRemoved') vcmListenerCounts[event] += 1;
            e.on(event, cb);
          },
          GetCalls: async () => calls,
          Dial: async () => '/call/dialed',
          SendTones: async () => {},
          HoldAndAnswer: record('HoldAndAnswer'),
          HangupMultiparty: record('HangupMultiparty'),
          SwapCalls: record('SwapCalls'),
          CreateMultiparty: record('CreateMultiparty'),
        };
      });
    }
    if (ifaceName === 'org.ofono.VoiceCall') {
      return getOrCreate(path, ifaceName, () => {
        const e = makeEmitter();
        return {
          ...e,
          Answer: async () => { callCalls.push('Answer'); },
          Hangup: async () => { callCalls.push('Hangup'); },
        };
      });
    }
    throw new Error(`fakeOfono: unexpected interface requested: ${ifaceName}`);
  };

  return {
    getInterfaceFn, systemBusFn: () => ({}), registry, vcmListenerCounts, managerCalls, callCalls,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('hangup emits exactly one terminal call event when oFono sets disconnected before removal', async () => {
  const { getInterfaceFn, systemBusFn, registry } = fakeOfono();
  const telephony = createTelephony({ mac: MAC, getInterfaceFn, systemBusFn });
  const seen = [];
  telephony.onCall((c) => seen.push(c.state));
  await tick();

  const vcm = registry.get(`${modemPathFor(MAC)}|org.ofono.VoiceCallManager`);
  vcm.emit('CallAdded', PATH, { State: { value: 'active' } });
  await tick();

  // oFono's normal ordering: PropertyChanged sets disconnected BEFORE
  // CallRemoved fires.
  const call = registry.get(`${PATH}|org.ofono.VoiceCall`);
  call.emit('PropertyChanged', 'State', { value: 'disconnected' });
  vcm.emit('CallRemoved', PATH);

  const terminal = seen.filter((s) => s === 'disconnected');
  assert.strictEqual(terminal.length, 1, `saw ${JSON.stringify(seen)}`);
  telephony.dispose();
});

test('a call removed with no prior terminal transition still gets exactly one synthesized event', async () => {
  const { getInterfaceFn, systemBusFn, registry } = fakeOfono();
  const telephony = createTelephony({ mac: MAC, getInterfaceFn, systemBusFn });
  const seen = [];
  telephony.onCall((c) => seen.push(c.state));
  await tick();

  const vcm = registry.get(`${modemPathFor(MAC)}|org.ofono.VoiceCallManager`);
  vcm.emit('CallAdded', PATH, { State: { value: 'active' } });
  await tick();

  // No PropertyChanged this time - the call just vanishes.
  vcm.emit('CallRemoved', PATH);

  const terminal = seen.filter((s) => s === 'disconnected');
  assert.strictEqual(terminal.length, 1, `saw ${JSON.stringify(seen)}`);
  telephony.dispose();
});

test('concurrent start() callers (onCall + dial overlapping) register CallAdded/CallRemoved exactly once', async () => {
  const { getInterfaceFn, systemBusFn, vcmListenerCounts } = fakeOfono();
  const telephony = createTelephony({ mac: MAC, getInterfaceFn, systemBusFn });

  telephony.onCall(() => {});
  telephony.onCall(() => {});
  await telephony.dial('+919876543210');

  assert.strictEqual(vcmListenerCounts.CallAdded, 1);
  assert.strictEqual(vcmListenerCounts.CallRemoved, 1);
  telephony.dispose();
});

// oFono reports no Direction, and outgoing (dialing->alerting->active) and
// incoming (incoming->active) both land on 'active'. Direction is therefore
// only knowable from the first state seen, and must be latched there.
test('direction is read from the first state, not the current one', () => {
  assert.strictEqual(directionFor({ State: 'incoming' }), 'in');
  assert.strictEqual(directionFor({ State: 'waiting' }), 'in');
  assert.strictEqual(directionFor({ State: 'dialing' }), 'out');
  assert.strictEqual(directionFor({ State: 'alerting' }), 'out');
  // The trap: 'active' alone cannot tell you where the call came from.
  assert.strictEqual(directionFor({ State: 'active' }), 'out');
});

test('a latched direction survives the move to active', () => {
  const latched = directionFor({ State: 'incoming' });
  const answered = toCall(PATH, { State: 'active', StartTime: '2026-09-01T12:04:29+0530' }, latched);
  assert.strictEqual(answered.direction, 'in', 'answered incoming call became outgoing');
  assert.strictEqual(answered.state, 'active');
});

test('verifyLink reports each read separately and never dials', async () => {
  const calls = [];
  const registry = new Map();
  registry.set(`${modemPathFor(MAC)}|org.ofono.Modem`, {
    async GetProperties() {
      calls.push('modem');
      return {
        Online: { value: true },
        Interfaces: { value: ['org.ofono.VoiceCallManager', 'org.ofono.CallVolume'] },
      };
    },
  });
  registry.set(`${modemPathFor(MAC)}|org.ofono.CallVolume`, {
    async GetProperties() {
      calls.push('callvolume');
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 50 }, Muted: { value: false } };
    },
  });
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async (_bus, _svc, path, iface) => {
      const found = registry.get(`${path}|${iface}`);
      if (!found) throw new Error(`No such interface '${iface}'`);
      return found;
    },
    systemBusFn: () => ({}),
  });

  const result = await t.verifyLink();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.checks.map((c) => c.ok), [true, true, true]);
  assert.ok(!calls.includes('dial'), 'verifyLink must never dial');
});

test('verifyLink reports a partial failure without throwing', async () => {
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async () => ({ async GetProperties() { return { Online: { value: false }, Interfaces: { value: [] } }; } }),
    systemBusFn: () => ({}),
  });
  const result = await t.verifyLink();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.checks[0].ok, false);
});

// The critical wizard bug: verifying the handset the user just SELECTED,
// which is never the same as the handset this telephony is bound to.
test('verifyLinkFor probes the path of the mac it is given, not any bound handset', async () => {
  const seenPaths = [];
  const getInterfaceFn = async (_bus, _svc, path, iface) => {
    seenPaths.push(path);
    if (iface === 'org.ofono.Modem') {
      return {
        async GetProperties() {
          return {
            Online: { value: true },
            Interfaces: { value: ['org.ofono.VoiceCallManager', 'org.ofono.CallVolume'] },
          };
        },
      };
    }
    return { async GetProperties() { return {}; } };
  };
  const result = await verifyLinkFor(OTHER_MAC, { getInterfaceFn, systemBusFn: () => ({}) });
  assert.strictEqual(result.ok, true);
  assert.ok(seenPaths.length > 0);
  assert.ok(seenPaths.every((p) => p.includes(modemPathFor(OTHER_MAC))),
    `expected every probe to use ${modemPathFor(OTHER_MAC)}, saw ${JSON.stringify(seenPaths)}`);
  assert.ok(!seenPaths.some((p) => p.includes('44_CD_0E_AD_5E_34')),
    'must not probe the bound/development handset');
});

// createTelephony(...).verifyLink(targetMac) must delegate to verifyLinkFor
// with targetMac, not silently fall back to probing its OWN (bound) mac -
// that is exactly the F120B-bound/OnePlus-selected scenario the wizard hit.
test('a bound telephony verifying a DIFFERENT mac probes that mac, not its own', async () => {
  const seenPaths = [];
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async (_bus, _svc, path) => {
      seenPaths.push(path);
      return {
        async GetProperties() {
          return { Online: { value: true }, Interfaces: { value: [] } };
        },
      };
    },
    systemBusFn: () => ({}),
  });
  await t.verifyLink(OTHER_MAC);
  assert.ok(seenPaths.every((p) => p.includes(modemPathFor(OTHER_MAC))),
    `expected every probe to use ${modemPathFor(OTHER_MAC)}, saw ${JSON.stringify(seenPaths)}`);
  assert.ok(!seenPaths.some((p) => p.includes('44_CD_0E_AD_5E_34')),
    'must not probe the bound handset when a different mac was requested');
});

test('toCall carries the Multiparty flag, false when absent', () => {
  assert.strictEqual(toCall(PATH, { State: 'active', Multiparty: true }).multiparty, true);
  assert.strictEqual(toCall(PATH, { State: 'active' }).multiparty, false);
});

test('getHandsfree maps battery, features and subscriber numbers', async () => {
  const f = fakeOfono({ handsfree: {
    BatteryChargeLevel: { value: 4 },
    Features: { value: ['three-way-calling', 'create-multiparty'] },
    SubscriberNumbers: { value: ['+919804464251'] },
  } });
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  assert.deepStrictEqual(await telephony.getHandsfree(), {
    battery: 80, features: ['three-way-calling', 'create-multiparty'], numbers: ['+919804464251'], error: null,
  });
});

test('getHandsfree reports an empty numbers list when the handset omits SubscriberNumbers, as the F120B does', async () => {
  const f = fakeOfono();
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  const h = await telephony.getHandsfree();
  assert.deepStrictEqual(h.numbers, []);
  assert.ok(h.features.includes('three-way-calling'));
  assert.strictEqual(h.error, null);
});

test('getHandsfree reports offline with empty lists when the interface is gone', async () => {
  const f = fakeOfono({ handsfree: null });
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  assert.deepStrictEqual(await telephony.getHandsfree(), {
    battery: null, features: [], numbers: [], error: 'handset modem offline',
  });
});
