const test = require('node:test');
const assert = require('node:assert');
const { createRecordHandler } = require('../src/main/recording-policy');

function harness(initial) {
  const calls = { started: [], stopped: [], attached: [] };
  let setting = initial;
  const handler = createRecordHandler({
    store: { getSetting: () => setting },
    backend: {
      startRecording: async (id) => { calls.started.push(id); },
      stopRecording: async (id) => { calls.stopped.push(id); return `/tmp/${id}.opus`; },
    },
    attachRecording: (id, p) => calls.attached.push([id, p]),
  });
  return { handler, calls, set: (v) => { setting = v; } };
}

test('a recording started before the toggle was switched off is still stopped', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'c1' } });
  h.set('false');                              // user switches recording off mid-call
  await h.handler({ phase: 'stop', call: { id: 'c1' } });
  assert.deepStrictEqual(h.calls.stopped, ['c1'], 'recorder left running after toggle off');
  assert.deepStrictEqual(h.calls.attached, [['c1', '/tmp/c1.opus']]);
});

test('the toggle still prevents a recording from starting', async () => {
  const h = harness('false');
  await h.handler({ phase: 'start', call: { id: 'c2' } });
  assert.deepStrictEqual(h.calls.started, []);
});

test('a backend failure is logged, not thrown into the call event handler', async () => {
  const handler = createRecordHandler({
    store: { getSetting: () => 'true' },
    backend: { startRecording: async () => { throw new Error('pw-record missing'); } },
    attachRecording: () => {},
  });
  await assert.doesNotReject(() => handler({ phase: 'start', call: { id: 'c3' } }));
});

test('a second call going active while one is recording does not start a second recorder', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'start', call: { id: 'b' } });
  assert.deepStrictEqual(h.calls.started, ['a']);
});

test('once the recorded call stops, the next start is accepted', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'stop', call: { id: 'a' } });
  await h.handler({ phase: 'start', call: { id: 'b' } });
  assert.deepStrictEqual(h.calls.started, ['a', 'b']);
});

test('a stop for a call that was never recorded still reaches the backend and does not free the slot', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'stop', call: { id: 'b' } });
  assert.deepStrictEqual(h.calls.stopped, ['b']);
  await h.handler({ phase: 'start', call: { id: 'c' } });
  assert.deepStrictEqual(h.calls.started, ['a'], 'slot was freed by an unrelated stop');
});

test('a start that fails frees the slot for the next call', async () => {
  const started = [];
  const handler = createRecordHandler({
    store: { getSetting: () => 'true' },
    backend: {
      startRecording: async (id) => { if (id === 'a') throw new Error('pw-record missing'); started.push(id); },
      stopRecording: async () => null,
    },
    attachRecording: () => {},
  });
  await handler({ phase: 'start', call: { id: 'a' } });
  await handler({ phase: 'start', call: { id: 'b' } });
  assert.deepStrictEqual(started, ['b']);
});

test('a repeated start for the SAME call is passed through (the recorder is idempotent per id)', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'start', call: { id: 'a' } });
  assert.deepStrictEqual(h.calls.started, ['a', 'a']);
});
