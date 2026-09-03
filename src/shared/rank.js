'use strict';

// Bluetooth Class of Device: bits 8-12 are the major device class, and 0x02
// is Phone. See the Bluetooth assigned-numbers document.
const PHONE_MAJOR = 0x02;

// Deliberately a RANKING input, never a filter (spec §3.1). BlueZ populates
// Icon and Class asynchronously during discovery, so a device that is not yet
// identifiable as a phone must stay selectable rather than disappear.
function isPhone(d) {
  if (!d) return false;
  if (d.icon === 'phone') return true;
  if (typeof d.cls === 'number' && Number.isFinite(d.cls)) {
    return ((d.cls >> 8) & 0x1f) === PHONE_MAJOR;
  }
  return false;
}

function rankDiscovered(devices) {
  const decorated = (devices || []).map((d, i) => ({ d, i }));
  // Stable: equal RSSI keeps discovery order, so the list does not reshuffle
  // under the user's cursor on every poll tick.
  const byStrength = (a, b) => {
    const ar = typeof a.d.rssi === 'number' ? a.d.rssi : -999;
    const br = typeof b.d.rssi === 'number' ? b.d.rssi : -999;
    return br - ar || a.i - b.i;
  };
  const phones = decorated.filter((x) => isPhone(x.d)).sort(byStrength).map((x) => x.d);
  const others = decorated.filter((x) => !isPhone(x.d)).sort(byStrength).map((x) => x.d);
  return { phones, others };
}

// RSSI in dBm, as BlueZ reports it. -60 and better is the same room with
// nothing in the way; past -80 the link is already dropping packets. Devices
// BlueZ knew about before this discovery started carry no reading at all.
function signalLabel(rssi) {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi)) return 'Signal unknown';
  if (rssi >= -60) return 'Strong signal';
  if (rssi >= -80) return 'Fair signal';
  return 'Weak signal';
}

// oFono reports signal strength as a PERCENTAGE - not the dBm that discovery
// hands signalLabel above. Four blocks, one per quarter, so an empty string is
// the honest answer for no reading at all.
function signalBars(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return '';
  const bars = ['\u2582', '\u2584', '\u2586', '\u2588'];
  return bars.slice(0, Math.max(0, Math.min(bars.length, Math.ceil(percent / 25)))).join('');
}

// Dual export: this module is required by tests under node and loaded as a
// plain <script> by the renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) module.exports = { isPhone, rankDiscovered, signalLabel, signalBars };
if (typeof window !== 'undefined') { window.Rank = { isPhone, rankDiscovered, signalLabel, signalBars }; }
