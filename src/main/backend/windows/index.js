'use strict';
const { BACKEND_METHODS, UnsupportedPlatformError } = require('../interface');

// Stub only. Windows has no public API for the HFP hands-free role or PBAP,
// and SCO call audio is unreachable. See spec section 2 and 11.
//
// No `adapter` namespace: Windows has no pairing implementation, so callers
// guard with `if (backend.adapter)` exactly as they do for `audio`.
function createWindowsBackend() {
  const backend = {};
  for (const name of BACKEND_METHODS) {
    backend[name] = async () => { throw new UnsupportedPlatformError('win32'); };
  }
  return backend;
}

module.exports = { createWindowsBackend };
