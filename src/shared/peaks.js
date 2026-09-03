'use strict';

// Reduces decoded PCM to one bar height per waveform column. Split out of the
// renderer for the same reason speeddial.js and rank.js are: the bucketing
// rule is worth testing, and a test cannot hold an AudioContext.
//
// Peak per bucket rather than RMS or an average: a call recording is mostly
// speech separated by silence, and averaging flattens it into an even smear
// that carries no information about where anyone actually spoke.
//
// Normalised to the loudest bucket, so a quiet handset recording still draws
// a full-height waveform instead of a flat line. That means the bars show
// relative loudness WITHIN one recording and are not comparable between two.
function peaksFrom(samples, count) {
  const n = Math.max(1, Math.floor(count) || 0);
  const out = new Array(n).fill(0);
  if (!samples || samples.length === 0) return out;

  const per = samples.length / n;
  let loudest = 0;
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(i * per);
    // At least one sample per bucket: with fewer samples than bars, start and
    // end collapse to the same index and every bar would read zero.
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * per)));
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > loudest) loudest = peak;
  }

  // Guarded: digital silence divides by zero and paints every bar NaN, which
  // renders as a bar with no height attribute at all rather than a flat one.
  if (loudest > 0) for (let i = 0; i < n; i += 1) out[i] /= loudest;
  return out;
}

// Dual export: required by tests under node, loaded as a plain <script> by the
// renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) module.exports = { peaksFrom };
if (typeof window !== 'undefined') { window.Peaks = { peaksFrom }; }
