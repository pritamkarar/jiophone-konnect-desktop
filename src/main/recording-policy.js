'use strict';

// The record_calls setting gates STARTING a recording, never stopping one.
// A recorder already running must always be stopped: gating 'stop' too means
// that switching recording off mid-call leaves pw-record capturing audio the
// user has just asked not to capture, with the file never encoded or attached.
//
// ponytail: one recorder at a time. The SCO link carries one conversation,
// so a second call going active while one is recording gets no recorder of
// its own - its audio lands in the first call's file until that call ends,
// and callsession's hand-off then starts one for it. Upgrade path: a
// session-level recorder with one file per overlapping group.
function createRecordHandler({ store, backend, attachRecording }) {
  let recording = null;   // id of the call whose recorder is running
  return async ({ phase, call }) => {
    if (phase === 'start' && store.getSetting('record_calls') !== 'true') return;
    if (phase === 'start' && recording && recording !== call.id) return;
    try {
      if (phase === 'start') {
        // Claimed before the await so a concurrent start cannot slip past.
        recording = call.id;
        await backend.startRecording(call.id);
      } else {
        if (recording === call.id) recording = null;
        const finalPath = await backend.stopRecording(call.id);
        if (finalPath) attachRecording(call.id, finalPath);
      }
    } catch (err) {
      if (phase === 'start' && recording === call.id) recording = null;
      console.error('recording failed:', err.message);
    }
  };
}

module.exports = { createRecordHandler };
