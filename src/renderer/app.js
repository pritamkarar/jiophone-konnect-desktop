'use strict';

const $ = (sel) => document.querySelector(sel);

// What the handset's HFP gateway advertised, from the last status event.
// Gates the hold/swap/merge buttons: absent feature, absent button.
let handsfreeFeatures = [];

function showView(name) {
  for (const b of document.querySelectorAll('#nav button')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === `view-${name}`);
  }
}

for (const b of document.querySelectorAll('#nav button')) {
  b.addEventListener('click', () => {
    showView(b.dataset.view);
    if (b.dataset.view === 'calls') renderCalls();
    if (b.dataset.view === 'contacts') loadContacts();
    if (b.dataset.view === 'settings') renderSettings();
  });
}

function renderStatus(s) {
  if (!s) return;

  // s.error means the status could not be READ - the bus is unreachable, or
  // the modem is offline. Reporting "Disconnected" in that case is precisely
  // the masquerade the error field exists to prevent, so say "Unknown" and
  // show what actually went wrong.
  const banner = $('#s-error');
  banner.textContent = s.error ? `Cannot read handset status: ${s.error}` : '';
  banner.hidden = !s.error;

  $('#s-model').textContent = s.model || 'Not detected';
  // device.js reports connected:false whenever the BlueZ read itself failed,
  // so connected===true proves BlueZ answered cleanly and the error came from
  // oFono alone - typically this handset powering its modem down. Reporting
  // "Unknown" there told the user the app was broken when Bluetooth was fine.
  $('#s-conn').textContent = s.error
    ? (s.connected ? 'Connected (telephony unavailable)' : 'Unknown')
    : (s.connected ? 'Connected' : 'Disconnected');
  // The title-bar pill is now the only always-visible status readout, so it
  // carries the same three-way distinction the text above makes: green only
  // when the link is genuinely good, red when it is genuinely down, and
  // neutral when the read itself failed and we do not actually know.
  const dot = $('#s-dot');
  dot.className = `dot ${s.connected ? 'ok' : (s.error ? '' : 'bad')}`.trim();
  $('#s-op').textContent = s.operator || '-';
  $('#s-sig').textContent = s.signal === null || s.signal === undefined ? '-' : `${s.signal}%`;
  $('#s-bat').textContent = s.battery === null || s.battery === undefined ? '-' : `${s.battery}%`;

  // Re-derive the call panel's buttons only when the list actually changes:
  // status events arrive every 30s and on every BlueZ property change.
  const features = Array.isArray(s.features) ? s.features : [];
  if (features.join() !== handsfreeFeatures.join()) {
    handsfreeFeatures = features;
    renderCall(null);
  }
}

async function renderChecks() {
  const list = $('#checks');
  list.innerHTML = '<li class="muted">Running...</li>';
  const results = await window.konnect.runSetupChecks();
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${r.ok ? 'ok' : 'bad'}`;
    const label = document.createElement('span');
    label.textContent = r.label;
    li.append(dot, label);
    if (!r.ok) {
      const fix = document.createElement('button');
      fix.className = 'primary';
      fix.textContent = 'Fix';
      fix.style.marginLeft = 'auto';
      fix.addEventListener('click', async () => {
        fix.disabled = true;
        fix.textContent = 'Working...';
        let result;
        try {
          result = await window.konnect.remediate(r.id);
        } catch (e) {
          // remediate() only rejects for an unknown id - a programming error.
          // Deliberately NOT r.remedy: that is a human description, and
          // offering prose as a copyable command is the defect this fallback
          // was built to remove.
          result = { ok: false, reason: 'failed', detail: e.message, command: null };
        }
        if (result && result.ok) { renderChecks(); return; }
        // Never dead-end: show the command so the user can run it by hand.
        showManualStep(li, result);
        fix.disabled = false;
        fix.textContent = 'Fix';
      });
      li.append(fix);
    }
    list.append(li);
  }
}

// Setup must never dead-end because a password prompt was dismissed
// (spec 4.4). Whatever went wrong, surface the command to run by hand.
const ELEVATION_MESSAGE = {
  cancelled: 'The authentication prompt was dismissed. Run this yourself, then press Recheck:',
  unavailable: 'Could not request administrator access. Run this yourself, then press Recheck:',
  failed: 'That command failed. Run it yourself to see why, then press Recheck:',
};

function showManualStep(container, result) {
  container.querySelector('.manual-step')?.remove();
  const box = document.createElement('div');
  box.className = 'manual-step';

  const msg = document.createElement('p');
  msg.textContent = ELEVATION_MESSAGE[result?.reason] || ELEVATION_MESSAGE.failed;

  const cmd = document.createElement('code');
  cmd.textContent = result?.command || '(no command available)';

  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd.textContent).then(
      () => { copy.textContent = 'Copied'; },
      () => { copy.textContent = 'Copy failed'; });
  });

  const recheck = document.createElement('button');
  recheck.textContent = 'Recheck';
  recheck.addEventListener('click', renderChecks);

  box.append(msg, cmd, copy, recheck);
  container.append(box);
}

$('#run-checks').addEventListener('click', renderChecks);
window.konnect.onStatus(renderStatus);
window.konnect.getStatus().then(renderStatus).catch(() => {});
window.konnect.appVersion().then((v) => { $('#app-version').textContent = `v${v}`; }).catch(() => {});

// Manual routing's whole hazard is a failure the user cannot hear the cause
// of - a dead-silent call is otherwise indistinguishable from a working one.
// Its own banner (#s-route), not #s-error: renderStatus() unconditionally
// clears #s-error on every status:changed - a 30s poll plus every BlueZ
// PropertiesChanged, frequent during a call - which would erase this banner
// seconds after it appeared.
window.konnect.onRouting((r) => {
  const banner = $('#s-route');
  // Explicitly clear on success. Nothing else clears this element, so an
  // early return would leave a stale warning up for the life of the window,
  // across later calls that routed perfectly.
  if (!r.fellBack && r.remoteLinked && r.micLinked) {
    banner.textContent = '';
    banner.hidden = true;
    return;
  }
  if (r.fellBack) {
    banner.textContent = `Call audio is using system defaults: ${r.reason}`;
  } else if (!r.remoteLinked) {
    banner.textContent = 'Call audio could not be routed to the selected device.';
  } else {
    // micLinked false: the call sounds fine to the user, which is exactly why
    // this needs saying out loud.
    banner.textContent = 'Your microphone could not be routed to the call - the other side may not hear you.';
  }
  banner.hidden = false;
});

// Mirrors the persisted record_calls setting so the REC indicator reflects
// what the main process will actually do on the next active transition.
let recordCalls = false;

async function loadRecordSetting() {
  recordCalls = (await window.konnect.getSetting('record_calls')) === 'true';
  $('#s-record').checked = recordCalls;
}

$('#s-record').addEventListener('change', async (event) => {
  // Only mirror the setting once the write has actually landed. Setting it
  // first meant a rejected write left the checkbox and the REC indicator
  // claiming recording was on while main would not record.
  const wanted = event.target.checked;
  try {
    await window.konnect.setSetting('record_calls', wanted ? 'true' : 'false');
  } catch (e) {
    event.target.checked = recordCalls;
    alert(`Could not save the recording setting: ${e.message}`);
    return;
  }
  recordCalls = wanted;
});

loadRecordSetting().catch(() => {});

// ---- dialer -------------------------------------------------------------
// Every live call, keyed by id. The handset advertises three-way-calling and
// oFono reports a second inbound call as 'waiting', so more than one call can
// exist at once. Tracking only "the" call made a second call steal the panel,
// stop the first call's timer, and silently retarget Hangup at the wrong one.
const liveCalls = new Map();
let activeCall = null;
let timerHandle = null;

// The Call button is enabled only when every live call is held (idle counts)
// AND no dial is waiting for its first call event. Inferring that from
// liveCalls alone is not enough: dial() resolves before CallAdded arrives, so
// liveCalls is briefly empty while a call is genuinely on its way - and a
// backstop armed by an EARLIER dial can fire inside a later dial's window and
// re-open the same hole.
let dialPending = false;
let dialBackstop = null;

// Mirrors callsession.canDial() in main: a dial is allowed only when every
// live call is held. Main independently refuses; this is the display half.
const allHeld = () => [...liveCalls.values()].every((c) => c.state === 'held');

function updateDialButton() {
  $('#d-call').disabled = dialPending || !allHeld();
}

function clearDialPending() {
  dialPending = false;
  if (dialBackstop) {
    clearTimeout(dialBackstop);
    dialBackstop = null;
  }
  updateDialButton();
}

// Which call the in-call panel represents. An active call outranks a ringing
// one: an incoming call already surfaces as a desktop notification and its own
// window, so the panel keeps showing the conversation actually in progress.
function primaryCall() {
  for (const call of liveCalls.values()) {
    if (call.state === 'active') return call;
  }
  let last = null;
  for (const call of liveCalls.values()) last = call;
  return last;
}

// Also renders the Talk time stat, which sums a whole date range and so
// crosses an hour in ordinary use - without the rollover it read "600:00".
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  // Clearing the interval leaves the last value on screen, and #c-timer is the
  // largest element on the panel. Without this the NEXT call displays the
  // previous call's final duration while it is still dialing, reading as if it
  // had already connected. startTimer() calls stopTimer() first and then ticks
  // immediately, so resetting here costs it nothing.
  $('#c-timer').textContent = '00:00';
}

// Duration counts from StartTime, which oFono emits only on answer. Counting
// from dial time would inflate every call by its ring duration.
function startTimer(startedAt) {
  stopTimer();
  const base = startedAt ? new Date(startedAt).getTime() : Date.now();
  const tick = () => {
    const secs = Math.max(0, Math.floor((Date.now() - base) / 1000));
    $('#c-timer').textContent = formatDuration(secs);
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

// Feather's mic / mic-off. The button is icon-only, so paintMute() carries the
// state in aria-label and title - dropping the visible word must not drop the
// accessible name with it.
// Named for the state they show, and NOT `MIC_ICON`: settings.js already
// declares that, and every renderer script shares one global scope - a second
// top-level `const MIC_ICON` is a SyntaxError that takes the whole of
// settings.js down with it.
const MIC_LIVE_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="1" width="6" height="12" rx="3"/>' +
  '<path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/></svg>';
const MIC_MUTED_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V4a3 3 0 0 0-5.9-.6"/>' +
  '<path d="M17 17a7 7 0 0 1-12-5v-2m14 0v2a7 7 0 0 1-.1 1.2M12 19v4"/>' +
  '<path d="M2 2l20 20"/></svg>';

// Mutes THIS PC's microphone, not the handset's. Under HFP the phone is the
// audio gateway and the PC is the headset, so the caller hears the PC's
// capture node - and the handset's own org.ofono.CallVolume.Muted answers
// "Implementation not provided" on the JioPhone anyway. See setMicMute in
// backend/linux/audio.js.
//
// Re-read at the start of every call rather than remembered across them: the
// mute lives on the PipeWire node, so one left on from last time is still on,
// and the button has to show it the moment the next call goes active or the
// user talks into a dead microphone.
let micMuted = false;
// The call the current reading belongs to, so the re-read happens once per
// call rather than on every property event oFono emits during it.
let muteReadFor = null;

function paintMute() {
  const btn = $('#c-mute');
  btn.innerHTML = micMuted ? MIC_MUTED_ICON : MIC_LIVE_ICON;   // module constants
  btn.classList.toggle('is-muted', micMuted);
  btn.setAttribute('aria-pressed', String(micMuted));
  const label = micMuted ? 'Unmute microphone' : 'Mute microphone';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

async function readMute() {
  const btn = $('#c-mute');
  const muted = await window.konnect.getMicMute().catch(() => null);
  // null is "could not read" - the node is missing, or wpctl printed something
  // unrecognised. A button that cannot read the microphone must not claim to
  // know whether it is live; disabled says "unavailable", where a cheerful
  // unmuted mic icon would be a guess.
  btn.disabled = muted === null;
  if (muted !== null) micMuted = muted;
  paintMute();
}

// The call whose line is behind the shown one, for the second-line Answer.
let otherCall = null;

function stateText(call) {
  if (call.state === 'held') return 'On hold';
  if (call.state === 'active' && call.multiparty) return 'Conference';
  return call.state;
}

function renderCall(call) {
  if (call) {
    if (call.state === 'disconnected') liveCalls.delete(call.id);
    else liveCalls.set(call.id, call);
  }

  // A call exists, so whatever dial was pending has landed. Cancelling the
  // backstop here is what stops it firing inside a LATER dial's window.
  // Only on a call event: renderStatus re-renders with null when the feature
  // list changes, and that proves nothing about a pending dial.
  if (call && liveCalls.size > 0) clearDialPending();
  updateDialButton();

  const shown = primaryCall();
  const panel = $('#call-panel');
  if (!shown) {
    panel.hidden = true;
    // Reset explicitly rather than relying on the hidden panel to hide it by
    // cascade - otherwise the element's own hidden state stays stale (false)
    // between calls even though nothing renders it.
    $('#c-rec').hidden = true;
    $('#c-other').hidden = true;
    stopTimer();
    activeCall = null;
    otherCall = null;
    return;
  }

  activeCall = shown;
  panel.hidden = false;
  $('#c-name').textContent = shown.name || 'Unknown';
  $('#c-number').textContent = shown.number || '-';
  $('#c-state').textContent = stateText(shown);
  // The recorder starts on the active transition when the setting is on, so
  // this mirrors what the main process is actually doing rather than guessing.
  $('#c-rec').hidden = !(recordCalls && shown.state === 'active');
  // A lone waiting call (its partner ended first) is still answerable here;
  // main routes it through HoldAndAnswer, which accepts it with nothing to hold.
  $('#c-answer').hidden = !(shown.state === 'incoming' || shown.state === 'waiting');
  // Only while the call is up: there is no microphone in the path to mute
  // while it is still ringing or dialling. A held call keeps its timer -
  // it is still a call - but has no microphone in the path either.
  const talking = shown.state === 'active';
  $('#c-mute').hidden = !talking;
  if (!talking) muteReadFor = null;
  else if (muteReadFor !== shown.id) { muteReadFor = shown.id; readMute(); }
  if (talking || shown.state === 'held') startTimer(shown.startedAt); else stopTimer();

  // Hold / Resume / Swap / Merge, derived from what is live (spec §7). All
  // hidden while a call is waiting: oFono refuses CHLD=2 and CHLD=3 then,
  // and the waiting call must be answered or declined first.
  const calls = [...liveCalls.values()];
  const active = calls.filter((c) => c.state === 'active').length;
  const held = calls.filter((c) => c.state === 'held').length;
  const waiting = calls.filter((c) => c.state === 'waiting').length;
  const settled = waiting === 0 && handsfreeFeatures.includes('three-way-calling');
  const holdBtn = $('#c-hold');
  if (settled && active >= 1 && held === 0) { holdBtn.hidden = false; holdBtn.textContent = 'Hold'; }
  else if (settled && active === 0 && held >= 1) { holdBtn.hidden = false; holdBtn.textContent = 'Resume'; }
  else holdBtn.hidden = true;
  $('#c-swap').hidden = !(settled && active >= 1 && held >= 1);
  $('#c-merge').hidden = !(settled && active >= 1 && held >= 1 && !shown.multiparty
    && handsfreeFeatures.includes('create-multiparty'));

  // The other call: held behind the shown one, or waiting to be answered.
  otherCall = calls.find((c) => c.id !== shown.id && (c.state === 'held' || c.state === 'waiting')) || null;
  $('#c-other').hidden = !otherCall;
  if (otherCall) {
    const who = otherCall.name || otherCall.number || 'Unknown';
    $('#c-other-text').textContent = `${otherCall.state === 'waiting' ? 'Waiting' : 'On hold'}: ${who}`;
    $('#c-other-answer').hidden = otherCall.state !== 'waiting';
  }
}

for (const key of document.querySelectorAll('.keypad button')) {
  key.addEventListener('click', () => {
    if (activeCall && activeCall.state === 'active') {
      window.konnect.sendDtmf(key.textContent);
    } else {
      $('#d-number').value += key.textContent;
    }
  });
}

// type="tel" restricts nothing - it is a keyboard hint, so the field happily
// took letters and handed them to oFono's Dial(). Filtered on input rather
// than on keypress so paste is covered too, which also quietly drops the
// spaces in a pasted "+91 98765 43210". The class must agree with isDialable
// in shared/phone.js, which is what actually refuses a bad number at the IPC
// boundary. Reassigned only when something was removed, so ordinary typing
// never moves the caret.
$('#d-number').addEventListener('input', (e) => {
  const cleaned = e.target.value.replace(/[^0-9+*#]/g, '');
  if (cleaned !== e.target.value) e.target.value = cleaned;
});

$('#d-back').addEventListener('click', () => {
  const el = $('#d-number');
  el.value = el.value.slice(0, -1);
});

$('#d-clear').addEventListener('click', () => { $('#d-number').value = ''; });

$('#d-call').addEventListener('click', async () => {
  // A dial is already going out - silently ignore the extra click rather than
  // scolding the user for double-clicking.
  if (dialPending) return;
  if (!allHeld()) {
    alert('A call is in progress; put it on hold to dial another.');
    return;
  }
  const number = $('#d-number').value.trim();
  if (!number) {
    alert('Enter a number to dial.');
    return;
  }

  dialPending = true;
  updateDialButton();
  try {
    await window.konnect.dial(number);
    // Stay pending until a call event actually arrives - dial() resolving does
    // not mean the call exists. The backstop covers only a dial that resolves
    // and never yields a call event; renderCall cancels it as soon as any call
    // registers, so it can never fire inside a later dial's window.
    if (dialBackstop) clearTimeout(dialBackstop);
    dialBackstop = setTimeout(() => {
      dialBackstop = null;
      clearDialPending();
    }, 10000);
  } catch (e) {
    // Nothing was placed, so another attempt is safe immediately.
    clearDialPending();
    alert(`Could not dial: ${e.message}`);
  }
});

// Failures here must be visible. A silently swallowed hangup leaves the user
// believing the call ended while the microphone is still live.
$('#c-hangup').addEventListener('click', async () => {
  if (!activeCall) return;
  try {
    await window.konnect.hangup(activeCall.id);
  } catch (e) {
    alert(`Could not hang up: ${e.message}\nThe call may still be connected.`);
  }
});
$('#c-answer').addEventListener('click', async () => {
  if (!activeCall) return;
  try {
    await window.konnect.answer(activeCall.id);
  } catch (e) {
    alert(`Could not answer: ${e.message}`);
  }
});

// Failures here must be visible, exactly as for hangup: a swap that silently
// failed leaves the user talking to the wrong caller.
async function callAction(verb, fn) {
  try {
    await fn();
  } catch (e) {
    alert(`Could not ${verb}: ${e.message}`);
  }
}
$('#c-hold').addEventListener('click', () => {
  callAction($('#c-hold').textContent.toLowerCase(), () => window.konnect.swapCalls());
});
$('#c-swap').addEventListener('click', () => callAction('swap', () => window.konnect.swapCalls()));
$('#c-merge').addEventListener('click', () => callAction('merge', () => window.konnect.createMultiparty()));
$('#c-other-answer').addEventListener('click', () => {
  if (otherCall) callAction('answer', () => window.konnect.answer(otherCall.id));
});

// Same rule as hangup: a mute that silently failed leaves the user talking to
// a caller who can hear them, or believing they are audible when they are not.
$('#c-mute').addEventListener('click', async () => {
  const btn = $('#c-mute');
  const next = !micMuted;
  btn.disabled = true;
  try {
    await window.konnect.setMicMute(next);
    micMuted = next;
  } catch (e) {
    alert(`Could not ${next ? 'mute' : 'unmute'} the microphone: ${e.message}`);
  }
  btn.disabled = false;
  paintMute();
});

// Settings has a row for the same microphone, so a mute set there must not
// leave this button saying the opposite.
window.konnect.onMicMute((on) => {
  micMuted = Boolean(on);
  paintMute();
});

// The renderer's view of what is live is a MIRROR, and a reload empties it -
// Electron's default menu binds Ctrl+R, and launching while a call is already
// up loses the adopted-call broadcast, which main sends before this page has
// finished loading. Re-seed from main rather than assuming the line is idle,
// or the call panel stays hidden and Hang up is unreachable during a live
// call. Main independently refuses a dial unless every live call is held, so
// this is the display half of that fix, not the safety half.
(async () => {
  try {
    for (const call of await window.konnect.liveCalls()) renderCall(call);
  } catch (e) {
    console.error('could not re-seed live calls:', e.message);
  }
})();

window.konnect.onCall((call) => {
  // Compute this BEFORE renderCall, which mutates liveCalls.
  const isNewCall =
    call && call.state !== 'disconnected' && !liveCalls.has(call.id);
  renderCall(call);
  // Switch to the dialer only when a call FIRST appears. oFono emits an event
  // per property change - a name resolving mid-call is one - so switching on
  // every event drags the user back here repeatedly while they are trying to
  // read something else.
  if (isNewCall) showView('dialer');
});

// ---- call log -----------------------------------------------------------
function fmtWhen(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function directionLabel(row) {
  if (row.direction === 'in' && !row.started_at) return ['Missed', 'dir-missed'];
  return row.direction === 'in' ? ['Incoming', 'dir-in'] : ['Outgoing', 'dir-out'];
}

function currentRange() {
  const from = $('#f-from').value || null;
  const to = $('#f-to').value || null;
  return { from, to };
}

// listCalls is capped; callStats is not. Without the notice below, a range
// holding more than this many calls shows stat tiles that exceed the visible
// rows, which reads as a rendering bug rather than a page limit.
const CALL_PAGE_LIMIT = 500;

// Only one player is open at a time: several <audio> elements decoding at
// once is noise, and the row that is playing should be unambiguous.
// { td, tr, audio, play } - the strip lives in its own <tr>, so closing it
// means removing a row, not emptying a cell.
let openPlayerRow = null;

const PLAY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
  '<path d="M7 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>';
const STOP_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
  '<rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
const PAUSE_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
  '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const FOLDER_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.6a2 2 0 0 1 1.7.9l1 1.6H20a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2z"/></svg>';

// The Recording column's pill. `open` is the player's state, not the audio's:
// the pill opens and closes the strip, while pausing lives on the strip's own
// button. One button with two meanings, so the accessible name has to move
// with the label - a pill reading "Stop" that still announces "Play
// recording" is worse than no label at all.
function setPlayState(btn, open) {
  btn.innerHTML = `${open ? STOP_ICON : PLAY_ICON}<span>${open ? 'Stop' : 'Play'}</span>`;
  btn.classList.toggle('on', open);
  btn.title = open ? 'Stop and close the player' : 'Play recording';
  btn.setAttribute('aria-label', btn.title);
}

// Tearing the player down in one place: it is reached from a second row's
// Play, from a repeat click on its own, from a dead file, and from the table
// being rebuilt under it.
function closePlayer() {
  if (!openPlayerRow) return;
  const { tr, audio, play } = openPlayerRow;
  audio.pause();
  tr.remove();
  setPlayState(play, false);
  openPlayerRow = null;
}

// Bars in the waveform. Enough to show where speech and silence fall in a
// several-minute call without turning a 32px strip into a grey smear.
const WAVE_BARS = 40;

// One AudioContext for the whole renderer. Browsers cap how many a page may
// hold, and one per recording would exhaust that after a few dozen plays.
// Created lazily so a session that never opens a player never builds one.
let audioCtx = null;
function decodeCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function mmss(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Real peaks, decoded from the file the player is about to play. These
// recordings are tens of kilobytes (Opus, mono, 8kHz from HFP), so pulling
// the whole thing to draw 40 bars costs less than the round trip to ask.
//
// Resolves to nulls rather than rejecting: a waveform is decoration on top of
// a player that must work regardless, and a codec Chromium declines to decode
// must not take the play button down with it.
async function decodePeaks(src) {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = await decodeCtx().decodeAudioData(await res.arrayBuffer());
    return window.Peaks.peaksFrom(buf.getChannelData(0), WAVE_BARS);
  } catch {
    return null;
  }
}

// The expanded player, drawn per artboard 2b: a round play/pause, elapsed
// time, a waveform that doubles as the scrub bar, total time, and reveal.
// Lives in its own <tr> so it can span the table; the native <audio controls>
// it replaces had to fit a 220px cell and looked it.
function playerRow(row, src, onEnded) {
  const tr = document.createElement('tr');
  tr.className = 'player-row';
  const td = document.createElement('td');
  td.colSpan = 6;
  const strip = document.createElement('div');
  strip.className = 'player';

  // Not `controls`: this element is the transport only, the strip is the UI.
  const audio = document.createElement('audio');
  audio.src = src;
  audio.preload = 'metadata';

  const toggle = document.createElement('button');
  toggle.className = 'player-toggle';
  const elapsed = document.createElement('span');
  elapsed.className = 'player-time';
  elapsed.textContent = '00:00';
  const total = document.createElement('span');
  total.className = 'player-time total';
  total.textContent = '--:--';

  const wave = document.createElement('div');
  wave.className = 'wave';
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Seek within the recording');
  const bars = [];
  for (let i = 0; i < WAVE_BARS; i += 1) {
    const bar = document.createElement('i');
    // A floor, so silence is still a bar rather than a gap in the strip.
    bar.style.height = '10%';
    wave.append(bar);
    bars.push(bar);
  }

  const reveal = document.createElement('button');
  reveal.className = 'iconbtn sq';
  reveal.innerHTML = FOLDER_ICON;
  reveal.title = 'Show in folder';
  reveal.setAttribute('aria-label', 'Show in folder');
  reveal.addEventListener('click', () => {
    window.konnect.revealRecording(row.recording_path).catch(() => {});
  });

  function paintProgress() {
    const pct = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    const played = Math.round(pct * WAVE_BARS);
    bars.forEach((bar, i) => bar.classList.toggle('played', i < played));
    elapsed.textContent = mmss(audio.currentTime);
  }

  function setPlaying(on) {
    strip.classList.toggle('playing', on);
    toggle.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
    toggle.title = on ? 'Pause' : 'Play';
    toggle.setAttribute('aria-label', toggle.title);
  }

  toggle.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  });
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('timeupdate', paintProgress);
  // Ogg-Opus reports duration only once metadata has loaded, and Infinity
  // before that - showing it raw would print "Infinity:NaN".
  audio.addEventListener('loadedmetadata', () => { total.textContent = mmss(audio.duration); });
  audio.addEventListener('ended', () => { if (onEnded) onEnded(); });

  // Click anywhere in the waveform to seek there. getBoundingClientRect
  // rather than offsetX: offsetX is relative to whichever BAR was hit, which
  // makes every click land within a fortieth of the start of the track.
  wave.addEventListener('click', (e) => {
    if (!(audio.duration > 0)) return;
    const box = wave.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    audio.currentTime = pct * audio.duration;
    paintProgress();
  });

  setPlaying(false);
  strip.append(toggle, elapsed, wave, total, reveal, audio);
  td.append(strip);
  tr.append(td);

  decodePeaks(src).then((peaks) => {
    if (!peaks) return;   // keep the flat placeholder bars
    peaks.forEach((p, i) => { bars[i].style.height = `${10 + p * 90}%`; });
  });

  return { tr, audio };
}

function recordingCell(row) {
  const td = document.createElement('td');
  if (!row.recording_path) {
    td.textContent = '-';
    return td;
  }

  // A pill, not the round icon button it used to be: artboard 2b labels this
  // column with a word, and a word survives being glanced at across a table
  // of six columns where a 13px glyph does not. The canvas says "Playing"
  // for the active state; this says "Stop", because the pill is a control
  // rather than a status - pressing it ends playback and puts the strip away.
  const play = document.createElement('button');
  play.className = 'pill';
  setPlayState(play, false);

  play.addEventListener('click', () => {
    if (openPlayerRow && openPlayerRow.td !== td) closePlayer();
    if (openPlayerRow && openPlayerRow.td === td) { closePlayer(); return; }

    // basename only: the protocol handler re-validates, but sending the full
    // path would make the renderer the thing that decides what main opens.
    // The name goes in the PATH: Chromium lowercases a custom scheme's host
    // during canonicalization, which would corrupt the uppercase hex in a
    // recording basename before the protocol handler ever ran.
    const src = `konnect-rec://rec/${encodeURIComponent(basename(row.recording_path))}`;
    const { tr, audio } = playerRow(row, src, closePlayer);

    // A recording whose file was deleted must say so rather than render a
    // dead player with no explanation.
    audio.addEventListener('error', () => {
      closePlayer();
      // Replace, don't append: a repeat Play click on the same dead row would
      // otherwise stack a fresh "Recording missing" span each time.
      td.querySelector('.muted')?.remove();
      const gone = document.createElement('span');
      gone.className = 'muted';
      gone.textContent = 'Recording missing';
      td.append(gone);
    }, { once: true });

    td.closest('tr').after(tr);
    openPlayerRow = { td, tr, audio, play };
    setPlayState(play, true);
    audio.play().catch(() => {});
  });

  td.append(play);
  return td;
}

function basename(p) {
  return String(p).split('/').pop();
}

async function renderCalls() {
  const range = currentRange();
  const [rows, stats] = await Promise.all([
    window.konnect.listCalls({ ...range, limit: CALL_PAGE_LIMIT }),
    window.konnect.callStats(range),
  ]);

  $('#call-stats').innerHTML = [
    ['Total', stats.total],
    ['Incoming', stats.in],
    ['Outgoing', stats.out],
    ['Missed', stats.missed],
    ['Talk time', formatDuration(stats.talkTimeSeconds)],
  ].map(([k, v]) => `<div class="card"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

  const body = $('#calls-body');
  // Rebuilding the table detaches the row holding the open player. Without
  // this reset, openPlayerRow keeps a detached <td> reachable: its <audio>
  // can go on playing while every visible button reads "Play", leaving no way
  // to stop it. renderCalls() runs on every persisted call, so this is a
  // routine path, not an edge case.
  closePlayer();
  body.innerHTML = '';
  for (const row of rows) {
    const [label, cls] = directionLabel(row);
    const tr = document.createElement('tr');
    for (const [text, klass] of [
      [label, cls], [row.name || 'Unknown', ''], [row.number_e164, ''],
      [fmtWhen(row.ended_at), ''], [formatDuration(row.duration_s || 0), ''],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (klass) td.className = klass;
      tr.append(td);
    }
    tr.append(recordingCell(row));
    body.append(tr);
  }

  const truncated = stats.total > rows.length;
  $('#calls-truncated').textContent = truncated
    ? `Showing the most recent ${rows.length} of ${stats.total} calls.`
    : '';
  $('#calls-truncated').hidden = !truncated;

  const empty = rows.length === 0;
  if (empty) {
    // A filtered-empty result is NOT an empty history. Showing the first-run
    // explanation when the user has merely narrowed a date range tells them
    // their calls were never captured, which is false.
    const filtered = Boolean(range.from || range.to);
    $('#calls-empty-title').textContent =
      filtered ? 'No calls in this date range.' : 'No calls recorded yet.';
    $('#calls-empty-body').textContent = filtered
      ? 'Clear the filters to see the full call history.'
      : 'History starts when Konnect first runs. Calls made or received while '
        + 'Konnect is closed cannot be recovered - the handset does not share '
        + 'its own call history over Bluetooth.';
  }
  $('#calls-empty').hidden = !empty;
  $('#calls-table').hidden = empty;
}

$('#f-apply').addEventListener('click', renderCalls);
$('#f-clear').addEventListener('click', () => {
  $('#f-from').value = '';
  $('#f-to').value = '';
  renderCalls();
});

// Refresh whenever a call ends, so the log is current without a manual reload.
// Refresh on the PERSIST, not on 'disconnected'. With recording on, the row
// is written only after the encode finishes - seconds later - so refreshing
// on the call event queried before the row existed and left the just-ended
// call missing from the log until something else happened to redraw it.
window.konnect.onCallsChanged(() => { renderCalls(); loadSpeedDial().catch(() => {}); });

// ---- export -------------------------------------------------------------
// One Export control per the canvas. #x-panel.hidden IS the open state - a
// separate boolean would be a second source of truth for the same fact.
function setExportOpen(open) {
  $('#x-panel').hidden = !open;
  $('#x-menu').setAttribute('aria-expanded', String(open));
}
$('#x-menu').addEventListener('click', (e) => {
  // Without this the document listener below sees the same click bubble up
  // and closes the menu the trigger just opened.
  e.stopPropagation();
  setExportOpen($('#x-panel').hidden);
});
// Any other click closes it, an item's included: the export runs on its own
// listener from wireExport, this only puts the chrome away.
document.addEventListener('click', () => setExportOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setExportOpen(false);
});

function wireExport(id, fn) {
  $(id).addEventListener('click', async () => {
    try {
      const out = await fn();
      if (out) alert(`Saved to ${out}`);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  });
}
wireExport('#x-calls', () => window.konnect.exportCallsCsv());
wireExport('#x-report', () => window.konnect.exportReportPdf(currentRange()));
wireExport('#x-contacts', () => window.konnect.exportContactsCsv());
wireExport('#x-vcf', () => window.konnect.exportContactsVcf());

// ---- contacts -----------------------------------------------------------
// The handset cannot be pulled from (PBAP never completes its handshake -
// spec 6), so contacts arrive by the phone pushing them over OBEX Object
// Push. Everything in `c` below came off the handset: names go through
// textContent/createElement only, never innerHTML with interpolation.
let allContacts = [];

const CALL_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2' +
  ' 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0' +
  ' 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3' +
  '-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7a2 2 0 0 1 1.7 2z"/></svg>';

function drawContacts() {
  const q = $('#ct-search').value.trim().toLowerCase();
  const rows = q
    ? allContacts.filter((c) =>
        c.name.toLowerCase().includes(q) || c.number_e164.includes(q))
    : allContacts;

  const body = $('#contacts-body');
  body.innerHTML = '';
  for (const c of rows) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = c.name;
    const num = document.createElement('td');
    num.textContent = c.number_e164;
    const act = document.createElement('td');
    const callBtn = document.createElement('button');
    // Static markup, no interpolation - the contact's name goes in the
    // label attributes via setAttribute, which does not parse HTML.
    callBtn.innerHTML = CALL_ICON;
    callBtn.title = `Call ${c.name}`;
    callBtn.setAttribute('aria-label', `Call ${c.name}`);
    callBtn.addEventListener('click', () => fillDialer(c.number_e164));
    act.append(callBtn);
    tr.append(name, num, act);
    body.append(tr);
  }
  const empty = allContacts.length === 0;
  $('#contacts-empty').hidden = !empty;
  $('#contacts-table').hidden = empty;
}

async function loadContacts() {
  allContacts = await window.konnect.listContacts();
  drawContacts();
}

$('#ct-search').addEventListener('input', drawContacts);

function fillDialer(number) {
  $('#d-number').value = number;
  showView('dialer');
}

// A tel: link opened anywhere on the desktop lands in the dial field, exactly
// as if it had been typed. The Call button is deliberately still the only
// thing that dials.
window.konnect.onDialPrefill(fillDialer);

// ---- speed dial ---------------------------------------------------------
// The most recently dialled DISTINCT numbers, derived from the existing
// calls:list query rather than a new store method - the log already comes
// back ordered by ended_at DESC. The picking rule lives in shared/speeddial.js
// so it can be tested; only the drawing is here.
//
// Enough rows scanned that four distinct outgoing numbers still surface when
// the log is mostly inbound; far below listCalls' 200 default.
const SPEED_DIAL_SCAN = 60;

function drawSpeedDial(rows) {
  const host = $('#speed-dial');
  host.innerHTML = '';
  const picks = window.SpeedDial.recentlyDialled(rows);
  host.hidden = picks.length === 0;

  for (const r of picks) {
    // r.name is the join in listCalls, set only where the call was linked to a
    // contact. Calls logged before an import have no contact_id, so fall back
    // to the contact list the renderer already holds before showing bare digits.
    const name = r.name || allContacts.find((c) => c.number_e164 === r.number_e164)?.name || '';
    const btn = document.createElement('button');
    btn.className = 'sd';
    btn.title = `Call ${name || r.number_e164}`;

    const avatar = document.createElement('span');
    avatar.className = 'sd-avatar';
    avatar.textContent = (name || r.number_e164).replace(/^\+/, '').charAt(0).toUpperCase();
    const label = document.createElement('span');
    label.className = 'sd-label';
    label.textContent = name || r.number_e164;

    btn.append(avatar, label);
    btn.addEventListener('click', () => fillDialer(r.number_e164));
    host.append(btn);
  }
}

async function loadSpeedDial() {
  drawSpeedDial(await window.konnect.listCalls({ limit: SPEED_DIAL_SCAN }));
}


// The button disables BEFORE the await, matching the dialer's d-call guard
// above (Task 8): the IPC round-trip to register the OBEX agent takes long
// enough that a second click landing inside that window would fire a second
// startContactImport() concurrently. Disabling first, not after, closes
// that window instead of narrowing it.
$('#ct-import').addEventListener('click', async () => {
  if ($('#ct-import').disabled) return;
  $('#ct-steps').hidden = false;
  $('#ct-cancel').hidden = false;
  $('#ct-import').disabled = true;
  $('#ct-result').textContent = 'Waiting for the handset to send contacts...';
  try {
    await window.konnect.importContacts();
  } catch (e) {
    // Never dead-end: failing to arm the receiver must not leave the button
    // stuck disabled with no way to retry.
    $('#ct-steps').hidden = true;
    $('#ct-cancel').hidden = true;
    $('#ct-import').disabled = false;
    $('#ct-result').textContent = `Could not start import: ${e.message}`;
  }
});

$('#ct-cancel').addEventListener('click', async () => {
  try {
    await window.konnect.cancelImport();
  } catch (e) {
    $('#ct-result').textContent = `Could not cancel import: ${e.message}`;
    return;
  }
  $('#ct-steps').hidden = true;
  $('#ct-cancel').hidden = true;
  $('#ct-import').disabled = false;
  $('#ct-result').textContent = '';
});

window.konnect.onContacts(({ contacts, result }) => {
  allContacts = contacts;
  drawContacts();
  $('#ct-result').textContent =
    `Imported ${result.added} new and updated ${result.updated} existing contacts.`;
});

// Contacts live in the dialer's side panel now, so nothing navigates to them
// and the nav-click branch above no longer fires. Load once at startup like
// the other bootstraps; drawContacts() also owns showing the empty state, so
// this must run even when the list comes back empty.
loadContacts()
  .catch((e) => {
    console.error('could not load contacts:', e.message);
    drawContacts();
  })
  // After contacts, not in parallel: drawSpeedDial reads allContacts to name
  // its chips, and an empty list there would draw bare numbers.
  .then(loadSpeedDial)
  .catch((e) => console.error('could not load speed dial:', e.message));

// ---- window chrome ------------------------------------------------------
// The window is frameless (the canvas draws its own title bar), so these are
// the only way to minimise, maximise or close it.
$('#win-min').addEventListener('click', () => window.konnect.windowMinimize());
$('#win-max').addEventListener('click', () => window.konnect.windowMaximize());
$('#win-close').addEventListener('click', () => window.konnect.windowClose());

