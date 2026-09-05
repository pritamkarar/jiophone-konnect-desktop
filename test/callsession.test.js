const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');
const { createCallSession } = require('../src/main/callsession');
const { createEmitter } = require('../src/main/backend/interface');

// Minimal fake backend: we push call events by hand so timing is deterministic.
function fakeBackend() {
  const calls = createEmitter();
  return {
    onCall: (cb) => calls.on(cb),
    emit: (c) => calls.emit(c),
    onDeviceStatus: () => () => {},
    onContacts: () => () => {},
  };
}

// onRecord is optional so every existing call site (all of which pass
// nothing) is unaffected; only the two recorder-failure tests use it.
function setup({ onRecord } = {}) {
  const store = openStore(':memory:');
  const backend = fakeBackend();
  let clock = Date.parse('2026-09-01T12:00:00Z');
  const now = () => new Date(clock);
  const persisted = [];
  const session = createCallSession({
    backend, store, now, onRecord, onPersisted: () => persisted.push(Date.now()),
  });
  session.start();
  return { store, backend, session, persisted, advance: (ms) => { clock += ms; } };
}

test('an answered outgoing call is stored with duration from StartTime', () => {
  const { store, backend, advance } = setup();
  const id = '/call/1';
  backend.emit({ id, direction: 'out', state: 'dialing', number: '+919876543210', name: null, startedAt: null });
  advance(40000);
  backend.emit({ id, direction: 'out', state: 'active', number: '+919876543210', name: null, startedAt: '2026-09-01T12:00:40Z' });
  advance(60000);
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: '2026-09-01T12:00:40Z' });

  const [row] = store.listCalls({});
  assert.strictEqual(row.direction, 'out');
  assert.strictEqual(row.number_e164, '+919876543210');
  // 60s of talk time, NOT the 100s since dialing began.
  assert.strictEqual(row.duration_s, 60);
  store.close();
});

test('an unanswered outgoing call is stored with zero duration and null start', () => {
  const { store, backend, advance } = setup();
  const id = '/call/2';
  backend.emit({ id, direction: 'out', state: 'dialing', number: '+919876543210', name: null, startedAt: null });
  advance(30000);
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: null });

  const [row] = store.listCalls({});
  assert.strictEqual(row.duration_s, 0);
  assert.strictEqual(row.started_at, null);
  store.close();
});

test('an incoming call that is never answered counts as missed', () => {
  const { store, backend, advance } = setup();
  const id = '/call/3';
  backend.emit({ id, direction: 'in', state: 'incoming', number: '+919804464251', name: null, startedAt: null });
  advance(15000);
  backend.emit({ id, direction: 'in', state: 'disconnected', number: '+919804464251', name: null, startedAt: null });

  const stats = store.callStats({});
  assert.strictEqual(stats.missed, 1);
  assert.strictEqual(stats.in, 1);
  store.close();
});

test('an answered incoming call is not counted as missed', () => {
  const { store, backend, advance } = setup();
  const id = '/call/4';
  backend.emit({ id, direction: 'in', state: 'incoming', number: '+919804464251', name: null, startedAt: null });
  advance(5000);
  backend.emit({ id, direction: 'in', state: 'active', number: '+919804464251', name: null, startedAt: '2026-09-01T12:00:05Z' });
  advance(30000);
  backend.emit({ id, direction: 'in', state: 'disconnected', number: '+919804464251', name: null, startedAt: '2026-09-01T12:00:05Z' });

  const stats = store.callStats({});
  assert.strictEqual(stats.missed, 0);
  assert.strictEqual(stats.talkTimeSeconds, 30);
  store.close();
});

test('a call is persisted exactly once even if disconnected repeats', () => {
  const { store, backend } = setup();
  const id = '/call/5';
  const base = { id, direction: 'out', number: '+919876543210', name: null, startedAt: null };
  backend.emit({ ...base, state: 'dialing' });
  backend.emit({ ...base, state: 'disconnected' });
  backend.emit({ ...base, state: 'disconnected' });
  assert.strictEqual(store.listCalls({}).length, 1);
  store.close();
});

test('a disconnected event for an unknown call is ignored', () => {
  const { store, backend } = setup();
  backend.emit({ id: '/ghost', direction: 'out', state: 'disconnected', number: '+911', name: null, startedAt: null });
  assert.strictEqual(store.listCalls({}).length, 0);
  store.close();
});

test('two concurrent calls are tracked independently', () => {
  const { store, backend, advance } = setup();
  backend.emit({ id: '/a', direction: 'out', state: 'active', number: '+911', name: null, startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: '/b', direction: 'in', state: 'incoming', number: '+912', name: null, startedAt: null });
  advance(20000);
  backend.emit({ id: '/a', direction: 'out', state: 'disconnected', number: '+911', name: null, startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: '/b', direction: 'in', state: 'disconnected', number: '+912', name: null, startedAt: null });

  const rows = store.listCalls({});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.filter((r) => r.duration_s === 20).length, 1);
  store.close();
});

test('a malformed StartTime logs a zero duration rather than losing the call', () => {
  const { store, backend } = setup();
  const id = '/call/bad';
  backend.emit({ id, direction: 'out', state: 'active', number: '+919876543210', name: null, startedAt: 'not-a-date' });
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: 'not-a-date' });
  const rows = store.listCalls({});
  assert.strictEqual(rows.length, 1, 'the call must still be recorded');
  assert.strictEqual(rows[0].duration_s, 0);
  store.close();
});

test('a recorder failure on hangup does not lose the call', async () => {
  const { store, backend, advance } = setup({
    onRecord: async ({ phase }) => {
      if (phase === 'stop') throw new Error('recorder blew up');
    },
  });
  const id = '/call/rec-fail';
  backend.emit({ id, direction: 'out', state: 'active', number: '+919876543210', name: null, startedAt: new Date().toISOString() });
  advance(5000);
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(store.listCalls({}).length, 1, 'the call must survive a recorder failure');
  store.close();
});

test('a recorder failure on call-start does not lose the call or leak an unhandled rejection', async () => {
  const { store, backend, advance } = setup({
    onRecord: async ({ phase }) => {
      if (phase === 'start') throw new Error('recorder blew up on start');
    },
  });

  // process-level 'unhandledRejection' is the only clean way to observe a
  // leaked rejection from node:test itself: Node defers the check to the
  // next microtask turn (so a same-tick .catch() still counts as handled),
  // and installing a listener also suppresses the default crash-the-process
  // behaviour, so a genuine leak here fails this assertion instead of
  // taking the whole test run down with it.
  const leaked = [];
  const onUnhandled = (err) => leaked.push(err);
  process.on('unhandledRejection', onUnhandled);

  const id = '/call/rec-start-fail';
  backend.emit({ id, direction: 'out', state: 'active', number: '+919876543210', name: null, startedAt: new Date().toISOString() });
  advance(5000);
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919876543210', name: null, startedAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 20));

  process.off('unhandledRejection', onUnhandled);

  assert.strictEqual(store.listCalls({}).length, 1, 'the call must survive a recorder start failure');
  assert.deepStrictEqual(leaked, [], 'a caught recorder start failure must not surface as an unhandled rejection');
  store.close();
});

test('stop() finalises a still-live call\'s recording before persisting it', async () => {
  const RECORDING_PATH = '/tmp/konnect-shutdown-test.opus';
  let attached = null;
  const { store, backend, session } = setup({
    onRecord: async ({ phase, call }) => {
      if (phase !== 'stop') return;
      // Simulate the real stop-phase encode taking a moment - the whole
      // point of this test is that stop() must wait for it before persisting.
      await new Promise((r) => setTimeout(r, 15));
      attached = call.id;
      session.attachRecording(call.id, RECORDING_PATH);
    },
  });

  const id = '/call/shutdown-1';
  // The call is still live (never disconnected) when stop() is invoked -
  // this is the app-quits-mid-call scenario.
  backend.emit({ id, direction: 'out', state: 'active', number: '+919876543210', name: null, startedAt: new Date().toISOString() });

  await session.stop();

  assert.strictEqual(attached, id, 'onRecord({phase: "stop"}) must be invoked for the still-live call');
  const rows = store.listCalls({});
  assert.strictEqual(rows.length, 1, 'the still-live call must be persisted at shutdown');
  assert.strictEqual(rows[0].recording_path, RECORDING_PATH, 'the recording started before shutdown must not be lost');
  store.close();
});

// The dialer's re-entrancy guard originally lived only in the renderer, where
// a Ctrl+R reload wipes it and the next press places a SECOND REAL CALL. Main
// now refuses the dial, so this is the state that guard depends on.
test('hasLiveCall tracks the live set and clears when the call ends', () => {
  const { backend, session, store } = setup();
  assert.strictEqual(session.hasLiveCall(), false, 'idle line reported busy');

  backend.emit({ id: 'c1', direction: 'out', number: '+919876543210', state: 'dialing' });
  assert.strictEqual(session.hasLiveCall(), true, 'a dialing call is a live call');

  backend.emit({
    id: 'c1', direction: 'out', number: '+919876543210',
    state: 'active', startedAt: '2026-09-01T12:00:00Z',
  });
  assert.strictEqual(session.hasLiveCall(), true);
  assert.deepStrictEqual(session.liveCalls().map((c) => c.id), ['c1']);

  backend.emit({ id: 'c1', direction: 'out', number: '+919876543210', state: 'disconnected' });
  assert.strictEqual(session.hasLiveCall(), false, 'line still busy after hangup');
  assert.deepStrictEqual(session.liveCalls(), []);
  store.close();
});

// The call log refreshes on this hook, not on the 'disconnected' event: with
// recording on, persist() waits for the encode, so a refresh driven by the
// call event ran before the row existed and the just-ended call stayed
// missing from the log.
test('onPersisted fires only after the row is actually written', async () => {
  let released;
  const gate = new Promise((r) => { released = r; });
  const { backend, session, persisted, store } = setup({
    onRecord: ({ phase }) => (phase === 'stop' ? gate : Promise.resolve()),
  });

  backend.emit({
    id: 'c1', direction: 'in', number: '+919876543210',
    state: 'active', startedAt: '2026-09-01T12:00:00Z',
  });
  backend.emit({ id: 'c1', direction: 'in', number: '+919876543210', state: 'disconnected' });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(persisted.length, 0, 'fired before the encode finished');
  assert.strictEqual(store.listCalls({}).length, 0, 'row written before the encode finished');

  released();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(persisted.length, 1, 'never fired after the encode finished');
  assert.strictEqual(store.listCalls({}).length, 1);
  store.close();
});

// A sequential drain cost N x the encode timeout and blew the 20s shutdown
// grace for two recorded calls, losing the later rows entirely.
test('stop() drains concurrent recordings in parallel, keeping every row', async () => {
  const stops = [];
  const { backend, session, store } = setup({
    onRecord: ({ phase, call }) => {
      if (phase !== 'stop') return Promise.resolve();
      stops.push(call.id);
      return new Promise((r) => setTimeout(r, 50));
    },
  });
  for (const id of ['c1', 'c2', 'c3']) {
    backend.emit({
      id, direction: 'in', number: '+91987654321' + id.slice(-1),
      state: 'active', startedAt: '2026-09-01T12:00:00Z',
    });
  }

  const started = Date.now();
  await session.stop();
  const elapsed = Date.now() - started;

  assert.strictEqual(stops.length, 3);
  assert.strictEqual(store.listCalls({}).length, 3, 'a call was lost at shutdown');
  assert.ok(elapsed < 130, `drain was sequential: took ${elapsed}ms for 3 x 50ms`);
  store.close();
});

// Reported from real use: one outgoing and one incoming call both logged as
// Outgoing. oFono has no Direction property and both lifecycles converge on
// 'active', so a direction derived from the CURRENT state flips to 'out' the
// instant an incoming call is answered. A missed call never reaches 'active',
// which is why every earlier test passed. The second event here carries the
// wrong direction on purpose: the session must not take it.
test('an answered incoming call is logged as incoming, not outgoing', () => {
  const { backend, session, store } = setup();
  const id = '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34/voicecall01';

  backend.emit({ id, direction: 'in', state: 'incoming', number: '+919804464251' });
  backend.emit({
    id, direction: 'out', state: 'active',
    number: '+919804464251', startedAt: '2026-09-01T12:00:00Z',
  });
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+919804464251' });

  const [row] = store.listCalls({});
  assert.strictEqual(row.direction, 'in', 'answered incoming call logged as outgoing');
  store.close();
});

test('an outgoing call is still logged as outgoing', () => {
  const { backend, session, store } = setup();
  const id = '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34/voicecall02';
  backend.emit({ id, direction: 'out', state: 'dialing', number: '+917003749294' });
  backend.emit({
    id, direction: 'out', state: 'active',
    number: '+917003749294', startedAt: '2026-09-01T12:00:00Z',
  });
  backend.emit({ id, direction: 'out', state: 'disconnected', number: '+917003749294' });

  assert.strictEqual(store.listCalls({})[0].direction, 'out');
  store.close();
});

test('canDial is true when idle, false with an active or waiting call, true once every call is held', () => {
  const { backend, session, store } = setup();
  assert.strictEqual(session.canDial(), true, 'idle line refused a dial');

  backend.emit({ id: 'c1', direction: 'out', number: '+919876543210', state: 'active', startedAt: '2026-09-01T12:00:00Z' });
  assert.strictEqual(session.canDial(), false, 'dial allowed over an active call');

  backend.emit({ id: 'c1', direction: 'out', number: '+919876543210', state: 'held', startedAt: '2026-09-01T12:00:00Z' });
  assert.strictEqual(session.canDial(), true, 'dial refused although the only call is held');
  assert.strictEqual(session.liveCalls()[0].state, 'held', 'liveCalls must report the current state');

  backend.emit({ id: 'c2', direction: 'in', number: '+919804464251', state: 'waiting' });
  assert.strictEqual(session.canDial(), false, 'a waiting call must block dialing');
  store.close();
});

test('when the recorded call ends, a start is handed to the call still active', async () => {
  const phases = [];
  const { backend, store } = setup({
    onRecord: async ({ phase, call }) => { phases.push(`${phase}:${call.id}`); },
  });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'active', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'waiting' });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'held', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'active', startedAt: '2026-09-01T12:00:30Z' });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'disconnected', startedAt: '2026-09-01T12:00:00Z' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(phases, ['start:a', 'start:b', 'stop:a', 'start:b']);
  store.close();
});

test('no start is handed to a call that is held when the other ends', async () => {
  const phases = [];
  const { backend, store } = setup({
    onRecord: async ({ phase, call }) => { phases.push(`${phase}:${call.id}`); },
  });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'active', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'waiting' });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'held', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'active', startedAt: '2026-09-01T12:00:30Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'disconnected', startedAt: '2026-09-01T12:00:30Z' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(phases, ['start:a', 'start:b', 'stop:b']);
  store.close();
});
