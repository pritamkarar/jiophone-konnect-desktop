'use strict';

// Which of the logged calls earn a speed-dial slot. Split out of the renderer
// for the same reason as rank.js: app.js touches `document` at load and so
// cannot be required from a test, and the dedupe below has a real failure
// mode - redialling one number four times must fill ONE slot, not four.

const SPEED_DIAL_SLOTS = 4;

// shared/phone.js's sentinel for a withheld or unidentified caller. Not
// imported: this module is also loaded as a bare <script> by the renderer,
// where require() does not exist, and duplicating one string beats teaching
// the page a second load order.
const UNKNOWN = 'unknown';

// `rows` is a listCalls() page, already ordered by ended_at DESC - that
// ordering IS the ranking, so this only has to filter and dedupe down it.
function recentlyDialled(rows, slots = SPEED_DIAL_SLOTS) {
  const picks = new Map();
  for (const r of rows || []) {
    // Anonymous numbers cannot be dialled back, so they never earn a slot.
    if (!r || r.direction !== 'out') continue;
    if (!r.number_e164 || r.number_e164 === UNKNOWN) continue;
    // First win keeps the MOST RECENT row for a number: Map preserves
    // insertion order, so the strip stays in recency order too.
    if (!picks.has(r.number_e164)) picks.set(r.number_e164, r);
    if (picks.size === slots) break;
  }
  return [...picks.values()];
}

// Dual export: required by tests under node, loaded as a plain <script> by
// the renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { recentlyDialled, SPEED_DIAL_SLOTS };
}
if (typeof window !== 'undefined') {
  window.SpeedDial = { recentlyDialled, SPEED_DIAL_SLOTS };
}
