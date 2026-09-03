'use strict';
const { UnsupportedPlatformError } = require('./interface');
const { createMockBackend } = require('./mock');
const { createWindowsBackend } = require('./windows');

function createBackend({ platform = process.platform, mock = false, mac, getSetting } = {}) {
  if (mock) return createMockBackend();
  if (platform === 'linux') {
    // Required lazily: pulls in dbus-next, which has no meaning off Linux.
    const { createLinuxBackend } = require('./linux');
    // Pass mac through even when null - `{}` would fall back to a default
    // that no longer exists, and silently binding to some other handset is
    // exactly what this change removes.
    return createLinuxBackend({ mac: mac ?? null, getSetting });
  }
  if (platform === 'win32') return createWindowsBackend();
  throw new UnsupportedPlatformError(platform);
}

module.exports = { createBackend };
