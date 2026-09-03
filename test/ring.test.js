'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { startRing, stopRing } = require('../src/main/backend/linux/audio');

// A fake pw-play child: an EventEmitter so the test controls exactly when
// 'exit' fires and with what code, plus a no-op kill() so stopRing() has
// something to call. Never spawns a real process.
function fakeSpawner(calls) {
  return (...args) => {
    const child = new EventEmitter();
    child.kill = () => {};
    calls.push({ args, child });
    return child;
  };
}

// ringProc/ringWanted are module-level state shared by every test in this
// file - reset it before and after each test so one test's leftover latch
// can't make the next one's startRing() a silent no-op.
test.beforeEach(() => stopRing());
test.afterEach(() => stopRing());

test('a fast non-zero exit stops the loop without respawning', () => {
  const calls = [];
  startRing({ tone: '/nonexistent/ringtone.ogg', spawnFn: fakeSpawner(calls) });
  assert.strictEqual(calls.length, 1);
  calls[0].child.emit('exit', 1);
  assert.strictEqual(calls.length, 1, 'a fast failing exit must not respawn');
});

test('a clean exit respawns to keep the ring looping', () => {
  const calls = [];
  startRing({ tone: '/tmp/ringtone.ogg', spawnFn: fakeSpawner(calls) });
  assert.strictEqual(calls.length, 1);
  calls[0].child.emit('exit', 0);
  assert.strictEqual(calls.length, 2, 'a clean exit while still wanted must respawn');
});

test('startRing is idempotent while already ringing', () => {
  const calls = [];
  const spawnFn = fakeSpawner(calls);
  startRing({ tone: '/tmp/ringtone.ogg', spawnFn });
  startRing({ tone: '/tmp/ringtone.ogg', spawnFn });
  assert.strictEqual(calls.length, 1, 'a second startRing() must not spawn a second process');
});

test('stopRing prevents a respawn even when exit lands after it', () => {
  const calls = [];
  startRing({ tone: '/tmp/ringtone.ogg', spawnFn: fakeSpawner(calls) });
  assert.strictEqual(calls.length, 1);
  stopRing();
  // Simulates the exact race the ringWanted latch exists for: the exit event
  // lands after stopRing() has already cancelled the ring.
  calls[0].child.emit('exit', 0);
  assert.strictEqual(calls.length, 1, 'an exit racing stopRing() must not respawn');
});

test('stopRing with nothing running does not throw', () => {
  assert.doesNotThrow(() => stopRing());
});
