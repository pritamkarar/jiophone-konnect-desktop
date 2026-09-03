const test = require('node:test');
const assert = require('node:assert');
const { peaksFrom } = require('../src/shared/peaks');

test('returns exactly the requested number of bars', () => {
  assert.strictEqual(peaksFrom(new Float32Array(1000), 40).length, 40);
  assert.strictEqual(peaksFrom(new Float32Array(3), 40).length, 40);
});

test('the loudest bucket normalises to 1 and nothing exceeds it', () => {
  const samples = Float32Array.from([0.1, 0.2, 0.05, 0.4, 0.02, 0.01]);
  const peaks = peaksFrom(samples, 3);
  assert.strictEqual(Math.max(...peaks), 1);
  assert.ok(peaks.every((p) => p >= 0 && p <= 1), peaks.join(','));
});

test('a quiet recording still fills the waveform', () => {
  // Normalisation is what stops a -40dB call drawing a flat line.
  const loud = peaksFrom(Float32Array.from([0.9, 0.3, 0.6]), 3);
  const quiet = peaksFrom(Float32Array.from([0.009, 0.003, 0.006]), 3);
  // Same shape, not the same bits: Float32 rounding makes 0.003/0.009 and
  // 0.3/0.9 differ in the last place, which says nothing about the waveform.
  quiet.forEach((p, i) => assert.ok(Math.abs(p - loud[i]) < 1e-6, `bar ${i}: ${p} vs ${loud[i]}`));
  assert.strictEqual(Math.max(...quiet), 1);
});

test('peak, not average, so speech survives the silence around it', () => {
  // One loud sample in a bucket of silence must still raise that bar; an
  // averaging bucket would bury it.
  const samples = new Float32Array(100);
  samples[50] = 1;
  const peaks = peaksFrom(samples, 4);
  assert.strictEqual(peaks[2], 1);
  assert.strictEqual(peaks[0], 0);
});

test('digital silence is flat, never NaN', () => {
  // Dividing by a zero loudest would paint every bar NaN, which renders as a
  // bar with no height at all rather than a flat one.
  const peaks = peaksFrom(new Float32Array(500), 8);
  assert.deepStrictEqual(peaks, new Array(8).fill(0));
});

test('negative samples count: a waveform is symmetric about zero', () => {
  assert.deepStrictEqual(peaksFrom(Float32Array.from([-1, 0.5]), 2), [1, 0.5]);
});

test('missing or empty input yields a flat waveform, not a throw', () => {
  assert.deepStrictEqual(peaksFrom(null, 3), [0, 0, 0]);
  assert.deepStrictEqual(peaksFrom(new Float32Array(0), 3), [0, 0, 0]);
});

test('a nonsense bar count still yields a drawable waveform', () => {
  assert.strictEqual(peaksFrom(new Float32Array(10), 0).length, 1);
  assert.strictEqual(peaksFrom(new Float32Array(10), -5).length, 1);
  assert.strictEqual(peaksFrom(new Float32Array(10), undefined).length, 1);
});
