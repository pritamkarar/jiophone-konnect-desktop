'use strict';
const {
  app, BrowserWindow, Tray, Menu, nativeImage, Notification, dialog, protocol, shell,
  safeStorage,
} = require('electron');
const path = require('node:path');
const { createBackend } = require('./backend');
const { withContactName, numberFromTelUrl, isDialable } = require('../shared/phone');
const { recentlyDialled } = require('../shared/speeddial');
const { openStore } = require('./store');
const { registerIpc, applyTheme } = require('./ipc');
const { createCallSession } = require('./callsession');
const { createRecordHandler } = require('./recording-policy');
const { registerRecordingProtocol } = require('./recordings');
const { pickBootstrapMac, shouldReconnect } = require('./device-select');
const { isValidMac } = require('./backend/linux/bus');
const { createAuth } = require('./google/auth');
const { syncContacts } = require('./google/contacts');
const { createBackupRunner } = require('./google/backup');

let win = null;
let tray = null;
let trayAvailable = false;
let backend = null;
let store = null;
let google = null;
let backupRunner = null;
let callSession = null;
let incomingWin = null;
// The ringing call whose popup the user closed by hand, so the re-emitted
// property changes that follow do not bring it back.
let dismissedCallId = null;
let incomingCallId = null;
let shuttingDown = false;
// The mac the backend is actually bound to. NOT the same as the `device_mac`
// setting: that setting is deliberately left unset on first run so the
// wizard triggers, while the backend may already be bound to a device
// resolved from BlueZ. Reading the setting here would make the Setup checks
// report "no handset selected" on a connected, working app.
let boundMac = null;

// Finalising a recording must not be able to hold the app open. Past this
// deadline we stop waiting and dispose anyway - dispose() kills any recorder
// still running, so the worst case is a kept WAV rather than a lost Opus.
const SHUTDOWN_GRACE_MS = 20000;

// The app mark, rendered from assets/logo.svg. It must be a real image:
// nativeImage.createEmpty() yields isEmpty() === true, so a tray built from it
// is blank even where the tray itself works.
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'tray.png');
// The call glyph beside each number in the tray's recent-calls section.
const CALL_ICON = path.join(__dirname, '..', '..', 'assets', 'call.png');
// How many recently dialled numbers the tray menu offers.
const TRAY_RECENTS = 5;

const DEFAULT_TONE = path.join(__dirname, '..', '..', 'assets', 'ringtone.ogg');

function ringSettings() {
  return {
    enabled: store.getSetting('ring_enabled') !== 'false',
    tone: store.getSetting('ring_tone') && store.getSetting('ring_tone') !== 'bundled'
      ? store.getSetting('ring_tone')
      : DEFAULT_TONE,
    // ring_sink falls back to the routed output, then to the system default.
    sink: store.getSetting('ring_sink') || store.getSetting('audio_sink') || null,
  };
}

// `stream: true` is what lets <audio> issue range requests against this
// scheme; without it seeking a recording silently does nothing. `standard:
// true` is required alongside it, and is why the filename must travel in the
// URL path - see nameFromUrl in recordings.js.
protocol.registerSchemesAsPrivileged([{
  scheme: 'konnect-rec',
  // corsEnabled alongside supportFetchAPI: the renderer is a file:// origin,
  // so fetching konnect-rec:// to decode a waveform is a CROSS-origin request
  // and is blocked without it - <audio src> was unaffected, which is why this
  // only showed up when the player started reading its own peaks.
  privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  },
}]);

// new Tray() does NOT throw when no StatusNotifier host is on the bus - it
// silently produces an invisible icon - so ask the bus directly rather than
// inferring availability from the constructor succeeding. Verified on the
// target machine: the appindicator extension is enabled but INACTIVE, and
// org.kde.StatusNotifierWatcher is absent.
const TRAY_HOST = 'org.kde.StatusNotifierWatcher';

async function detectTrayHost() {
  if (process.platform !== 'linux') return true;
  try {
    const { sessionBus } = require('./backend/linux/bus');
    await sessionBus().getProxyObject(TRAY_HOST, '/StatusNotifierWatcher');
    return true;
  } catch {
    return false;
  }
}
// detectTrayHost() is a sample, and under autostart-at-login it samples too
// early: gnome-session launches Konnect BEFORE gnome-shell has loaded the
// appindicator extension that owns org.kde.StatusNotifierWatcher. Straight
// from the journal - the login run at 10:43:59 logged "No system tray host"
// one second later, while a manual launch at 10:45:58 found it fine. Because
// trayAvailable is latched at startup and the focus handler only ever
// downgrades, losing that race cost the tray icon for the WHOLE session.
//
// So watch the name rather than only sampling it. NameOwnerChanged is the
// bus's own answer to "tell me when this appears", which beats both polling
// and guessing a startup delay in the .desktop file: it fires whenever the
// host arrives, however late, and on a machine where the extension never
// loads it simply never fires and nothing changes.
async function watchTrayHost() {
  if (process.platform !== 'linux') return;
  try {
    const { sessionBus, getInterface } = require('./backend/linux/bus');
    const dbusIface = await getInterface(
      sessionBus(), 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus');
    dbusIface.on('NameOwnerChanged', (name, _oldOwner, newOwner) => {
      if (name !== TRAY_HOST) return;
      trayAvailable = Boolean(newOwner);
      // Building the icon here is what makes upgrading false->true safe at
      // all. The focus handler refuses to upgrade for a good reason - it has
      // no way to build a tray - and that reason does not apply to this path.
      //
      // ponytail: a host that goes away leaves its (now invisible) Tray
      // object in place, so a host that comes BACK in the same session does
      // not get a fresh icon. Rebuilding would mean unsubscribing
      // createTray()'s onDeviceStatus listener too; wire that up if anyone
      // ever reports a flapping extension mid-session.
      if (trayAvailable && !tray) createTray();
      console.log(`[konnect] tray host ${trayAvailable ? 'appeared' : 'went away'}`);
    });
  } catch (err) {
    // A missing watch is degraded, not broken: the app behaves exactly as it
    // did before this function existed.
    console.warn('[konnect] could not watch for a tray host:', err.message);
  }
}


function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    // 1100x700 and frameless to match the design canvas, which draws its own
    // title bar. Deliberately NOT transparent:true - the canvas rounds the
    // window's outer corners, but transparency is unreliable across Linux
    // compositors and a failed composite loses the whole window background,
    // not just the corners.
    // The layout is clean down to ~803 CSS px and only the dial pad breaks
    // below that. minWidth is in device-independent px, so the CSS width the
    // renderer sees is minWidth/devicePixelRatio - 1040 keeps that above 803
    // for the common 100-125% display scalings (this machine reports 1.095).
    width: 1100, height: 700, minWidth: 1040, minHeight: 660,
    frame: false, backgroundColor: '#070B1A',
    show: false, title: 'JioPhone Konnect', icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // --hidden comes from the autostart entry. Starting hidden is only safe
  // when a tray icon will actually appear; with no StatusNotifier host the
  // window would be unreachable except by kill - the same reasoning that
  // governs the close handler below.
  win.once('ready-to-show', () => {
    if (process.argv.includes('--hidden') && trayAvailable) return;
    win.show();
  });
  // Tray-resident: closing hides rather than quits, so incoming calls still
  // surface (spec section 9). But ONLY when a tray icon will actually be
  // visible - hiding with no tray strands the window with no way back.
  win.on('close', (e) => {
    if (!app.isQuitting && trayAvailable) { e.preventDefault(); win.hide(); }
  });

  // Hiding does not stop the renderer, and the renderer is the only thing
  // that stops a scan (onboarding stops it on a state change or at close).
  // The title bar sits outside #shell, so its close button is live even
  // during blocking first-run onboarding: one click and StartDiscovery plus
  // a 1.5s poll run invisibly for the life of the process, draining the
  // handset battery and degrading every other Bluetooth link. Stopped here
  // rather than in the renderer because this also survives a wedged one.
  // Every level is optional: backend is unbound until whenReady, and the
  // Windows backend has no adapter namespace at all.
  win.on('hide', () => { backend?.adapter?.stopScan?.().catch(() => {}); });

  // trayAvailable is latched at startup, but a StatusNotifier host can come
  // and go mid-session - the appindicator extension on this machine flipped
  // state within twenty minutes. If it disappears while we still believe it
  // is there, close() hides the window into a tray that no longer exists and
  // the app is unreachable except by kill. The close handler has to stay
  // synchronous to call preventDefault, so re-check on focus: the user
  // necessarily focuses the window before closing it.
  //
  // Only ever DOWNGRADE. Going false->true would hide the window into a tray
  // that createTray() never built - the same failure, inverted.
  win.on('focus', async () => {
    if (!trayAvailable) return;
    try {
      trayAvailable = await detectTrayHost();
    } catch {
      /* keep the last known value */
    }
  });
}

// Scoped by call id: with two calls up, the first one ending must not tear
// down the SECOND one's ringing window. Verified sequence - A active, B
// waiting, A disconnected - destroyed B's window while the handset kept
// ringing, and with the main window hidden to tray that popup is the only
// affordance to answer from the PC. A bare call (no id) still closes
// whatever is up, which is what shutdown and the mock path want.
function closeIncoming(id) {
  if (id && incomingCallId && incomingCallId !== id) return;
  if (backend && backend.audio) backend.audio.stopRing();
  if (incomingWin && !incomingWin.isDestroyed()) incomingWin.close();
  incomingWin = null;
  incomingCallId = null;
  // The call this dismissal was about is over, so stop suppressing it. Matched
  // on the id, not cleared blindly: with a second call ringing behind the
  // first, ending one must not un-dismiss the other.
  if (id && dismissedCallId === id) dismissedCallId = null;
}

// The popup's own close button. Silences the ring and takes the window away
// WITHOUT hanging up - the handset is still ringing and can still be answered
// there, which is the whole difference between this and Decline.
function dismissIncoming() {
  const id = incomingCallId;
  closeIncoming();
  // Sticky, because oFono re-emits the whole call object on every property
  // change while it rings (see showIncoming). Without this the next such event
  // would walk straight past the id guard - closeIncoming just cleared it - and
  // put the popup the user dismissed right back on screen.
  dismissedCallId = id;
}

// Tray-resident means the main window may be hidden when a call arrives, so
// an incoming call needs its own always-on-top surface plus a desktop
// notification - otherwise a hidden window makes incoming calls invisible.
function showIncoming(call) {
  // oFono re-emits the WHOLE call object on every PropertyChanged, not only on
  // state transitions - a caller name resolving mid-ring is one such event -
  // so guard on the call id. Without it the window is destroyed and rebuilt
  // and a duplicate notification fires for each property change while ringing.
  // Measured: three windows and three notifications for one ringing call.
  if (incomingCallId === call.id) return;
  // Dismissed by the user: stay gone until this call ends and a new one comes.
  if (dismissedCallId === call.id) return;
  closeIncoming();
  incomingCallId = call.id;
  const waiting = call.state === 'waiting';
  const ring = ringSettings();
  // No PC ringtone for a waiting call: it would play through the sink that
  // is carrying the conversation. The popup and the notification remain.
  if (ring.enabled && backend.audio && !waiting) backend.audio.startRing(ring);
  const q = new URLSearchParams({
    id: call.id, number: call.number || '', name: call.name || 'Unknown', state: call.state,
  }).toString();

  incomingWin = new BrowserWindow({
    // The card's own size, now that body no longer frames it in 36px of
    // padding: 400x316 minus that frame on both axes.
    width: 328, height: 244, resizable: false, alwaysOnTop: true,
    frame: false, backgroundColor: '#070B1A',
    skipTaskbar: true, title: 'Incoming call', icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  incomingWin.loadFile(path.join(__dirname, '..', 'renderer', 'incoming.html'), { search: q });

  new Notification({
    title: `${waiting ? 'Call waiting' : 'Incoming call'} - ${call.name || 'Unknown'}`,
    body: call.number || '',
    icon: ICON,
  }).show();
}

// A tray click dials without the renderer being involved at all, so it
// repeats the two guards that make ipc.js's call:dial safe rather than
// trusting a menu that was built from the call log at some earlier moment.
async function dialFromTray(number) {
  // Raise the window whatever happens next. On success, the in-call panel is
  // the only place to hang up or mute - a call placed into a hidden window
  // leaves the user with a live line and no controls. On failure, it is where
  // the message below appears.
  showMainWindow();
  try {
    if (callSession && !callSession.canDial()) throw new Error('A call is in progress; put it on hold to dial another.');
    if (!isDialable(number)) throw new Error(`Not a number Konnect can dial: ${number}`);
    await backend.dial(number);
    console.log('[konnect] dialled from the tray');
  } catch (err) {
    console.warn('[konnect] tray dial failed:', err.message);
    // A dialog, not a Notification: banners can be switched off desktop-wide
    // (they are on the machine this was built against), and a tray item that
    // silently does nothing is indistinguishable from a broken one. It also
    // matches what the dialer's own Call button already does with this exact
    // message.
    dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Konnect could not place the call',
      detail: err.message,
      buttons: ['OK'],
    });
  }
}

function trayMenu() {
  // Same helper as the dialer's speed-dial strip, so the two agree on what
  // "recently dialled" means: outbound only, withheld numbers excluded, one
  // slot per number however often it was redialled.
  const icon = nativeImage.createFromPath(CALL_ICON);
  const recents = recentlyDialled(store.listCalls(), TRAY_RECENTS).map((row) => ({
    label: row.name || row.number_e164,
    icon,
    click: () => dialFromTray(row.number_e164),
  }));
  return Menu.buildFromTemplate([
    { label: 'Open Konnect', click: () => showMainWindow() },
    // Omitted entirely on a fresh install: a lone separator and no items
    // reads as a broken menu.
    ...(recents.length ? [{ type: 'separator' }, ...recents] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

// Called again whenever a call lands in the log, so the number just dialled
// is at the top of the menu the next time it is opened. Guarded: with no
// tray host there is no menu to set.
function refreshTrayMenu() {
  if (tray) tray.setContextMenu(trayMenu());
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  const refresh = (status) => {
    const bits = ['Konnect'];
    if (status?.model) bits.push(status.model);
    if (typeof status?.battery === 'number') bits.push(`${status.battery}%`);
    if (status?.operator) bits.push(status.operator);
    tray.setToolTip(bits.join(' - '));
  };
  refreshTrayMenu();
  refresh(null);
  backend.onDeviceStatus(refresh);
  backend.getStatus().then(refresh).catch(() => {});
}

// Electron relaunches by handing the new command line to a helper that waits
// for THIS process to exit, but the single-instance lock is ours to give
// back. Losing that race means the replacement finds the lock still held and
// quits on startup, so changing the handset would leave the user with no app
// at all - a worse outcome than the duplicate instances the lock prevents.
function relaunch() {
  app.releaseSingleInstanceLock();
  app.relaunch();
  app.isQuitting = true;
  app.quit();
}

// Changing the bound handset relaunches rather than rebuilding the backend in
// place. The backend threads `mac` into four long-lived subsystems, and a
// hot-swap would add a teardown path that runs almost never - a leaked D-Bus
// listener there is invisible until status updates silently stop. A relaunch
// is the most exercised path in the application. See spec section 3.1.
async function selectDevice(newMac) {
  // device:select is an IPC channel, so this is a trust boundary. Persisting
  // an unparseable address bricks the NEXT startup - macToPathSegment throws
  // inside app.whenReady(), and the bad value is still stored, so every later
  // launch fails identically. Reject it here instead.
  if (!isValidMac(newMac)) throw new Error(`invalid device address: ${newMac}`);
  // Compare against the mac the backend is ACTUALLY bound to, not the
  // `device_mac` setting - that setting is deliberately unset until this
  // very call persists it (see boundMac above), so on every first run it can
  // never equal newMac and the app relaunched even when the wizard just
  // confirmed the handset the backend already bound to at startup.
  const current = boundMac;
  store.setSetting('device_mac', newMac);
  if (current === newMac) return { relaunching: false };
  // app.exit() does NOT fire before-quit, so it must never be used to drive
  // a relaunch: callSession.stop()/backend.dispose()/store.close() would be
  // skipped, orphaning a call still recording. Go through the app's normal
  // quit path instead - the before-quit handler below still ends in
  // app.exit(0), which is what actually lets the scheduled relaunch happen.
  relaunch();
  return { relaunching: true };
}

// Forgets the handset completely: the BlueZ bond first, then Konnect's own
// binding, then a restart into onboarding.
//
// This was deliberately binding-only until now, on the reasoning that leaving
// the pairing alone kept Konnect out of the system's Bluetooth settings and
// made re-selecting the handset a single click. Changed on request: "forget"
// means forget, and the cost is that the phone must be paired again from the
// handset side, passkey and all.
//
// The unpair is best-effort BY DESIGN. If BlueZ refuses - device already
// gone, bus down, adapter missing - the binding is still cleared and the app
// still restarts: the user asked to stop using this handset, and leaving them
// bound to the thing they just forgot is the worse of the two failures. The
// message comes back so Settings can admit the handset is still paired.
//
// One consequence worth knowing: pickBootstrapMac falls back to the first
// PAIRED device, so with the bond gone the next start no longer re-binds to
// this phone at all - which is what the old comment here said it could not do.
//
// Relaunch goes through the same normal quit path as selectDevice, and for the
// same reason: app.exit() skips before-quit, so callSession.stop(),
// backend.dispose() and store.close() would all be skipped.
async function forgetDevice() {
  if (!store.getSetting('device_mac')) return { relaunching: false };
  let unpairError = null;
  try {
    // Optional chaining: the windows backend has no adapter namespace at all.
    // RemoveDevice disconnects implicitly, so there is no disconnect step.
    await backend.adapter?.removeDevice(boundMac);
  } catch (err) {
    unpairError = err.message;
    console.warn('[konnect] could not unpair the handset:', err.message);
  }
  store.setSetting('device_mac', '');
  relaunch();
  return { relaunching: true, unpairError };
}

// The handset the user chose should still be there when they open Konnect
// again - BlueZ does not reconnect from this side on its own, so without this
// a returning user had to click Connect every launch.
//
// ONE attempt, deliberately. Under autostart-at-login the radio and the phone
// are rarely both ready at the instant Konnect starts, so this will sometimes
// miss; retrying on a schedule was considered and left out, because a phone
// that is off or in another room is the normal case, not a fault to keep
// hammering. getStatus() comes first so a link BlueZ already has costs no
// Connect() call.
//
// Never awaited and never throws: the caller fires it detached so a handset
// out of range cannot delay the window, which also means a rejection here
// would be unhandled.
async function reconnectHandset() {
  try {
    const { connected } = await backend.getStatus();
    if (!shouldReconnect({ storedMac: store.getSetting('device_mac'), connected })) return;
    // boundMac, not the setting: they are equal whenever shouldReconnect says
    // yes (pickBootstrapMac returns a valid stored mac unchanged), and this is
    // the address the backend's own D-Bus paths were built from.
    await backend.connect(boundMac);
    console.log('[konnect] startup reconnect requested:', boundMac);
  } catch (err) {
    console.warn('[konnect] startup reconnect failed:', err.message);
  }
}

// Fires a contacts sync and a backup pass without blocking the caller. Used
// right after sign-in (spec 6.5/7.4) and again at startup for a user who was
// already signed in - same two operations, same never-block/never-reject
// contract either way. syncContacts throws by contract (caught here);
// backupRunner.runNow() never rejects, so its .finally alone is enough.
function syncAndBackup() {
  syncContacts({ auth: google, store })
    .then((result) => broadcast('contacts:changed', { contacts: store.listContacts(), result }))
    .catch((err) => google.setError(err.message))
    .finally(() => broadcast('google:changed'));
  backupRunner.runNow().finally(() => broadcast('google:changed'));
}

// One process, one Konnect. The window is tray-resident, so the natural way to
// get it back is to click the launcher again - and Electron's default is to
// oblige with a whole second instance: a second D-Bus agent, a second SQLite
// handle on konnect.db, a second recorder. The loser exits here, above the
// before-quit handler and so before it is even registered, which is what
// makes the bare app.quit() safe - that handler defers every quit it sees.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// tel: links arrive two ways and both land here: as an argv entry on a cold
// start, and in the second-instance argv when the app is already running.
// Nothing is dialled. The number goes into the dial field and the user
// presses Call, so a link on a web page cannot place a call on its own -
// the same reasoning that put the re-entrancy guard in main (see ipc.js).
function handleTelArgv(argv) {
  const number = (argv || []).map(numberFromTelUrl).find(Boolean);
  if (!number) return;
  showMainWindow();
  broadcast('dial:prefill', number);
  console.log('[konnect] tel: link handed to the dialer');
}

// Whatever made the user launch again, the window is what they wanted - and
// a tel: link is the commonest reason for a second launch there is.
app.on('second-instance', (_event, argv) => {
  showMainWindow();
  handleTelArgv(argv);
});

app.whenReady().then(async () => {
  trayAvailable = await detectTrayHost();
  if (!trayAvailable) {
    // Not fatal: incoming calls still surface via a desktop notification and
    // the call window (task 10). Only close-to-tray is given up.
    console.warn(
      '[konnect] No system tray host (org.kde.StatusNotifierWatcher). '
      + 'Closing the window will quit rather than hide to the tray.');
  }
  store = openStore(path.join(app.getPath('userData'), 'konnect.db'));
  // Before createWindow(), so the first paint is already in the chosen
  // theme rather than flashing the default one. Everything downstream is
  // CSS: the palettes live behind prefers-color-scheme, which this steers.
  applyTheme(store.getSetting('theme'));
  const mock = process.env.KONNECT_MOCK === '1';
  // Resolve which handset to bind to BEFORE constructing the real backend.
  // An unbound backend is used purely to ask BlueZ what exists; it holds no
  // listeners and needs no dispose.
  const probe = createBackend({ mock, mac: null });
  const devices = await probe.listDevices().catch(() => []);
  const mac = pickBootstrapMac(store.getSetting('device_mac'), devices);
  // Setup checks must probe the device the backend actually bound to, which
  // on a first run is a device BlueZ reported rather than anything persisted.
  boundMac = mac;
  backend = createBackend({ mock, mac, getSetting: (k) => store.getSetting(k) });
  console.log('[konnect] bound to handset:', mac || '(none - no phone paired)');
  // Logged once so a journal from another JioPhone model carries the
  // identifiers a bug report needs. Modalias survives disconnection, so this
  // answers even when the handset is out of range at launch.
  backend.getStatus().then((s) => {
    if (s.pnp) console.log(`[konnect] handset ${s.model || '?'} pnp ${s.pnp.vendor}:${s.pnp.product} firmware ${s.pnp.version}`);
  }).catch(() => {});

  // Caller id is resolved by wrapping the SOURCE, once. The incoming-call
  // popup (below), the dialer's call panel (ipc.js's call:changed broadcast)
  // and the call session all subscribe to backend.onCall separately, so
  // resolving in any one of them leaves the others saying "Unknown".
  const rawOnCall = backend.onCall.bind(backend);
  backend.onCall = (cb) => rawOnCall((call) => {
    let named = call;
    try {
      named = withContactName(call, (n) => store.findContactByNumber(n));
    } catch (err) {
      // This runs inside a D-Bus signal handler, and the store can be closed
      // under it during shutdown. A missing name is a cosmetic loss; an
      // exception escaping here would break call handling for the session.
      console.error('[konnect] caller id lookup failed:', err.message);
    }
    cb(named);
  });

  // openExternal, never a BrowserWindow: Google blocks embedded webviews, and
  // an in-app login window would mean Konnect renders someone's Google
  // password field.
  google = createAuth({ store, safeStorage, openExternal: (url) => shell.openExternal(url) });
  backupRunner = createBackupRunner({ auth: google, store });

  registerIpc({
    backend,
    store,
    broadcast,
    // Reached lazily: callSession is assigned on the next statement.
    hasLiveCall: () => callSession?.hasLiveCall() ?? false,
    canDial: () => callSession?.canDial() ?? true,
    liveCalls: () => callSession?.liveCalls() ?? [],
    getMac: () => boundMac,
    selectDevice,
    forgetDevice,
    ringSettings,
    dismissIncoming,
    google,
    syncGoogleContacts: async () => {
      const result = await syncContacts({ auth: google, store });
      broadcast('contacts:changed', { contacts: store.listContacts(), result });
      broadcast('google:changed');
      return result;
    },
    backupNow: async () => {
      const res = await backupRunner.runNow();
      broadcast('google:changed');
      return res;
    },
    // Sign-in itself must return the moment the token is stored - a user
    // staring at a spinner while 2000 contacts download is a regression - so
    // the catch-up sync/backup is fired here, detached, AFTER google.signIn()
    // resolves rather than awaited by it. See syncAndBackup() above.
    signInGoogle: async () => {
      const result = await google.signIn();
      syncAndBackup();
      return result;
    },
  });
  callSession = createCallSession({
    backend,
    store,
    // Fire-and-forget by construction: schedule() only arms a timer, and the
    // pass it eventually runs never rejects. A Google failure cannot reach
    // the call path (spec section 8).
    onPersisted: () => {
      broadcast('calls:changed');
      refreshTrayMenu();
      backupRunner.schedule();
    },
    onRecord: createRecordHandler({
      store, backend, attachRecording: (id, p) => callSession.attachRecording(id, p),
    }),
  });
  callSession.start();
  backend.onCall((call) => {
    // 'waiting' is oFono's second-inbound-call state and is in the backend's
    // own INBOUND_STATES. Treating it here is what makes the dialer's
    // primaryCall() rationale true: the in-app panel deliberately keeps
    // showing the ACTIVE call because a ringing one surfaces as a notification
    // and its own window - which only holds if 'waiting' opens one.
    if (call.state === 'incoming' || call.state === 'waiting') showIncoming(call);
    else if (call.state === 'disconnected' || call.state === 'active') closeIncoming(call.id);
  });

  // Mock-only: schedule a simulated incoming call so the incoming-call window
  // and notification can be verified without a real handset ringing. Ignored
  // entirely by the linux backend, which has no simulateIncoming.
  const mockIncomingDelay = Number(process.env.KONNECT_MOCK_INCOMING);
  if (typeof backend.simulateIncoming === 'function'
      && Number.isFinite(mockIncomingDelay) && mockIncomingDelay > 0) {
    // KONNECT_MOCK_INCOMING_NUMBER lets the caller-id path be exercised with a
    // number that is actually in Contacts - the built-in default is not.
    setTimeout(() => backend.simulateIncoming(process.env.KONNECT_MOCK_INCOMING_NUMBER || undefined),
      mockIncomingDelay);
  }
  registerRecordingProtocol({ protocol });
  // Claimed on every start, not once: a desktop reinstall, another app
  // grabbing the scheme, or a fresh profile all silently drop the
  // association, and re-asserting costs one xdg-settings call.
  app.setAsDefaultProtocolClient('tel');
  createWindow();
  if (trayAvailable) createTray();
  // Cold start: process.argv holds the URL, but the renderer has no listener
  // until its first load finishes - broadcasting before that drops it on the
  // floor. `once`, so a later Ctrl+R does not re-open a stale link.
  win.webContents.once('did-finish-load', () => handleTelArgv(process.argv));
  // Detached: it only installs a listener, and a session bus that will not
  // answer must not hold up the rest of startup.
  watchTrayHost();

  // Startup catch-up. All detached: none may delay the window, and neither a
  // Google outage nor a handset out of range must stop the rest working.
  reconnectHandset();
  if (google.isSignedIn()) syncAndBackup();
});

app.on('window-all-closed', () => {
  // With no tray there is no way back to the app, so quit normally.
  if (!trayAvailable) app.quit();
});
app.on('before-quit', async (event) => {
  // preventDefault BEFORE the guard: a second quit trigger arriving during
  // shutdown must also be deferred, or Electron's default quit races the
  // cleanup already in flight.
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  app.isQuitting = true;

  // Defer the quit: a call still recording needs its encode finished and its
  // path attached before the row is written, and its pw-record child reaped.
  // Quitting synchronously orphans the process and loses the recording.
  try {
    await Promise.race([
      callSession?.stop(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
    // dispose() is awaited so the OBEX UnregisterAgent round trip actually
    // goes out. It used to be fire-and-forget, and app.exit(0) below is
    // immediate, so the pending microtask was discarded and the agent was
    // only ever freed by obexd's disconnect watch - exactly the external
    // safety net the guarantee was supposed to replace. Bounded separately so
    // a hung bus cannot re-open the unquittable-app hole.
    await Promise.race([
      Promise.resolve(backend?.dispose?.()),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    // Synchronous, no await: waiting on the network here would delay quit.
    // This only stops an in-flight or scheduled backup pass from writing to
    // the store after it closes on the next line.
    backupRunner?.dispose();
    store?.close();
  } catch (err) {
    // Every step above is best-effort. A throw here previously skipped
    // app.exit() entirely, and because shuttingDown is already set, every
    // later quit attempt returns at the guard - the app becomes unquittable
    // by a different route than the one the timeout closed.
    console.error('[konnect] shutdown step failed:', err.message);
  } finally {
    app.exit(0);
  }
});
