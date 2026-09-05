'use strict';

// Each section renders independently: one failing subsystem must not blank
// the sections after it. renderSettings() awaits sections in order, so
// without this a rejection in an early section silently prevents every later
// one from rendering at all - the section is left as empty markup with no
// explanation. Sections keep their own try/catch for failures they can name
// specifically (e.g. renderAudio's listAudioDevices() catch below); this is
// only the backstop for what they don't anticipate.
async function renderSection(label, host, render) {
  try {
    await render();
  } catch (err) {
    host.textContent = `${label} unavailable: ${err.message}`;
  }
}

// device_mac is only written when onboarding's Open dialer runs. The backend can
// already be bound to a device resolved from BlueZ at startup before that -
// without the boundMac() fallback, Settings would claim no handset is
// selected while Status reports Connected against the same device.
async function renderDevice() {
  const saved = await window.konnect.getSetting('device_mac');
  const mac = saved || await window.konnect.boundMac();
  const devices = await window.konnect.listDevices().catch(() => []);
  const bound = devices.find((d) => d.mac === mac);
  const name = bound ? bound.name : 'Unknown device';
  $('#set-device').textContent = mac
    ? (saved ? `${name} (${mac})` : `${name} (${mac}) - not saved yet`)
    : 'No handset selected';
  // Only a SAVED mac can be forgotten. A mac the backend merely resolved at
  // startup was never persisted, so there is nothing to clear.
  $('#set-forget-device').disabled = !saved;
  // Both optional, both from the status object the title bar already reads.
  // The F120B reports no subscriber number (spec 2026-09-05 §2), so that row
  // stays hidden there; PnP is present for any paired handset.
  const status = await window.konnect.getStatus().catch(() => null);
  const numbers = Array.isArray(status?.numbers) ? status.numbers : [];
  const numRow = $('#set-device-number');
  numRow.textContent = numbers.length ? `Number: ${numbers.join(', ')}` : '';
  numRow.hidden = numbers.length === 0;
  const pnpRow = $('#set-device-pnp');
  pnpRow.textContent = window.Modalias.describePnp(status?.pnp);
  pnpRow.hidden = !status?.pnp;
}

// Bumped at the top of every renderSettings() call, the same render-token
// pattern onboarding.js uses. callvolume:changed can fire several times in
// quick succession (holding a volume key on the handset), and each one
// re-runs this whole page; without this, two passes interleave their
// awaits and duplicate every section's DOM.
let settingsRenderToken = 0;

// Populated task by task: audio devices, volume, ringtone and startup each
// own one section.
async function renderSettings() {
  const token = ++settingsRenderToken;
  await renderSection('Device', $('#set-device'), renderDevice);
  if (token !== settingsRenderToken) return; // a newer render superseded this one
  await renderSection('Audio devices', $('#set-audio'), renderAudio);
  if (token !== settingsRenderToken) return;
  await renderSection('Call volume', $('#set-volume'), () => renderCallVolume($('#set-volume')));
  if (token !== settingsRenderToken) return;
  await renderSection('Ringtone', $('#set-ring'), renderRing);
  if (token !== settingsRenderToken) return;
  await renderSection('Appearance', $('#set-theme'), renderAppearance);
  if (token !== settingsRenderToken) return;
  await renderSection('Startup', $('#set-startup'), renderStartup);
  if (token !== settingsRenderToken) return;
  await renderSection('Google account', $('#set-google'), renderGoogle);
}

$('#set-change-device').addEventListener('click', () => openOnboarding({ blocking: false }));

// Unpairs the handset and clears Konnect's binding, then restarts into
// onboarding. Main asks for confirmation first and answers relaunching:false
// on a cancel, which is the same shape as "there was nothing bound".
$('#set-forget-device').addEventListener('click', async () => {
  const btn = $('#set-forget-device');
  btn.disabled = true;
  let res;
  try {
    res = await window.konnect.forgetDevice();
  } catch (err) {
    // Refused while a call is live. Never dead-end: say why and re-enable.
    btn.disabled = false;
    $('#set-device').textContent = err.message;
    return;
  }
  // relaunching:false means there was nothing bound to forget.
  if (!res.relaunching) { btn.disabled = false; return; }
  // The unpair is best-effort in main, so say so rather than letting the user
  // find the handset still paired in the system's Bluetooth settings.
  btn.textContent = res.unpairError ? 'Restarting (still paired)\u2026' : 'Restarting\u2026';
});

// Shared by the audio and ringtone sections.
function deviceSelect(id, nodes, selected) {
  const sel = document.createElement('select');
  sel.id = id;
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'System default';
  sel.append(none);
  for (const n of nodes) {
    const opt = document.createElement('option');
    opt.value = n.name;
    // textContent, not innerHTML: these strings come from the sound system.
    opt.textContent = n.description;
    if (n.name === selected) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

// Its own render token, separate from settingsRenderToken above: this
// function is re-entered directly from three unawaited change handlers
// (the output and input selects), not only via renderSettings().
let audioRenderToken = 0;

const MIC_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
  '<path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
const SPEAKER_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 5 6 9H3v6h3l5 4zM16 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10"/></svg>';

// One card per device, the way the canvas's Audio artboard draws it: icon,
// what the device is for, its picker, and its level. The level slider used to
// live in a separate "On this PC" group under Volume, which forced the note
// "choose a device above to control its level" - a cross-reference the card
// removes by putting the picker and the level it controls in one box.
async function deviceCard({ icon, title, sub, selectId, nodes, selected, onPick }) {
  const card = document.createElement('div');
  card.className = 'devcard';

  const head = document.createElement('div');
  head.className = 'devcard-head';
  const glyph = document.createElement('span');
  glyph.className = 'devcard-icon';
  glyph.innerHTML = icon; // a module constant, never interpolated
  const name = document.createElement('span');
  name.textContent = title;
  head.append(glyph, name);

  const caption = document.createElement('p');
  caption.className = 'devcard-sub';
  caption.textContent = sub;

  const sel = deviceSelect(selectId, nodes, selected);
  sel.addEventListener('change', () => onPick(sel.value));
  card.append(head, caption, sel);

  // Nothing is selected means there is no node to read a level from. A
  // disabled slider parked at 0 would read as "muted", so say why instead -
  // the same distinction volumeSlider's disabled case exists to protect.
  if (!selected) {
    const why = document.createElement('p');
    why.className = 'devcard-sub';
    why.textContent = 'Pick a device to control its level.';
    card.append(why);
    return card;
  }

  const current = await window.konnect.getPcVolume(selected).catch(() => null);
  const pct = current ? current.pct : null;
  card.append(volumeSlider({
    label: 'Level', value: pct, disabled: pct == null,
    onChange: (v) => window.konnect.setPcVolume(selected, v),
  }));
  return card;
}

async function renderAudio() {
  const token = ++audioRenderToken;
  const host = $('#set-audio');
  host.replaceChildren();

  let devices;
  try {
    devices = await window.konnect.listAudioDevices();
  } catch (err) {
    if (token !== audioRenderToken) return; // a newer render superseded this one
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Audio devices unavailable: ${err.message}`;
    host.append(p);
    return;
  }
  if (token !== audioRenderToken) return;

  const [sink, source] = await Promise.all([
    window.konnect.getSetting('audio_sink'),
    window.konnect.getSetting('audio_source'),
  ]);
  if (token !== audioRenderToken) return;

  // Picking a device IS the opt-in to Konnect-owned routing, and picking
  // "System default" in both cards is the way back out - the backend routes
  // whenever either is named. There is no mode setting to keep in step.
  const pick = (key) => async (value) => {
    await window.konnect.setSetting(key, value);
    // Nothing else clears a stale #s-route warning left over from a call that
    // routed badly, and going back to system defaults means it can no longer
    // be true - the same job the old "Follow system defaults" radio did.
    const other = key === 'audio_sink' ? 'audio_source' : 'audio_sink';
    if (!value && !(await window.konnect.getSetting(other))) {
      const banner = $('#s-route');
      if (banner) { banner.textContent = ''; banner.hidden = true; }
    }
    renderAudio();
  };

  const cards = document.createElement('div');
  cards.className = 'devcards';
  cards.append(
    await deviceCard({
      icon: MIC_ICON, title: 'Microphone', sub: 'What the caller hears',
      selectId: 'set-source', nodes: devices.sources, selected: source,
      onPick: pick('audio_source'),
    }),
    await deviceCard({
      icon: SPEAKER_ICON, title: 'Speaker', sub: 'Where call audio plays',
      selectId: 'set-sink', nodes: devices.sinks, selected: sink,
      onPick: pick('audio_sink'),
    }),
  );
  // deviceCard awaits a level read per card, so re-check before painting.
  if (token !== audioRenderToken) return;

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent =
    'Routing is applied when a call starts — the call audio devices do not '
    + 'exist until then, so this cannot be fully tested while the line is idle.';

  const status = document.createElement('p');
  status.id = 'set-audio-status';
  status.className = 'muted';
  status.textContent = 'Link status: idle (call audio devices appear only during a call)';

  const testBtn = document.createElement('button');
  testBtn.textContent = 'Test routing';
  testBtn.addEventListener('click', async () => {
    const d = await window.konnect.listAudioDevices();
    // By id, not by closure: the cards are rebuilt on every device change, so
    // a captured <select> can be a detached one - the same reason
    // #set-audio-status is looked up by id in the onRouting handler below.
    const wantSink = $('#set-sink') ? $('#set-sink').value : '';
    const wantSource = $('#set-source') ? $('#set-source').value : '';
    const okSink = !wantSink || d.sinks.some((n) => n.name === wantSink);
    const okSource = !wantSource || d.sources.some((n) => n.name === wantSource);
    // Deliberately modest wording. Nothing here proves the links will attach,
    // because the ports to attach to do not exist until a call is up.
    //
    // The spec listed a separate `audio:test` IPC channel for this. It is not
    // needed: everything the check can honestly assert is already in the
    // `audio:devices` response, and a dedicated channel would only wrap it.
    status.textContent = okSink && okSource
      ? 'Both selected devices are present. Links can only be verified during a call.'
      : `Missing device: ${!okSink ? 'output' : ''}${!okSink && !okSource ? ' and ' : ''}${!okSource ? 'microphone' : ''}`;
  });

  host.append(cards, note, status, testBtn);
}

// The preview button's stopRing() timeout below must not silence a REAL
// incoming ring that starts inside its 5s window - tracked here so an
// incoming call can cancel the pending stop instead of cutting it short.
let ringTestTimer = null;

const PREVIEW_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
  '<path d="M7 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>';

async function renderRing() {
  const host = $('#set-ring');
  host.replaceChildren();

  const enabled = (await window.konnect.getSetting('ring_enabled')) !== 'false';
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = enabled;
  box.addEventListener('change', async () => {
    await window.konnect.setSetting('ring_enabled', box.checked ? 'true' : 'false');
  });
  const text = document.createElement('span');
  text.textContent = ' Ring on this PC for incoming calls';
  label.append(box, text);

  const devices = await window.konnect.listAudioDevices().catch(() => ({ sinks: [] }));
  const ringSink = await window.konnect.getSetting('ring_sink');
  const sinkLabel = document.createElement('label');
  sinkLabel.textContent = 'Ring through ';
  const sel = deviceSelect('set-ring-sink', devices.sinks, ringSink);
  sel.addEventListener('change', () => window.konnect.setSetting('ring_sink', sel.value));
  sinkLabel.append(sel);

  const tone = await window.konnect.getSetting('ring_tone');
  const toneRow = document.createElement('div');
  toneRow.className = 'row';
  const toneName = document.createElement('span');
  toneName.className = 'grow';
  toneName.textContent = 'Ringtone';
  const toneFile = document.createElement('span');
  toneFile.className = 'sub';
  toneFile.textContent = !tone || tone === 'bundled'
    ? 'Konnect default'
    : tone.split('/').pop();
  toneName.append(toneFile);

  // The canvas puts the preview inside the tone row rather than leaving a
  // stray [Test] button on a line of its own below the section.
  const preview = document.createElement('button');
  preview.className = 'iconbtn';
  preview.innerHTML = PREVIEW_ICON;
  preview.title = 'Preview ringtone';
  preview.setAttribute('aria-label', 'Preview ringtone');
  preview.addEventListener('click', async () => {
    await window.konnect.testRing();
    if (ringTestTimer) clearTimeout(ringTestTimer);
    ringTestTimer = setTimeout(() => {
      ringTestTimer = null;
      window.konnect.stopRing();
    }, 5000);
  });

  const choose = document.createElement('button');
  choose.textContent = 'Choose file';
  choose.addEventListener('click', async () => {
    const picked = await window.konnect.chooseRingtone();
    if (picked) renderRing();
  });
  const reset = document.createElement('button');
  reset.textContent = 'Use default';
  reset.addEventListener('click', async () => {
    await window.konnect.setSetting('ring_tone', 'bundled');
    renderRing();
  });
  toneRow.append(toneName, preview, choose, reset);

  host.append(label, toneRow, sinkLabel);
}

// The autostart FILE is the single source of truth (see src/main/autostart.js)
// - there is no settings-db key to keep in sync, so this just asks main what
// is actually on disk every time the section renders.
// The three values are Electron's themeSource verbatim - main hands them
// straight to nativeTheme, which drives prefers-color-scheme in every window.
// The light palette itself is already in styles.css (and, separately, in
// incoming.html); nothing here picks colours, it only chooses which of the
// two token sets applies.
async function renderAppearance() {
  const host = $('#set-theme');
  host.replaceChildren();
  const current = (await window.konnect.getSetting('theme')) || 'system';
  const row = document.createElement('div');
  row.className = 'radio-row';
  for (const [value, label] of [
    ['system', 'Match my system'], ['light', 'Light'], ['dark', 'Dark'],
  ]) {
    const l = document.createElement('label');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'theme';
    r.value = value;
    r.checked = current === value;
    // No re-render: the window repaints itself off prefers-color-scheme the
    // moment main applies it, and re-rendering here would only fight that.
    r.addEventListener('change', () => window.konnect.setSetting('theme', value));
    const s = document.createElement('span');
    s.textContent = ` ${label} `;
    l.append(r, s);
    row.append(l);
  }
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Applies to the call window and the incoming-call popup too.';
  host.append(row, note);
}

async function renderStartup() {
  const host = $('#set-startup');
  host.replaceChildren();
  let enabled;
  try {
    enabled = await window.konnect.getAutostart();
  } catch (err) {
    // The section has already been cleared at this point, so returning
    // silently would leave an empty box with no explanation anywhere.
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Startup setting unavailable: ${err.message}`;
    host.append(p);
    return;
  }
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = enabled;
  box.addEventListener('change', async () => {
    const wanted = box.checked;
    try {
      box.checked = await window.konnect.setAutostart(wanted);
    } catch (err) {
      box.checked = !wanted;
      alert(`Could not change the startup setting: ${err.message}`);
    }
  });
  const text = document.createElement('span');
  text.textContent = ' Start Konnect when I log in';
  label.append(box, text);
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent =
    'Konnect starts minimised to the tray. If your desktop has no tray, the '
    + 'window opens normally instead.';
  host.append(label, note);
}

// Re-entered directly from the sign-in/out button handlers below (unlike
// Sync/Backup, neither google:sign-in nor google:sign-out broadcasts
// google:changed - see the onGoogleChanged subscription further down), as
// well as indirectly through renderSettings() on every google:changed
// broadcast. Same hazard audioRenderToken documents above: two overlapping
// calls would interleave their awaits and duplicate this section's DOM
// instead of one cleanly replacing the other.
let googleRenderToken = 0;

// Google's four-colour G, as their sign-in branding requires. Fixed fills, not
// currentColor: the mark is theirs and does not take our theme.
const GOOGLE_ICON =
  '<svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">' +
  '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06' +
  ' 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>' +
  '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49' +
  ' 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
  '<path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34' +
  'C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>' +
  '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2' +
  ' 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/></svg>';

function googleMark() {
  const mark = document.createElement('span');
  mark.className = 'gmark';
  mark.innerHTML = GOOGLE_ICON; // a module constant, never interpolated
  return mark;
}

// Every state this section can be in is a sentence the user can act on:
// unconfigured, signed out, signed in, or signed in with something wrong.
async function renderGoogle() {
  const token = ++googleRenderToken;
  const host = $('#set-google');
  host.replaceChildren();
  const s = await window.konnect.googleStatus();
  if (token !== googleRenderToken) return; // a newer render superseded this one

  if (!s.configured) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Google integration is not configured. Set GOOGLE_CLIENT_ID in the '
      + 'environment, or create ~/.config/konnect/google.json, then restart Konnect.';
    host.append(p);
    return;
  }

  if (!s.signedIn) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Sign in to sync your Google contacts and back up your call log to '
      + 'Google Drive. Konnect never changes your Google contacts. You can use every '
      + 'part of the app without signing in.';
    const btn = document.createElement('button');
    btn.className = 'gbtn';
    // The label is its own node so the progress and error states can rewrite
    // the text without taking the mark down with it.
    const label = document.createElement('span');
    label.textContent = 'Sign in with Google';
    btn.append(googleMark(), label);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      label.textContent = 'Waiting for your browser…';
      try {
        await window.konnect.googleSignIn();
      } catch (err) {
        // Never dead-end: say what went wrong and let them try again. No
        // re-render here - renderGoogle() would fetch a fresh status object
        // that knows nothing of this client-side error and wipe this
        // paragraph before it was ever shown.
        btn.disabled = false;
        label.textContent = 'Sign in with Google';
        p.textContent = err.message;
        return;
      }
      // Succeeded; re-render explicitly since google:sign-in fires no
      // google:changed broadcast (context note 5, task 9's report).
      await renderGoogle();
    });
    host.append(p, btn);
    return;
  }

  const account = document.createElement('p');
  account.className = 'gaccount';
  const who = document.createElement('span');
  who.textContent = s.email || 'Signed in';
  account.append(googleMark(), who);

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  const times = document.createElement('p');
  times.className = 'muted';
  times.textContent = `Contacts synced ${when(s.contactsSyncedAt)} · `
    + `Backed up ${when(s.backupAt)}`;
  host.append(account, times);

  // safeStorage degrades silently to a hardcoded key (or to nothing at all)
  // when no keyring is present. Saying so is the point - a quiet downgrade
  // is worse than none.
  if (s.weakEncryption || s.sessionOnly) {
    const warn = document.createElement('p');
    warn.className = 'muted';
    warn.textContent = s.sessionOnly
      ? 'No system keyring is available, so you are signed in for this session only.'
      : 'No system keyring is available; the saved sign-in is obfuscated, not encrypted.';
    host.append(warn);
  }

  if (s.lastError) {
    const err = document.createElement('p');
    err.className = 'muted';
    err.textContent = `Last attempt failed: ${s.lastError}`;
    host.append(err);
  }

  // Off by default and never flipped for the user: call audio is the most
  // sensitive data this app holds.
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 's-google-recordings';
  box.checked = s.backupRecordings;
  const text = document.createElement('span');
  text.className = 'grow';
  text.textContent = 'Back up call recordings too';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = 'Uploads recorded call audio to your Drive folder. Turning this off '
    + 'stops new uploads; it does not delete what is already in Drive.';
  text.append(sub);
  box.addEventListener('change', async () => {
    await window.konnect.setSetting('google_backup_recordings', String(box.checked));
    if (box.checked) await window.konnect.googleBackupNow();
  });
  label.append(box, text);

  const row = document.createElement('div');
  row.className = 'row';
  // Sync/Backup need no explicit re-render on success: their IPC wrappers in
  // main/index.js broadcast google:changed themselves (Sync only on success;
  // Backup unconditionally, since runNow() never rejects), which reaches
  // this section through the onGoogleChanged subscription below. Only the
  // failure path is handled here, because a failed sync throws without ever
  // touching google_last_error (contacts.js's contract, task 9's report) -
  // this paragraph is the only place that failure is ever shown, so a
  // re-render on this path (which would fetch a fresh, error-less status)
  // must not happen.
  const action = (caption, run) => {
    const b = document.createElement('button');
    b.textContent = caption;
    b.addEventListener('click', async () => {
      const original = b.textContent;
      b.disabled = true;
      b.textContent = 'Working…';
      try {
        await run();
      } catch (err) {
        b.disabled = false;
        b.textContent = original;
        times.textContent = err.message;
        return;
      }
      b.disabled = false;
      b.textContent = original;
    });
    return b;
  };

  const signOut = document.createElement('button');
  signOut.textContent = 'Sign out';
  signOut.className = 'danger';
  signOut.addEventListener('click', async () => {
    signOut.disabled = true;
    let res;
    try {
      res = await window.konnect.googleSignOut();
    } catch (err) {
      signOut.disabled = false;
      times.textContent = err.message;
      return;
    }
    // google:sign-out fires no google:changed broadcast, so re-render
    // explicitly. That swaps this whole section to the signed-out view, so
    // the confirmation of what sign-out did is appended to THAT view below -
    // writing it onto `times` here would be pointless, that paragraph is
    // gone the instant the render replaces it.
    await renderGoogle();
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `Signed out. ${res.removedContacts} Google contact(s) removed `
      + 'from Konnect; anything already in Drive was kept.';
    host.append(note);
  });

  row.append(
    action('Sync contacts now', () => window.konnect.googleSyncContacts()),
    action('Back up now', () => window.konnect.googleBackupNow()),
    signOut);

  host.append(label, row);
}

// Shared by the handset's call volume and by each audio device card.
function volumeSlider({ label, value, disabled, onChange }) {
  const row = document.createElement('label');
  row.className = 'vol-row';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.value = String(value ?? 0);
  input.disabled = Boolean(disabled);
  const read = document.createElement('span');
  read.className = 'vol-read';
  read.textContent = value == null ? '-' : String(value);
  // The track's filled portion is a gradient stop at --pct (see styles.css);
  // min/max are 0/100 above, so the value IS the percentage.
  const paint = () => input.style.setProperty('--pct', `${input.value}%`);
  paint();
  // 'input' fires while dragging, 'change' only on release - so the fill and
  // the readout follow the thumb, and only the commit below hits the device.
  input.addEventListener('input', () => {
    read.textContent = input.value;
    paint();
  });
  input.addEventListener('change', async () => {
    const wanted = Number(input.value);
    read.textContent = String(wanted);
    try {
      await onChange(wanted);
    } catch (err) {
      alert(`Could not set the volume: ${err.message}`);
    }
  });
  row.append(name, input, read);
  return row;
}

// The handset's own HFP call volume - what the person on the other end of a
// call hears, and how loud they sound in the microphone. Distinct from the
// device cards in renderAudio, which set THIS PC's sink and source levels;
// this one writes org.ofono.CallVolume on the handset itself.
async function renderCallVolume(host) {
  host.replaceChildren();
  const group = document.createElement('div');

  const v = await window.konnect.getCallVolume().catch((err) => ({ error: err.message }));
  if (v.error) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Handset volume unavailable: ${v.error}`;
    group.append(p);
    host.append(group);
    return;
  }

  // disabled when value is null: a slider that failed to read must not look
  // like a slider that reads zero, thumb parked at 0 and still draggable.
  group.append(volumeSlider({
    label: 'Earpiece', value: v.speaker, disabled: v.speaker == null,
    onChange: (n) => window.konnect.setCallVolume({ speaker: n }),
  }));
  group.append(volumeSlider({
    label: 'Microphone', value: v.microphone, disabled: v.microphone == null,
    onChange: (n) => window.konnect.setCallVolume({ microphone: n }),
  }));

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Changes what your caller hears. The handset may refuse these while no call is active.';
  group.append(note);

  // Mute is NOT one of the sliders above. Those write the handset's own
  // org.ofono.CallVolume; Muted on that interface answers "Implementation not
  // provided" on the JioPhone, and it would be the wrong end anyway - under
  // HFP the caller hears this PC's capture node. So this row mutes that,
  // through the same IPC the dialer's in-call button uses.
  const muted = await window.konnect.getMicMute().catch(() => null);
  const muteLabel = document.createElement('label');
  const mute = document.createElement('input');
  mute.type = 'checkbox';
  mute.checked = muted === true;
  // Unreadable is not unmuted - do not offer a switch whose position is a guess.
  mute.disabled = muted === null;
  mute.addEventListener('change', async () => {
    try {
      await window.konnect.setMicMute(mute.checked);
    } catch (err) {
      mute.checked = !mute.checked;
      alert(`Could not change mute: ${err.message}`);
    }
  });
  const muteText = document.createElement('span');
  muteText.textContent = muted === null
    ? ' Mute microphone (unavailable)'
    : ' Mute this PC\u2019s microphone';
  muteLabel.append(mute, muteText);
  group.append(muteLabel);
  host.append(group);
}

// The handset pushes its own volume changes back; re-render only while the
// Settings view is actually on screen.
window.konnect.onCallVolume(() => {
  if ($('#view-settings').classList.contains('active')) renderSettings();
});

// Startup sync/backup finish after the page has already rendered, and Sync
// Now / Back up Now's own success paths rely on this too (see the comment
// above the `action` helper in renderGoogle): both broadcast google:changed
// on completion, this is the only place that reaches the renderer.
window.konnect.onGoogleChanged(() => renderSettings());

// Registered ONCE at module scope, not inside renderAudio(): that function
// re-runs on every mode/device change (three separate handlers call it), and
// preload exposes no unsubscribe, so a per-render registration accumulates
// one stale listener - closed over a detached <p> - per render. Looking the
// element up by id each time means this always writes to whichever status
// paragraph is actually live, or does nothing when Settings/Audio isn't on
// screen at all.
window.konnect.onRouting((r) => {
  const status = $('#set-audio-status');
  if (!status) return;
  status.textContent = `Link status: remote ${r.remoteLinked ? 'OK' : 'not linked'}`
    + ` · mic ${r.micLinked ? 'OK' : 'not linked'}`
    + (r.reason ? ` · ${r.reason}` : '');
});

// A real incoming call can start ringing inside the preview's 5s window;
// the pending stopRing() must not cut that ring short. There is no way to
// tell "still the test ring" from here, so any incoming call disqualifies
// the pending stop.
window.konnect.onCall((call) => {
  if (call && call.state === 'incoming' && ringTestTimer) {
    clearTimeout(ringTestTimer);
    ringTestTimer = null;
  }
});
