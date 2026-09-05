'use strict';
const { normaliseIndian, UNKNOWN_NUMBER } = require('../shared/phone');

// Converts the oFono call event stream into durable rows.
//
// Duration is measured from StartTime, which oFono emits only on the
// transition to active. A call that never reaches active has no StartTime,
// zero duration, and - if inbound - is a missed call.
function createCallSession({
  backend, store, now = () => new Date(), onRecord = null, onPersisted = null,
}) {
  const live = new Map();   // call id -> { direction, number, name, startedAt, state }
  let unsubscribe = null;

  function persist(id) {
    const entry = live.get(id);
    if (!entry) return;                 // unknown or already persisted
    live.delete(id);

    const endedAt = now();
    let duration = 0;
    if (entry.startedAt) {
      const started = new Date(entry.startedAt).getTime();
      const seconds = Math.round((endedAt.getTime() - started) / 1000);
      // A StartTime Date cannot parse yields NaN, which SQLite rejects against
      // the NOT NULL duration column. The insert would throw AFTER the entry
      // was removed from `live`, losing the call entirely, and the exception
      // would escape into the D-Bus signal handler that delivered the event.
      duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    }

    // Contacts are stored normalised, so call numbers must be too - otherwise
    // the exact-match contact lookup silently misses and caller id never
    // resolves. Normalisation is idempotent for already-E.164 input.
    const normalised = entry.number ? (normaliseIndian(entry.number) || entry.number) : null;

    try {
      store.insertCall({
        direction: entry.direction,
        number_e164: normalised || UNKNOWN_NUMBER,
        started_at: entry.startedAt || null,
        ended_at: endedAt.toISOString(),
        duration_s: duration,
        recording_path: entry.recordingPath || null,
      });
      // The call log refreshes on this, NOT on the disconnected event. With
      // recording on, persist() waits for the encode - seconds - so a refresh
      // driven by 'disconnected' queried before the row existed and nothing
      // re-triggered it: the call the user just finished was missing from the
      // log and stayed missing.
      if (onPersisted) onPersisted();
    } catch (err) {
      // This runs inside a D-Bus signal handler. Losing one row is bad; an
      // exception escaping into the event path would break call handling for
      // the rest of the session.
      console.error('[konnect] failed to persist call:', err.message);
    }
  }

  async function handle(call) {
    if (!call || !call.id) return;

    if (call.state === 'disconnected') {
      // Marked BEFORE the awaited stop: a sibling ending in the same instant
      // runs its own hand-off loop while this entry is still in `live`, and
      // must not hand a recorder to a call that is on its way out.
      const ending = live.get(call.id);
      if (ending) ending.state = 'disconnected';
      // Awaited, because attachRecording() must land before persist() writes
      // the row - there is no path to backfill recording_path afterwards.
      //
      // Guarded, because a recorder failure must NOT cost the call log entry:
      // the row is the primary record and the recording is an attachment to
      // it. Unguarded, a throw here skips persist() entirely (the call
      // vanishes) and escapes as an unhandled rejection out of a D-Bus signal
      // handler. Measured: 0 rows persisted unguarded, 1 guarded.
      if (onRecord) {
        try {
          await onRecord({ phase: 'stop', call });
        } catch (err) {
          console.error('[konnect] recorder stop failed:', err.message);
        }
      }
      persist(call.id);
      // Hand-off (spec 2026-09-05 §8): the recorder follows the audio link.
      // With the ended call's recorder stopped, the call still being spoken
      // on - if any - gets its turn. The handler's one-at-a-time rule and its
      // setting check both still apply, so this is a no-op unless a recorder
      // can and should start. Fire-and-forget and caught, as the start
      // trigger below is: this runs inside a D-Bus signal handler.
      if (onRecord) {
        for (const [id, entry] of live) {
          if (entry.state !== 'active') continue;
          Promise.resolve(onRecord({ phase: 'start', call: { id, ...entry } }))
            .catch((err) => console.error('[konnect] recorder hand-off failed:', err.message));
        }
      }
      return;
    }

    const prev = live.get(call.id) || {};
    const next = {
      // Preferred from prev like every other field here. The backend latches
      // direction now, but this is the layer that decides what is WRITTEN, and
      // it should not depend on an upstream invariant to record a call as the
      // direction it actually was.
      direction: prev.direction || call.direction,
      number: call.number || prev.number || null,
      name: call.name || prev.name || null,
      // StartTime arrives once and must never be overwritten with null.
      startedAt: call.startedAt || prev.startedAt || null,
      recordingPath: prev.recordingPath || null,
      // The current oFono state. canDial() below reads it, and a renderer
      // re-seeding from liveCalls() after a reload needs it to draw the panel.
      state: call.state,
      // Read back by the renderer's re-seed: the "Conference" label and the
      // Merge button's visibility both key off it.
      multiparty: Boolean(call.multiparty),
    };
    live.set(call.id, next);

    if (onRecord && call.state === 'active' && !prev.startedAt && next.startedAt) {
      // Fire-and-forget: the call is already live and its row is written on
      // hangup regardless. Caught so a recorder failure cannot surface as an
      // unhandled rejection out of a D-Bus signal handler.
      Promise.resolve(onRecord({ phase: 'start', call }))
        .catch((err) => console.error('[konnect] recorder start failed:', err.message));
    }
  }

  return {
    start() { if (!unsubscribe) unsubscribe = backend.onCall(handle); },
    // Authoritative: main owns the live-call set, the renderer only mirrors it.
    hasLiveCall() { return live.size > 0; },
    // The dial guard. "Add call" is hold-then-dial: a dial is refused unless
    // every live call is held, so an accidental Call press during a
    // conversation still cannot place a second real call. Vacuously true
    // when idle.
    canDial() { return [...live.values()].every((e) => e.state === 'held'); },
    liveCalls() { return [...live.entries()].map(([id, entry]) => ({ id, ...entry })); },
    // Async so recordings can be finalised before their rows are written -
    // the same ordering the disconnected path uses. Without it a call still
    // live at shutdown is persisted with recording_path null while its
    // recorder keeps running.
    async stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      // Concurrently, not sequentially. Each encode is bounded at 15s and the
      // shutdown grace is 20s, so a sequential drain of N recordings needed
      // N x 15s and blew the grace for N >= 2 - the grace won, app.exit(0) ran
      // synchronously, and the remaining calls' rows were never written even
      // though their WAVs were on disk. Concurrently, N encodes still cost 15s.
      await Promise.all([...live.keys()].map(async (id) => {
        const entry = live.get(id);
        if (onRecord && entry) {
          try {
            await onRecord({ phase: 'stop', call: { id, ...entry } });
          } catch (err) {
            console.error('[konnect] recorder stop failed at shutdown:', err.message);
          }
        }
        persist(id);
      }));
    },
    // exposed so the recorder can attach a path before the row is written
    attachRecording(id, path) {
      const entry = live.get(id);
      if (entry) entry.recordingPath = path;
    },
  };
}

module.exports = { createCallSession };
