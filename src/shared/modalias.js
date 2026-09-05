'use strict';

// BlueZ publishes org.bluez.Device1.Modalias for a handset that carries a
// Bluetooth Device ID record, e.g. "bluetooth:v001Dp1200d1436": vendor and
// product are Bluetooth SIG identifiers, and the device version is packed as
// 0xJJMN (major, minor, sub-minor) - so 0x1436 is firmware 20.3.6.
const BT_MODALIAS = /^bluetooth:v([0-9A-Fa-f]{4})p([0-9A-Fa-f]{4})d([0-9A-Fa-f]{4})$/;

function parseModalias(s) {
  if (typeof s !== 'string') return null;
  const m = BT_MODALIAS.exec(s.trim());
  if (!m) return null;
  const v = parseInt(m[3], 16);
  return {
    vendor: m[1].toUpperCase(),
    product: m[2].toUpperCase(),
    version: `${v >> 8}.${(v >> 4) & 0xf}.${v & 0xf}`,
  };
}

// One vendor is not a table: the only handset this was built against is
// Qualcomm inside. Everything else shows its raw identifier, which is what a
// bug report needs anyway.
function describePnp(pnp) {
  if (!pnp) return '';
  return pnp.vendor === '001D'
    ? `Qualcomm ${pnp.vendor}:${pnp.product} · firmware ${pnp.version}`
    : `Vendor ${pnp.vendor} · product ${pnp.product} · firmware ${pnp.version}`;
}

// Dual export: required by tests and main under node, loaded as a plain
// <script> by the renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) module.exports = { parseModalias, describePnp };
if (typeof window !== 'undefined') { window.Modalias = { parseModalias, describePnp }; }
