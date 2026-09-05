'use strict';
const {
  ipcMain, dialog, shell, app, BrowserWindow, nativeTheme,
} = require('electron');
const { runChecks, remediate } = require('./setup');
const {
  callsToCsv, contactsToCsv, contactsToVcf, reportHtml, writeReportPdf,
} = require('./export');
const { resolveRecordingPath } = require('./recordings');
const { isValidMac } = require('./backend/linux/bus');
const autostart = require('./autostart');
const { isDialable } = require('../shared/phone');
const { promisify } = require('node:util');
const { exec: execCb } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// The light palette already lives in styles.css and incoming.html behind a
// prefers-color-scheme query, so the theme setting only has to steer that
// query. themeSource does exactly that across every renderer, which is why
// the popup - a separate window with its own copy of the tokens - follows
// along for free. Anything other than these three values makes Electron
// throw, so an unrecognised stored value falls back to 'system' rather than
// killing startup.
const applyTheme = (value) => {
  nativeTheme.themeSource = value === 'light' || value === 'dark' ? value : 'system';
};

const execAsync = promisify(execCb);
const exec = (cmd) => execAsync(cmd, { timeout: 120000 });
const writeFile = async (p, body) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
};

// One place where every renderer-reachable capability is declared. Adding a
// channel anywhere else is a bug: the preload allowlist mirrors this list.
function registerIpc({
  backend, store, broadcast, hasLiveCall = () => false, liveCalls = () => [],
  // Fails closed: a caller that forgets to wire the guard cannot dial at all.
  canDial = () => false,
  getMac = () => null, selectDevice = async () => ({ relaunching: false }),
  forgetDevice = async () => ({ relaunching: false }),
  ringSettings = () => ({}),
  dismissIncoming = () => {},
  google = null, syncGoogleContacts = async () => {}, backupNow = async () => {},
  signInGoogle = async () => {},
}) {
  // backend.audio is Linux-only by design; PipeWire has no Windows equivalent.
  const needAudio = () => {
    if (!backend.audio) throw new Error('Audio control is not available on this platform');
    return backend.audio;
  };

  // backend.adapter is Linux-only by design; Windows has no adapter namespace.
  const requireAdapter = () => {
    if (!backend.adapter) throw new Error('Bluetooth pairing is not available on this platform');
    return backend.adapter;
  };

  const requireGoogle = () => {
    if (!google?.status().configured) {
      throw new Error('Google integration is not configured');
    }
    return google;
  };

  const handlers = {
    'status:get': () => backend.getStatus(),
    'app:version': () => app.getVersion(),
    'devices:list': () => backend.listDevices(),
    'devices:connect': (_e, mac) => backend.connect(mac),
    'devices:disconnect': () => backend.disconnect(),
    // Persisting the choice and deciding whether to relaunch belongs to main,
    // not the renderer: the renderer cannot restart the process, and a
    // renderer that wrote device_mac directly could leave the running backend
    // bound to a different handset than the setting claims.
    'device:select': (_e, mac) => selectDevice(mac),
    // Unpairs the handset from BlueZ and clears device_mac, so the app
    // restarts into onboarding with no bond left to fall back to.
    // Guarded because the relaunch would drop a live call and orphan its
    // recording - the check must precede the call, not report after it, and
    // it precedes the dialog too: no point asking a question whose answer is
    // already refused.
    // Confirmed HERE rather than in the renderer, for the same reason the
    // live-call guard is here: this drops the BlueZ bond, and a stray click
    // costs the user a passkey round trip on the handset itself. Renderer
    // state does not survive a reload; this does.
    'device:forget': async () => {
      if (hasLiveCall()) throw new Error('Cannot forget the handset while a call is in progress');
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Forget', 'Cancel'],
        defaultId: 1,   // Cancel, so Return does not unpair
        cancelId: 1,
        message: 'Forget this handset?',
        detail: 'Konnect will unpair it from Bluetooth. You will need to pair it '
          + 'again from the phone before you can use it.',
      });
      // relaunching:false is what Settings already reads as "nothing
      // happened, re-enable the button", so a cancel needs no new branch.
      if (response !== 0) return { relaunching: false };
      return forgetDevice();
    },
    // The wizard checks a handset the user has SELECTED but not yet bound, so
    // the mac must travel with the request. Defaulting to getMac() keeps the
    // Setup view (which checks the bound device) working unchanged. One
    // channel, two callers, two different correct answers.
    'device:verify': (_e, mac) => backend.verifyLink(mac || getMac()),
    // device_mac is only persisted when the wizard finishes, but the backend
    // may already be bound to a device resolved from BlueZ at startup. Without
    // this, Settings reports no handset while Status reports Connected.
    'device:bound-mac': () => getMac(),
    // The dialer's re-entrancy guard used to live only in the renderer
    // (dialPending + liveCalls). That is renderer state, and nothing sets the
    // default Electron menu, so Ctrl+R is bound to Reload: reloading during a
    // call wipes the guard, re-enables the Call button, and the next press
    // places a SECOND REAL CALL - it rings someone and costs money. Launching
    // the app while a call is already in progress loses the same state, since
    // the adopted-call broadcast is sent before the window finishes loading.
    // Main holds the authoritative set, so the guard belongs here.
    'call:dial': (_e, number) => {
      // "Add call" is hold-then-dial (spec 2026-09-05 §5): refused unless
      // every live call is held, so the money-safety property this guard
      // exists for survives a second call.
      if (!canDial()) throw new Error('a call is in progress; put it on hold to dial another');
      // The dial field filters itself as you type, but that is a convenience
      // and this is the boundary: the channel outlives any renderer reload,
      // and every dial path in the app - keypad, speed dial, call log, a
      // tel: link - converges here. Without it the field's contents reached
      // oFono's Dial() verbatim, letters included.
      if (!isDialable(number)) throw new Error(`not a number Konnect can dial: ${number}`);
      return backend.dial(number);
    },
    // Lets a freshly loaded renderer re-seed itself instead of believing the
    // line is idle.
    'calls:live': () => liveCalls(),
    'call:answer': (_e, id) => backend.answer(id),
    'call:hangup': (_e, id) => backend.hangup(id),
    'call:dtmf': (_e, digits) => backend.sendDtmf(digits),
    // CHLD=2 and CHLD=3. Which of hold/resume/swap a swap means is decided by
    // what is live, and the renderer already knows that; main does not need
    // a separate channel per meaning.
    'call:swap': () => backend.swapCalls(),
    'call:merge': () => backend.createMultiparty(),
    'setup:check': (_e, mac) => runChecks({ exec, mac: mac || getMac() }),
    'setup:remediate': (_e, id, mac) => remediate(id, { exec, writeFile, mac: mac || getMac() }),
    'calls:list': (_e, opts) => store.listCalls(opts || {}),
    'calls:stats': (_e, opts) => store.callStats(opts || {}),
    'contacts:list': () => store.listContacts(),
    'contacts:import': () => backend.startContactImport(),
    'contacts:cancelImport': () => backend.cancelContactImport(),
    'settings:get': (_e, key) => store.getSetting(key),
    // Theme is special-cased here rather than given a channel of its own:
    // nativeTheme is main-process-only, so a renderer writing the setting
    // cannot apply it, and the write is the only moment it changes.
    'settings:set': (_e, key, value) => {
      store.setSetting(key, value);
      if (key === 'theme') applyTheme(value);
    },
    'audio:devices': () => needAudio().listAudioDevices(),
    'volume:pc:get': (_e, nodeName) => needAudio().getPcVolume(nodeName),
    'volume:pc:set': (_e, nodeName, pct) => needAudio().setPcVolume(nodeName, pct),
    'volume:call:get': () => backend.getCallVolume(),
    'volume:call:set': (_e, patch) => backend.setCallVolume(patch),
    // The node comes from the SETTING, never from the renderer: the routing
    // that decides which source carries the call is main's to know, and a
    // renderer passing a stale node name would mute a microphone nobody is
    // speaking into. Empty setting means PipeWire's default source.
    'mic:mute-get': () => needAudio().getMicMute(store.getSetting('audio_source')),
    // Broadcast, because the dialer's in-call button and the Settings row are
    // two views of one microphone: without this, muting in one leaves the
    // other saying the opposite. Nothing pushes this from below - wpctl has no
    // event - so the write is the only place it can come from.
    'mic:mute-set': async (_e, on) => {
      await needAudio().setMicMute(store.getSetting('audio_source'), Boolean(on));
      broadcast('micmute:changed', Boolean(on));
      return true;
    },
    'ring:test': () => { needAudio().startRing(ringSettings()); return true; },
    'ring:stop': () => { needAudio().stopRing(); return true; },
    // Deliberately NOT hangup: the popup's close button silences the ring and
    // takes the window away, leaving the call ringing on the handset. Owned by
    // main because the window and the ring are main's state, not the popup's.
    'incoming:dismiss': () => { dismissIncoming(); return true; },
    // Custom tones need a file picker: ringSettings() reads ring_tone and
    // nothing else would ever write it.
    'ring:choose': async () => {
      const { filePaths } = await dialog.showOpenDialog({
        title: 'Choose a ringtone',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['ogg', 'wav', 'flac', 'opus', 'mp3'] }],
      });
      if (!filePaths || !filePaths[0]) return null;
      // pw-play uses libsndfile; an unplayable file would fail silently at
      // ring time, which is the one moment the user cannot investigate it.
      store.setSetting('ring_tone', filePaths[0]);
      return filePaths[0];
    },
    // Reveal, not open: showItemInFolder selects the file in the file manager
    // rather than handing it to whatever application claims .opus, which on a
    // bare system is nothing at all.
    // Validated exactly as the protocol handler validates, even though the
    // value comes from our own database: two doors into the same directory
    // should not have different locks.
    'recording:reveal': (_e, filePath) => {
      shell.showItemInFolder(resolveRecordingPath(path.basename(String(filePath))));
      return true;
    },
    'export:calls-csv': async () => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-calls.csv' });
      if (!filePath) return null;
      await writeFile(filePath, callsToCsv(store.listCalls({ limit: 100000 })));
      return filePath;
    },
    'export:contacts-csv': async () => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-contacts.csv' });
      if (!filePath) return null;
      await writeFile(filePath, contactsToCsv(store.listContacts()));
      return filePath;
    },
    'export:contacts-vcf': async () => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-contacts.vcf' });
      if (!filePath) return null;
      await writeFile(filePath, contactsToVcf(store.listContacts()));
      return filePath;
    },
    'export:report-pdf': async (_e, range) => {
      const { filePath } = await dialog.showSaveDialog({ defaultPath: 'konnect-report.pdf' });
      if (!filePath) return null;
      const opts = range || {};
      const html = reportHtml({
        stats: store.callStats(opts),
        rows: store.listCalls({ ...opts, limit: 1000 }),
        range: { from: opts.from || null, to: opts.to || null },
      });
      return writeReportPdf({ html, outPath: filePath });
    },
    'autostart:get': () => autostart.isEnabled(),
    'autostart:set': async (_e, on) => {
      if (!on) { await autostart.disable(); return false; }
      // In development process.execPath is the electron binary and the app
      // directory has to be passed explicitly, or autostart launches a bare
      // Electron with no application to run.
      const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
      await autostart.enable({ execPath: process.execPath, args });
      return true;
    },

    // The window is frameless, so the renderer draws its own title bar and
    // these are the only route to minimise/maximise/close. Resolved from the
    // sender rather than a captured reference: the incoming-call popup loads
    // the same preload, and must act on itself rather than the main window.
    // close() deliberately goes through the normal close path so the
    // hide-to-tray handler in index.js still governs what closing means.
    'window:minimize': (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); },
    'window:maximize': (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w) return false;
      if (w.isMaximized()) w.unmaximize(); else w.maximize();
      return w.isMaximized();
    },
    'window:close': (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); },

    // Bluetooth adapter and pairing. Guarded because Windows has no adapter
    // namespace, exactly as `backend.audio` is guarded below.
    'adapter:power-get': () => requireAdapter().getPower(),
    'adapter:power-set': (_e, on) => requireAdapter().setPower(Boolean(on)),
    'scan:start': () => requireAdapter().startScan(),
    'scan:stop': () => requireAdapter().stopScan(),
    // mac comes straight from the renderer and gets interpolated into a
    // D-Bus object path downstream, so it is validated here at the trust
    // boundary rather than trusted to already be well-formed.
    'pair:start': (_e, mac) => {
      if (!isValidMac(mac)) throw new Error(`invalid MAC address: ${mac}`);
      return requireAdapter().pair(mac);
    },
    'pair:confirm': (_e, ok) => requireAdapter().confirm(Boolean(ok)),
    // Returns false (never throws) when another agent holds the name, which is
    // what lets the renderer degrade per spec §7.1 instead of dead-ending.
    'pair:register': () => requireAdapter().registerAgent(),
    // The agent is a process-wide bus registration, so onboarding closing has
    // to hand it back - otherwise Konnect holds the pairing agent (and blocks
    // the next application that wants it) until the app quits.
    'pair:unregister': () => requireAdapter().unregisterAgent(),

    // Google is optional at every level: an unconfigured or absent integration
    // answers honestly instead of throwing, so the Settings section can render
    // a disabled row rather than an error.
    'google:status': () => (google ? google.status() : { configured: false, signedIn: false }),
    // requireGoogle() keeps the "not configured" guard on this path exactly
    // as before; the actual sign-in goes through the wrapper so main can
    // chain the detached post-sign-in sync/backup (spec 6.5/7.4) regardless
    // of which caller reaches this handler.
    'google:sign-in': () => { requireGoogle(); return signInGoogle(); },
    'google:sign-out': () => requireGoogle().signOut(),
    'google:sync-contacts': () => syncGoogleContacts(),
    'google:backup-now': () => backupNow(),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }

  // onCallVolume awaits the CallVolume proxy, which throws (silently, by
  // design) when the modem is absent - a normal state right when the app
  // starts under autostart-at-login, since the phone is rarely connected at
  // that exact instant. One attempt at launch is not enough for the session
  // to ever recover, so retry on the first status:changed where `connected`
  // turns true. callVolumeAttached/callVolumeAttaching stop a later
  // reconnect - or two status events landing close together - from stacking
  // a second PropertyChanged subscription on top of an already-live one.
  let callVolumeAttached = false;
  let callVolumeAttaching = false;
  function attachCallVolume() {
    if (callVolumeAttached || callVolumeAttaching) return;
    callVolumeAttaching = true;
    Promise.resolve(backend.onCallVolume((v) => broadcast('callvolume:changed', v)))
      .then(() => { callVolumeAttached = true; })
      .catch(() => {})
      .finally(() => { callVolumeAttaching = false; });
  }

  backend.onDeviceStatus((s) => {
    broadcast('status:changed', s);
    if (s.connected) attachCallVolume();
  });
  backend.onCall((c) => broadcast('call:changed', c));
  backend.onContacts((list) => {
    const result = store.upsertContacts(list);
    broadcast('contacts:changed', { contacts: store.listContacts(), result });
  });
  attachCallVolume();
  if (backend.audio) backend.audio.onRouting((r) => broadcast('routing:changed', r));
  if (backend.adapter) {
    backend.adapter.onDiscovered((d) => broadcast('scan:device', d));
    backend.adapter.onPairingRequest((r) => broadcast('pair:request', r));
    // onPower is async and can reject (bus down mid-startup). Fire-and-forget
    // with no .catch would be an unhandled rejection, which is fatal to the
    // main process on Node >= 15 - the app would die before it could show
    // state 1a. adapter.js already returns a no-op unsubscribe for the
    // no-adapter case, so anything reaching here is a real bus fault, and one
    // that leaves the app usable minus live power updates.
    backend.adapter.onPower((powered) => broadcast('adapter:changed', { powered, present: true }))
      .catch(() => {});
  }
}

module.exports = { registerIpc, applyTheme };
