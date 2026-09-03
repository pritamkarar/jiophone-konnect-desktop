const test = require('node:test');
const assert = require('node:assert');
const { clampVolume, createTelephony } = require('../src/main/backend/linux/telephony');
const { modemPathFor } = require('../src/main/backend/linux/bus');

const MAC = '44:CD:0E:AD:5E:34';

test('clampVolume constrains to the 0-100 byte range and rounds', () => {
  assert.strictEqual(clampVolume(50), 50);
  assert.strictEqual(clampVolume(0), 0);
  assert.strictEqual(clampVolume(100), 100);
  assert.strictEqual(clampVolume(-5), 0);
  assert.strictEqual(clampVolume(140), 100);
  assert.strictEqual(clampVolume(49.6), 50);
  assert.strictEqual(clampVolume('50'), 50);
  assert.strictEqual(clampVolume(null), 0);
  assert.strictEqual(clampVolume(NaN), 0);
});

function fakeTelephony(cv) {
  return createTelephony({
    mac: MAC,
    getInterfaceFn: async (_bus, _svc, path, iface) => {
      if (path === modemPathFor(MAC) && iface === 'org.ofono.CallVolume') return cv;
      throw new Error(`No such interface '${iface}'`);
    },
    systemBusFn: () => ({}),
  });
}

test('getCallVolume unwraps the variant dictionary', async () => {
  const t = fakeTelephony({
    async GetProperties() {
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 40 }, Muted: { value: false } };
    },
    on() {},
  });
  assert.deepStrictEqual(await t.getCallVolume(), {
    speaker: 50, microphone: 40, muted: false, error: null,
  });
});

test('getCallVolume reports an unreachable interface instead of inventing zeros', async () => {
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async () => { throw new Error("No such interface 'org.ofono.CallVolume'"); },
    systemBusFn: () => ({}),
  });
  const v = await t.getCallVolume();
  assert.strictEqual(v.speaker, null);
  assert.ok(v.error);
});

test('setCallVolume marshals volumes as byte and mute as boolean', async () => {
  const seen = [];
  const t = fakeTelephony({
    async SetProperty(name, variant) { seen.push([name, variant.signature, variant.value]); },
    on() {},
  });
  await t.setCallVolume({ speaker: 70, microphone: 140, muted: true });
  assert.deepStrictEqual(seen, [
    ['SpeakerVolume', 'y', 70],
    ['MicrophoneVolume', 'y', 100],
    ['Muted', 'b', true],
  ]);
});

test('setCallVolume only writes the properties it was given', async () => {
  const seen = [];
  const t = fakeTelephony({
    async SetProperty(name) { seen.push(name); },
    on() {},
  });
  await t.setCallVolume({ speaker: 30 });
  assert.deepStrictEqual(seen, ['SpeakerVolume']);
});

test('onCallVolume emits when the handset changes its own volume', async () => {
  let handler = null;
  const t = fakeTelephony({
    async GetProperties() {
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 50 }, Muted: { value: false } };
    },
    on(signal, cb) { if (signal === 'PropertyChanged') handler = cb; },
  });
  const seen = [];
  await t.onCallVolume((v) => seen.push(v));
  handler('SpeakerVolume', { value: 80 });
  assert.strictEqual(seen.at(-1).speaker, 80);
});

test('onCallVolume returns a real unsubscribe, not a no-op', async () => {
  let handler = null;
  let offCalledWith = null;
  const t = fakeTelephony({
    async GetProperties() {
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 50 }, Muted: { value: false } };
    },
    on(signal, cb) { if (signal === 'PropertyChanged') handler = cb; },
    off(signal, cb) { if (signal === 'PropertyChanged') offCalledWith = cb; },
  });
  const unsubscribe = await t.onCallVolume(() => {});
  assert.strictEqual(typeof handler, 'function', 'PropertyChanged handler was never registered');
  unsubscribe();
  assert.strictEqual(offCalledWith, handler, 'unsubscribe must call off() with the exact handler on() received');
});
