'use strict';

// The record_calls setting gates STARTING a recording, never stopping one.
// A recorder already running must always be stopped: gating 'stop' too means
// that switching recording off mid-call leaves pw-record capturing audio the
// user has just asked not to capture, with the file never encoded or attached.
function createRecordHandler({ store, backend, attachRecording }) {
  return async ({ phase, call }) => {
    if (phase === 'start' && store.getSetting('record_calls') !== 'true') return;
    try {
      if (phase === 'start') {
        await backend.startRecording(call.id);
      } else {
        const finalPath = await backend.stopRecording(call.id);
        if (finalPath) attachRecording(call.id, finalPath);
      }
    } catch (err) {
      console.error('recording failed:', err.message);
    }
  };
}

module.exports = { createRecordHandler };
