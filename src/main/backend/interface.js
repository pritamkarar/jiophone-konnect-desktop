'use strict';

class UnsupportedPlatformError extends Error {
  constructor(platform) {
    super(`Konnect has no backend for platform: ${platform}`);
    this.name = 'UnsupportedPlatformError';
  }
}

// The contract. Every backend must implement all of these.
const BACKEND_METHODS = [
  'listDevices', 'connect', 'disconnect', 'getStatus', 'onDeviceStatus',
  'dial', 'answer', 'hangup', 'sendDtmf', 'swapCalls', 'createMultiparty', 'onCall',
  'startContactImport', 'cancelContactImport', 'onContacts',
  'startRecording', 'stopRecording',
  'verifyLink', 'getCallVolume', 'setCallVolume', 'onCallVolume',
];

// Minimal typed-event helper shared by backends. Returns an unsubscribe fn,
// so callers never need to hold onto the original callback.
function createEmitter() {
  const listeners = new Set();
  return {
    on(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    emit(value) { for (const cb of [...listeners]) cb(value); },
    get size() { return listeners.size; },
  };
}

module.exports = { UnsupportedPlatformError, BACKEND_METHODS, createEmitter };
