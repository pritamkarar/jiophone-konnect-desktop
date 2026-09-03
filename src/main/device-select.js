'use strict';
const { isValidMac } = require('./backend/linux/bus');

// Which handset Konnect binds to when `device_mac` has never been set.
// Pure so the rule is testable without BlueZ; index.js supplies the device
// list. An unpaired device is never a candidate: HFP needs a bond, so
// picking one would produce a backend that can never connect.
function pickBootstrapMac(storedMac, devices) {
  // A stored address that no longer parses must not be trusted into
  // devicePathFor() - it would throw during startup with no way for the user
  // to clear it. Falling through to BlueZ resolution lets the app recover on
  // its own.
  if (isValidMac(storedMac)) return storedMac;
  const paired = (devices || []).filter((d) => d && d.paired);
  const connected = paired.find((d) => d.connected);
  return (connected || paired[0] || {}).mac || null;
}

// Whether startup should ask BlueZ to reconnect the handset. Pure for the
// same reason pickBootstrapMac is: the caller supplies the two facts, so the
// rule can be checked without a bus.
//
// Keyed off the SETTING, never the bound mac. The backend binds to a
// bootstrap device on a first run too, and connecting to THAT would race the
// onboarding wizard's own Connect() on the same handset - binding is not
// choosing. An unparseable stored address is refused for the same reason
// pickBootstrapMac ignores one: devicePathFor() would throw on it, and this
// call is detached, so the throw would surface as an unhandled rejection.
function shouldReconnect({ storedMac, connected }) {
  return isValidMac(storedMac) && !connected;
}

module.exports = { pickBootstrapMac, shouldReconnect };
