# Konnect Settings, Wizard and Recording Playback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recording playback to the call log, a four-step first-run device wizard, and a settings page covering ringtone, volume, autostart and audio device selection.

**Architecture:** `device_mac` becomes a user-chosen value rather than a construction-time constant; changing it relaunches the app instead of hot-swapping the backend. A new `audio.js` module owns PipeWire enumeration, Konnect-owned call routing and the ringtone, with all decision logic in pure functions. Recordings are served to the renderer through a dedicated privileged protocol with a path-traversal guard.

**Tech Stack:** Electron 44, `dbus-next`, `node:sqlite`, `node:test`. PipeWire CLI tools (`pw-dump`, `pw-link`, `pw-play`, `wpctl`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-konnect-settings-wizard-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Tests:** `node:test` and `node:assert` only. `npm test` is bare `node --test`. **Never run `node --test test/`** — it fails on Node 24.
- **No new dependencies.** `package.json` gains nothing.
- **IPC:** every channel is declared in `src/main/ipc.js` **and** mirrored in the `src/main/preload.js` allowlist. Adding one anywhere else is a bug. `contextIsolation: true`, `nodeIntegration: false`.
- **Renderer XSS:** all handset-derived and filesystem-derived strings are rendered with `textContent` / `createElement`, never `innerHTML`.
- **Never place a call, never ring the handset, never dial to prove anything works.**
- **Never register a BlueZ pairing agent.** No `StartDiscovery`, no `org.bluez.Agent1`.
- **Audio:** `pw-link` on ports directly. **Never `pw-loopback`.** `recorder.js` keeps `pw-record --target 0` and its own link discovery — do not modify it.
- **Never write to `~/.config/konnect/konnect.db`.** Any Electron run for verification uses an isolated `--user-data-dir` under the scratchpad.
- **Leave no wedged processes.** Kill by explicit PID from `pgrep`; `pkill -f` patterns have killed the agent's own shell on this project twice.
- Commit after every task.

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `src/main/recordings.js` | Recording path traversal guard + `konnect-rec://` protocol |
| `src/main/autostart.js` | `~/.config/autostart/konnect.desktop` write / read / remove |
| `src/main/backend/linux/audio.js` | PipeWire node enumeration, routing plan + apply, PC volume, ringtone |
| `src/renderer/settings.js` | Settings view |
| `src/renderer/wizard.js` | Four-step onboarding |
| `assets/ringtone.ogg` | Bundled ringtone |
| `test/recordings.test.js` · `test/autostart.test.js` · `test/audio-helpers.test.js` · `test/callvolume.test.js` | Unit tests |
| `test/fixtures/pw-dump.json` | Captured PipeWire dump for `parseNodes` |

**Modified files**

| File | Change |
| --- | --- |
| `src/main/setup.js` | Delete `MODEM_PATH` literal; mac-parameterise checks |
| `src/main/backend/linux/index.js` | Tolerate `mac === null`; wire routing at call start |
| `src/main/backend/linux/telephony.js` | `org.ofono.CallVolume` get/set/subscribe |
| `src/main/index.js` | Bootstrap mac resolution, protocol registration, relaunch, `--hidden` |
| `src/main/ipc.js` · `src/main/preload.js` | New channels |
| `src/renderer/index.html` · `app.js` · `styles.css` | Settings tab, playback UI, script split |

**Shared signatures** (used across tasks — names are fixed here so tasks written independently agree)

```
recordings.js     resolveRecordingPath(name, dir?) -> absolutePath | throws
                  registerRecordingProtocol({ protocol, net, dir? }) -> void
                  RECORDINGS_DIR

autostart.js      desktopEntry({ execPath, args }) -> string
                  isEnabled() -> boolean
                  enable({ execPath, args }) -> Promise<void>
                  disable() -> Promise<void>
                  AUTOSTART_PATH

audio.js          parseNodes(dumpArray) -> [{ id, name, description, mediaClass }]
                  planLinks({ sink, source, ports, links }) -> { unlink, link, fallback, reason }
                  listAudioDevices() -> Promise<{ sinks: [], sources: [] }>
                  applyRouting({ sink, source }) -> Promise<{ remoteLinked, micLinked, fellBack, reason }>
                  getPcVolume(nodeName) -> Promise<number>   // 0-100
                  setPcVolume(nodeName, pct) -> Promise<void>
                  startRing({ tone, sink }) -> void
                  stopRing() -> void

telephony.js      clampVolume(n) -> integer 0-100
                  getCallVolume() -> Promise<{ speaker, microphone, muted, error }>
                  setCallVolume({ speaker?, microphone?, muted? }) -> Promise<void>
                  onCallVolume(cb) -> unsubscribe

setup.js          runChecks({ exec, mac }) -> Promise<[{ id, label, ok, detail, remedy }]>
                  remediate(id, { exec, writeFile, mac }) -> Promise<...>

index.js          resolveBootstrapMac(store, backendListDevices) -> Promise<string|null>
```

---

### Task 1: Recording protocol and path guard

Serves recordings to the renderer. A plain `file://` `src` was considered and rejected: `<audio>` seeking issues range requests, and `net.fetch` on a file URL handles ranges and MIME correctly for free. The traversal guard is the point of the module — `recording_path` comes out of the database, and resolving a caller-supplied string against the filesystem is a traversal sink.

**Files:**
- Create: `src/main/recordings.js`
- Test: `test/recordings.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `resolveRecordingPath(name, dir?)`, `registerRecordingProtocol({ protocol, net, dir? })`, `RECORDINGS_DIR`

- [ ] **Step 1: Write the failing test**

```js
// test/recordings.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveRecordingPath } = require('../src/main/recordings');

const DIR = '/home/u/Konnect/recordings';

test('resolves a plain basename inside the recordings directory', () => {
  assert.strictEqual(
    resolveRecordingPath('1788278920104-voicecall01.opus', DIR),
    path.join(DIR, '1788278920104-voicecall01.opus'));
});

test('preserves case - basenames contain uppercase hex from the MAC', () => {
  assert.strictEqual(
    resolveRecordingPath('1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34_voicecall01.opus', DIR),
    path.join(DIR, '1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34_voicecall01.opus'));
});

test('rejects traversal, absolute paths and separators', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b', '..', '.', '', 'a\0b']) {
    assert.throws(() => resolveRecordingPath(bad, DIR), /invalid recording name/i,
      `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('rejects non-strings', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => resolveRecordingPath(bad, DIR), /invalid recording name/i);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recordings.test.js`
Expected: FAIL — `Cannot find module '../src/main/recordings'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/main/recordings.js
'use strict';
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const RECORDINGS_DIR = path.join(os.homedir(), 'Konnect', 'recordings');

// The renderer asks for a recording by BASENAME only. recording_path comes out
// of the database, so treating it as a filesystem path without a guard is a
// traversal sink. Three independent checks: it must be a string, it must be
// its own basename (kills separators, absolute paths and ../x), and it must
// still resolve inside the directory (kills bare ".." and ".", whose basename
// is themselves).
function resolveRecordingPath(name, dir = RECORDINGS_DIR) {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) {
    throw new Error('invalid recording name');
  }
  if (name !== path.basename(name)) throw new Error('invalid recording name');
  const full = path.resolve(dir, name);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('invalid recording name');
  }
  return full;
}

// The filename lives in the URL PATH, never the host. Registering the scheme
// as `standard` - required for the range requests <audio> needs to seek -
// makes Chromium canonicalize the URL before the handler ever sees it: the
// host is ASCII-lowercased and gains a trailing slash, which destroys the
// uppercase hex a recording basename carries from the handset MAC. Path
// components survive canonicalization intact, so konnect-rec://rec/<name>
// round-trips exactly.
function nameFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function registerRecordingProtocol({ protocol, net, dir = RECORDINGS_DIR }) {
  protocol.handle('konnect-rec', (request) => {
    let full;
    try {
      full = resolveRecordingPath(nameFromUrl(request.url), dir);
    } catch {
      return new Response('bad recording name', { status: 400 });
    }
    // net.fetch on a file URL gives range-request support, which <audio>
    // needs to seek, and a correct Content-Type - both of which a hand-rolled
    // stream Response would have to reimplement.
    return net.fetch(pathToFileURL(full).toString());
  });
}

module.exports = {
  RECORDINGS_DIR, resolveRecordingPath, nameFromUrl, registerRecordingProtocol,
};
```

- [ ] **Step 4: Add the URL-parsing test and run the whole file**

```js
// append to test/recordings.test.js
const { nameFromUrl } = require('../src/main/recordings');

test('nameFromUrl preserves uppercase and decodes percent-escapes', () => {
  assert.strictEqual(
    nameFromUrl('konnect-rec://rec/1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34.opus'),
    '1788278920104-z_hci0_dev_44_CD_0E_AD_5E_34.opus');
  assert.strictEqual(nameFromUrl('konnect-rec://rec/a%20b.opus'), 'a b.opus');
});

// Regression guard. The first attempt put the filename in the HOST component,
// where Chromium lowercased it and appended a trailing slash before the
// handler ran - so every real request 400'd while unit tests built from
// hand-written URL strings stayed green.
test('the name comes from the path, never the host', () => {
  assert.strictEqual(nameFromUrl('konnect-rec://rec/AbC.opus'), 'AbC.opus');
  assert.strictEqual(nameFromUrl('konnect-rec://rec/X.opus').includes('/'), false);
});

test('a traversal attempt through the URL is rejected by the guard', () => {
  assert.throws(
    () => resolveRecordingPath(nameFromUrl('konnect-rec://rec/..%2F..%2Fetc%2Fpasswd'), DIR),
    /invalid recording name/i);
});
```

Run: `node --test test/recordings.test.js`
Expected: PASS, all tests

- [ ] **Step 5: Register the scheme and protocol in main**

In `src/main/index.js`, add near the top imports:

```js
const { protocol, net } = require('electron');
const { registerRecordingProtocol } = require('./recordings');
```

Immediately after the `require` block, **before** `app.whenReady()` — `registerSchemesAsPrivileged` must run before the app is ready:

```js
// `stream: true` is what lets <audio> issue range requests against this
// scheme; without it seeking a recording silently does nothing. `standard:
// true` is required alongside it, and is why the filename must travel in the
// URL path - see nameFromUrl in recordings.js.
protocol.registerSchemesAsPrivileged([{
  scheme: 'konnect-rec',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);
```

Inside the `app.whenReady()` handler, before the window is created:

```js
registerRecordingProtocol({ protocol, net });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — previous 128 tests plus the new ones

- [ ] **Step 7: Commit**

```bash
git add src/main/recordings.js test/recordings.test.js src/main/index.js
git commit -m "feat: serve call recordings over a guarded konnect-rec:// protocol"
```

---

### Task 2: Recording playback in the call log

**Files:**
- Modify: `src/renderer/app.js` (the `renderCalls` row loop, currently `src/renderer/app.js:397-412`)
- Modify: `src/renderer/index.html` (no structural change needed — the `Recording` column already exists)
- Modify: `src/renderer/styles.css`
- Modify: `src/main/ipc.js`, `src/main/preload.js`

**Interfaces:**
- Consumes: `konnect-rec://<basename>` from Task 1
- Produces: `window.konnect.revealRecording(pathString)`

- [ ] **Step 1: Add the reveal channel to main**

In `src/main/ipc.js`, add `shell` to the electron import and add one handler beside the other `recording`-free entries:

```js
const { ipcMain, dialog, shell } = require('electron');
```

```js
    // Reveal, not open: showItemInFolder selects the file in the file manager
    // rather than handing it to whatever application claims .opus, which on a
    // bare system is nothing at all.
    'recording:reveal': (_e, filePath) => {
      shell.showItemInFolder(filePath);
      return true;
    },
```

In `src/main/preload.js`, mirror it:

```js
  revealRecording: (p) => ipcRenderer.invoke('recording:reveal', p),
```

- [ ] **Step 2: Replace the Recording cell with a play control**

In `src/renderer/app.js`, replace the row-building loop inside `renderCalls`. The current loop builds six `td`s from a flat array; the recording cell now needs its own element, so build the first five from the array and append the sixth separately:

```js
  const body = $('#calls-body');
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
```

Add above `renderCalls`:

```js
// Only one player is open at a time: several <audio> elements decoding at
// once is noise, and the row that is playing should be unambiguous.
let openPlayerRow = null;

function recordingCell(row) {
  const td = document.createElement('td');
  if (!row.recording_path) {
    td.textContent = '-';
    return td;
  }

  const play = document.createElement('button');
  play.className = 'link';
  play.textContent = 'Play';

  const reveal = document.createElement('button');
  reveal.className = 'link';
  reveal.textContent = 'Folder';
  reveal.addEventListener('click', () => {
    window.konnect.revealRecording(row.recording_path).catch(() => {});
  });

  play.addEventListener('click', () => {
    if (openPlayerRow && openPlayerRow !== td) {
      openPlayerRow.querySelector('audio')?.remove();
      const other = openPlayerRow.querySelector('button.link');
      if (other) other.textContent = 'Play';
    }
    const existing = td.querySelector('audio');
    if (existing) {
      existing.remove();
      play.textContent = 'Play';
      openPlayerRow = null;
      return;
    }
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    // basename only: the protocol handler re-validates, but sending the full
    // path would make the renderer the thing that decides what main opens.
    // The name goes in the PATH: Chromium lowercases a custom scheme's host
    // during canonicalization, which would corrupt the uppercase hex in a
    // recording basename before the protocol handler ever ran.
    audio.src = `konnect-rec://rec/${encodeURIComponent(basename(row.recording_path))}`;
    // A recording whose file was deleted must say so rather than render a
    // dead player with no explanation.
    audio.addEventListener('error', () => {
      audio.remove();
      const gone = document.createElement('span');
      gone.className = 'muted';
      gone.textContent = 'Recording missing';
      td.append(gone);
      play.textContent = 'Play';
      openPlayerRow = null;
    }, { once: true });
    td.append(audio);
    play.textContent = 'Stop';
    openPlayerRow = td;
    audio.play().catch(() => {});
  });

  td.append(play, reveal);
  return td;
}

function basename(p) {
  return String(p).split('/').pop();
}
```

- [ ] **Step 3: Style the inline controls**

Append to `src/renderer/styles.css`:

```css
button.link {
  background: none;
  border: none;
  padding: 0 6px 0 0;
  color: #2d6cdf;
  cursor: pointer;
  font: inherit;
}
button.link:hover { text-decoration: underline; }
#calls-body audio { display: block; margin-top: 6px; width: 260px; height: 32px; }
```

- [ ] **Step 4: Verify against a real recording**

You have two real `.opus` files in `~/Konnect/recordings`. Launch with an isolated profile so the real database is untouched:

```bash
mkdir -p "$SCRATCH/electron-profile"
npx electron . --user-data-dir="$SCRATCH/electron-profile" > "$SCRATCH/app.log" 2>&1 &
```

Open **Call log**, press **Play** on a row that has a recording. Expected: audio plays, the seek bar moves, and dragging it seeks (this is what proves range support). Press **Play** on a second row: the first player closes.

Stop the app by explicit PID — `pgrep -f 'electron .' | head -1` then `kill <pid>`. **Do not use `pkill -f`**; it has matched the agent's own shell on this project.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/renderer/app.js src/renderer/styles.css src/main/ipc.js src/main/preload.js
git commit -m "feat: play call recordings inline from the call log"
```

---

### Task 3: Mac-parameterised setup checks

Removes the last hardcoded handset path. Until this lands, a device picker would run all four dependency checks against the F120B's modem no matter which device was chosen, and report green.

**Files:**
- Modify: `src/main/setup.js` (delete `MODEM_PATH` at line 5; change `CHECKS`, `runChecks`, `remediate`)
- Modify: `src/main/ipc.js` (pass `mac` into both)
- Test: `test/setup.test.js`

**Interfaces:**
- Consumes: `modemPathFor(mac)` from `src/main/backend/linux/bus.js`
- Produces: `runChecks({ exec, mac })`, `remediate(id, { exec, writeFile, mac })`; each `CHECKS` entry now has `detect(exec, mac)` and `manualCommand(mac)` (a **function**, previously a string)

- [ ] **Step 1: Write the failing tests**

Append to `test/setup.test.js`:

```js
const { modemPathFor } = require('../src/main/backend/linux/bus');

const OTHER_MAC = '30:BB:7D:21:99:DA';

test('the modem check probes the path of the mac it was given', async () => {
  const seen = [];
  const exec = async (cmd) => {
    seen.push(cmd);
    return { stdout: '"Online" b true', stderr: '' };
  };
  await runChecks({ exec, mac: OTHER_MAC });
  const probe = seen.find((c) => c.includes('org.ofono.Modem GetProperties'));
  assert.ok(probe.includes(modemPathFor(OTHER_MAC)),
    `expected ${modemPathFor(OTHER_MAC)} in: ${probe}`);
  assert.ok(!probe.includes('44_CD_0E_AD_5E_34'),
    'must not probe the hardcoded development handset');
});

test('a null mac fails the modem check instead of throwing', async () => {
  const exec = async () => ({ stdout: '', stderr: '' });
  const results = await runChecks({ exec, mac: null });
  const modem = results.find((r) => r.id === 'modem-online');
  assert.strictEqual(modem.ok, false);
  assert.match(modem.detail, /no handset selected/i);
});

test('the manual command for the modem check names the chosen mac', async () => {
  const exec = async () => { const e = new Error('nope'); e.code = 126; throw e; };
  const r = await remediate('modem-online', { exec, mac: OTHER_MAC });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
  assert.ok(r.command.includes(modemPathFor(OTHER_MAC)));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/setup.test.js`
Expected: FAIL — the probe still contains `44_CD_0E_AD_5E_34`, and `remediate` returns the old string command

- [ ] **Step 3: Rewrite the mac-dependent parts of `setup.js`**

Delete line 5 (`const MODEM_PATH = ...`). Add to the imports:

```js
const { modemPathFor } = require('./backend/linux/bus');
```

`bus.js` requires `dbus-next`, but `systemBus()` is lazy — nothing connects to a bus at require time, so `setup.test.js` keeps running without D-Bus.

Replace `MODEM_MANUAL_COMMAND` with a function:

```js
const modemManualCommand = (mac) =>
  `pkexec hciconfig hci0 class 0x240404 && \\\n  busctl --system call org.ofono ${modemPathFor(mac)} `
  + 'org.ofono.Modem SetProperty sv Powered b true';
```

Make every `manualCommand` a function of `mac` so there is one shape, not two:

```js
    manualCommand: () => 'pkexec apt install -y ofono',
```
```js
    manualCommand: () => 'pkexec systemctl enable --now ofono',
```
```js
    manualCommand: () => WIREPLUMBER_MANUAL_COMMAND,
```
```js
    manualCommand: modemManualCommand,
```

Change the `modem-online` check's `detect` to take the mac and to survive a null one:

```js
    async detect(exec, mac) {
      // mac === null is a real state: no handset has been chosen yet, and
      // modemPathFor(null) throws. Reporting the check as failed with a plain
      // reason is what the wizard needs; an exception here would abort every
      // remaining check.
      if (!mac) return { ok: false, detail: 'no handset selected' };
      const r = await ok(
        exec,
        `busctl --system call org.ofono ${modemPathFor(mac)} org.ofono.Modem GetProperties`);
      return { ok: r.ok && /"Online" b true/.test(r.detail), detail: r.detail };
    },
```

And its remedy:

```js
  async 'modem-online'({ exec, mac }) {
    if (!mac) throw new Error('no handset selected');
    await exec('pkexec hciconfig hci0 class 0x240404');
    await exec(
      `busctl --system call org.ofono ${modemPathFor(mac)} org.ofono.Modem SetProperty sv Powered b true`);
    return { ok: true, detail: 'class bootstrapped and modem powered' };
  },
```

Thread `mac` through both entry points:

```js
async function runChecks({ exec, mac }) {
  const out = [];
  for (const check of CHECKS) {
    const result = await check.detect(exec, mac);
    out.push({ id: check.id, label: check.label, ok: result.ok, detail: result.detail, remedy: check.remedy });
  }
  return out;
}
```

```js
// manualCommand is derived from the mac, and modemPathFor throws on a null or
// malformed one. Letting that throw escape from inside the catch below would
// turn a handled failure into an unhandled rejection and strip the caller of
// the very command string this function exists to hand back - most visibly
// when no handset has been chosen yet, which is the state the wizard runs in.
function safeManualCommand(check, mac) {
  if (!check) return null;
  try {
    return check.manualCommand(mac);
  } catch {
    return null;
  }
}

async function remediate(id, deps) {
  const fn = REMEDIES[id];
  if (!fn) throw new Error(`unknown remediation: ${id}`);
  const check = CHECKS.find((c) => c.id === id);
  try {
    return await fn(deps);
  } catch (err) {
    return {
      ok: false,
      reason: classifyFailure(err),
      detail: (err && err.message) || 'command failed',
      command: safeManualCommand(check, deps.mac),
    };
  }
}
```

Update the export list — `MODEM_PATH` was never exported, so only the removal of the constant matters.

**This interface change breaks four pre-existing tests in `test/setup.test.js`** that call `runChecks({exec})` without a mac or read `manualCommand` as a string. Amend them to pass a mac and to call `manualCommand(mac)`. Do not weaken any assertion to make them pass — each must still exercise the code path it originally exercised.

- [ ] **Step 4: Update the IPC call sites**

In `src/main/ipc.js`, `registerIpc` gains a `getMac` parameter so the handlers read the *current* mac rather than closing over a startup value:

```js
function registerIpc({
  backend, store, broadcast, hasLiveCall = () => false, liveCalls = () => [],
  getMac = () => null,
}) {
```
```js
    'setup:check': () => runChecks({ exec, mac: getMac() }),
    'setup:remediate': (_e, id) => remediate(id, { exec, writeFile, mac: getMac() }),
```

In `src/main/index.js`, add a module-level binding beside the other top-level
`let` declarations (`win`, `tray`, `backend`, …):

```js
// The mac the backend is actually bound to. NOT the same as the `device_mac`
// setting: Task 4 deliberately leaves that setting unset on first run so the
// wizard triggers, while the backend may already be bound to a device
// resolved from BlueZ. Reading the setting here would make the Setup checks
// report "no handset selected" on a connected, working app.
let boundMac = null;
```

Set it where the handset address is resolved today (the block around
`src/main/index.js:166-171`), immediately before `registerIpc` is called:

```js
  boundMac = store.getSetting('device_mac');
```

and pass the reader:

```js
    getMac: () => boundMac,
```

Task 4 replaces the assignment above with the resolved bootstrap mac; the
`getMac` reader itself does not change again.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — including the three new setup tests

- [ ] **Step 6: Commit**

```bash
git add src/main/setup.js src/main/ipc.js src/main/index.js test/setup.test.js
git commit -m "fix: setup checks probed a hardcoded handset path regardless of device"
```

---
### Task 4: Bootstrap device selection and a null-handset backend

Deletes the two hardcoded copies of the developer's own BD_ADDR and makes "no phone paired" a supported state rather than a crash. The selection rule is a pure function so it can be tested without BlueZ.

**Files:**
- Create: `src/main/device-select.js`
- Test: `test/device-select.test.js`
- Modify: `src/main/backend/linux/index.js` (delete `DEFAULT_MAC` at line 8; tolerate `mac === null`)
- Modify: `src/main/backend/index.js` (stop swallowing a null mac)
- Modify: `src/main/index.js` (delete `DEFAULT_DEVICE_MAC` at line 11; resolve at startup)

**Interfaces:**
- Consumes: `backend.listDevices()` → `[{ mac, name, paired, connected }]`
- Produces: `pickBootstrapMac(storedMac, devices) -> string | null`

- [ ] **Step 1: Write the failing test**

```js
// test/device-select.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pickBootstrapMac } = require('../src/main/device-select');

const F120B = { mac: '44:CD:0E:AD:5E:34', name: 'F120B', paired: true, connected: false };
const ONEPLUS = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', paired: true, connected: true };
const UNPAIRED = { mac: 'AA:BB:CC:DD:EE:FF', name: 'Random', paired: false, connected: true };

test('a stored mac always wins, even over a connected device', () => {
  assert.strictEqual(pickBootstrapMac(F120B.mac, [ONEPLUS, F120B]), F120B.mac);
});

test('a stored mac wins even when that device is not currently present', () => {
  assert.strictEqual(pickBootstrapMac('11:22:33:44:55:66', [ONEPLUS]), '11:22:33:44:55:66');
});

test('with no stored mac, prefers a connected paired device', () => {
  assert.strictEqual(pickBootstrapMac(null, [F120B, ONEPLUS]), ONEPLUS.mac);
});

test('with no stored mac and none connected, takes the first paired device', () => {
  assert.strictEqual(pickBootstrapMac(null, [F120B]), F120B.mac);
});

test('never picks an unpaired device', () => {
  assert.strictEqual(pickBootstrapMac(null, [UNPAIRED]), null);
});

test('returns null when there is nothing to pick', () => {
  assert.strictEqual(pickBootstrapMac(null, []), null);
  assert.strictEqual(pickBootstrapMac(null, undefined), null);
  assert.strictEqual(pickBootstrapMac('', []), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/device-select.test.js`
Expected: FAIL — `Cannot find module '../src/main/device-select'`

- [ ] **Step 3: Implement**

```js
// src/main/device-select.js
'use strict';

// Which handset Konnect binds to when `device_mac` has never been set.
// Pure so the rule is testable without BlueZ; index.js supplies the device
// list. An unpaired device is never a candidate: HFP needs a bond, so
// picking one would produce a backend that can never connect.
function pickBootstrapMac(storedMac, devices) {
  if (storedMac) return storedMac;
  const paired = (devices || []).filter((d) => d && d.paired);
  const connected = paired.find((d) => d.connected);
  return (connected || paired[0] || {}).mac || null;
}

module.exports = { pickBootstrapMac };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/device-select.test.js`
Expected: PASS

- [ ] **Step 5: Make the Linux backend tolerate a null mac**

In `src/main/backend/linux/index.js`, delete `const DEFAULT_MAC = '44:CD:0E:AD:5E:34';` (line 8) and change the signature and opening of `createLinuxBackend`:

```js
function createLinuxBackend({ mac = null } = {}) {
  // mac === null is a real state: nothing is paired, or the user has not
  // chosen yet. Every path helper throws on a null mac by design, so build a
  // backend that answers honestly instead of constructing D-Bus proxies for
  // a device that does not exist. listDevices still works - it is how the
  // wizard populates its picker.
  if (!mac) return createUnboundBackend();

  const device = createDeviceMonitor({ mac });
  // ...unchanged from here
```

Add above `createLinuxBackend`:

```js
const NO_HANDSET = 'No handset selected';

function createUnboundBackend() {
  const statusEmitter = createEmitter();
  const reject = async () => { throw new Error(NO_HANDSET); };
  return {
    // The one capability that must still work with no device bound.
    listDevices: () => createDeviceMonitor.listDevicesUnbound(),
    connect: reject,
    disconnect: reject,
    async getStatus() {
      return {
        connected: false, model: null, battery: null, signal: null,
        operator: null, roaming: false, error: NO_HANDSET,
      };
    },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },
    dial: reject, answer: reject, hangup: reject, sendDtmf: reject,
    onCall() { return () => {}; },
    startContactImport: reject, cancelContactImport: async () => {},
    onContacts() { return () => {}; },
    startRecording: reject, stopRecording: async () => null,
    verifyLink: async () => ({ ok: false, reason: NO_HANDSET, checks: [] }),
    getCallVolume: async () => ({ speaker: null, microphone: null, muted: false, error: NO_HANDSET }),
    setCallVolume: reject,
    onCallVolume() { return () => {}; },
    async ensureOnline() { throw new Error(NO_HANDSET); },
    dispose() { return Promise.resolve(); },
  };
}
```

In `src/main/backend/linux/device.js`, expose a mac-free device listing so the unbound backend can populate the wizard. Add at module scope, and attach it to the factory:

```js
// listDevices needs no device path - it walks BlueZ's whole object tree - so
// it must remain reachable when no handset is bound. Without this the wizard
// could never show a list on a machine that has never chosen a device.
async function listDevicesUnbound(getInterfaceFn = getInterface, systemBusFn = systemBus) {
  const bus = systemBusFn();
  const om = await getInterfaceFn(bus, BLUEZ, '/', 'org.freedesktop.DBus.ObjectManager');
  const objects = await om.GetManagedObjects();
  const out = [];
  for (const ifaces of Object.values(objects)) {
    const d = ifaces['org.bluez.Device1'];
    if (!d) continue;
    const p = unwrap(d);
    out.push({
      mac: p.Address, name: p.Alias || p.Name || p.Address,
      paired: Boolean(p.Paired), connected: Boolean(p.Connected),
    });
  }
  return out;
}
createDeviceMonitor.listDevicesUnbound = listDevicesUnbound;
```

Then make the bound backend's `listDevices` delegate to it so there is one implementation:

```js
    listDevices() { return listDevicesUnbound(getInterfaceFn, systemBusFn); },
```

- [ ] **Step 6: Stop `createBackend` from discarding a null mac**

In `src/main/backend/index.js`:

```js
    // Pass mac through even when null - `{}` would fall back to a default
    // that no longer exists, and silently binding to some other handset is
    // exactly what this change removes.
    return createLinuxBackend({ mac: mac ?? null });
```

- [ ] **Step 7: Resolve the mac at startup**

In `src/main/index.js`, delete `const DEFAULT_DEVICE_MAC = '44:CD:0E:AD:5E:34';` (line 11). Replace the block at lines 166-171 that seeds the setting:

```js
  // Resolve which handset to bind to BEFORE constructing the real backend.
  // An unbound backend is used purely to ask BlueZ what exists; it holds no
  // listeners and needs no dispose.
  const mock = process.env.KONNECT_MOCK === '1';
  const probe = createBackend({ mock, mac: null });
  const devices = await probe.listDevices().catch(() => []);
  const mac = pickBootstrapMac(store.getSetting('device_mac'), devices);
  // Replaces Task 3's `boundMac = store.getSetting('device_mac')`. The Setup
  // checks must probe the device the backend actually bound to, which on a
  // first run is a device BlueZ reported rather than anything persisted.
  boundMac = mac;
  backend = createBackend({ mock, mac });
  // The one line that makes a wrong binding diagnosable. Without it, "Konnect
  // is talking to the wrong phone" and "Konnect found no phone" look identical
  // from the outside.
  console.log('[konnect] bound to handset:', mac || '(none - no phone paired)');
```

**Preserve the existing `KONNECT_MOCK=1` handling** — the block being replaced reads
that environment variable, and both `createBackend` calls above must keep receiving
`mock`. Dropping it would silently disable the mock backend that drives the renderer
with no hardware attached.

Add the import:

```js
const { pickBootstrapMac } = require('./device-select');
```

**Do not** write `device_mac` here. An unset setting is what tells the wizard this is a first run; persisting the bootstrap guess would suppress it.

- [ ] **Step 8: Add the contract methods**

In `src/main/backend/interface.js`, extend `BACKEND_METHODS`:

```js
const BACKEND_METHODS = [
  'listDevices', 'connect', 'disconnect', 'getStatus', 'onDeviceStatus',
  'dial', 'answer', 'hangup', 'sendDtmf', 'onCall',
  'startContactImport', 'cancelContactImport', 'onContacts',
  'startRecording', 'stopRecording',
  'verifyLink', 'getCallVolume', 'setCallVolume', 'onCallVolume',
];
```

The Windows backend generates its stubs from this list, so it needs no change. Add to `src/main/backend/mock/index.js`'s returned object:

```js
    async verifyLink() {
      return { ok: true, reason: null, checks: [
        { label: 'Modem online', ok: true },
        { label: 'Telephony available', ok: true },
        { label: 'Call volume readable', ok: true },
      ] };
    },
    async getCallVolume() { return { speaker: 50, microphone: 50, muted: false, error: null }; },
    async setCallVolume() {},
    onCallVolume() { return () => {}; },
```

The real `verifyLink`, `getCallVolume`, `setCallVolume` and `onCallVolume` land in Tasks 5 and 11; until then the Linux bound backend needs matching placeholders so the contract test passes. Add to `src/main/backend/linux/index.js`'s `api` object:

```js
    verifyLink: () => telephony.verifyLink(),
    getCallVolume: () => telephony.getCallVolume(),
    setCallVolume: (patch) => telephony.setCallVolume(patch),
    onCallVolume: (cb) => telephony.onCallVolume(cb),
```

- [ ] **Step 9: Run the full suite and commit**

Run: `npm test`
Expected: PASS. The contract test in `test/backend.test.js` now checks four more methods on the mock.

```bash
git add src/main/device-select.js test/device-select.test.js src/main/backend/ src/main/index.js
git commit -m "feat: resolve the bound handset at startup instead of hardcoding one"
```

---

### Task 5: Device IPC and read-only link verification

**Files:**
- Modify: `src/main/backend/linux/telephony.js` (add `verifyLink`)
- Modify: `src/main/ipc.js`, `src/main/preload.js`
- Test: `test/telephony-helpers.test.js`

**Interfaces:**
- Consumes: `pickBootstrapMac` (Task 4), `runChecks({exec, mac})` (Task 3)
- Produces: `window.konnect.listDevices()`, `.connectDevice(mac)`, `.selectDevice(mac)`, `.verifyLink()`

- [ ] **Step 1: Write the failing test for `verifyLink`**

The existing `test/telephony-helpers.test.js` already builds a fake D-Bus interface registry — reuse that harness. Append:

```js
test('verifyLink reports each read separately and never dials', async () => {
  const calls = [];
  const registry = new Map();
  registry.set(`${modemPathFor(MAC)}|org.ofono.Modem`, {
    async GetProperties() {
      calls.push('modem');
      return {
        Online: { value: true },
        Interfaces: { value: ['org.ofono.VoiceCallManager', 'org.ofono.CallVolume'] },
      };
    },
  });
  registry.set(`${modemPathFor(MAC)}|org.ofono.CallVolume`, {
    async GetProperties() {
      calls.push('callvolume');
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 50 }, Muted: { value: false } };
    },
  });
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async (_bus, _svc, path, iface) => {
      const found = registry.get(`${path}|${iface}`);
      if (!found) throw new Error(`No such interface '${iface}'`);
      return found;
    },
    systemBusFn: () => ({}),
  });

  const result = await t.verifyLink();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.checks.map((c) => c.ok), [true, true, true]);
  assert.ok(!calls.includes('dial'), 'verifyLink must never dial');
});

test('verifyLink reports a partial failure without throwing', async () => {
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async () => ({ async GetProperties() { return { Online: { value: false }, Interfaces: { value: [] } }; } }),
    systemBusFn: () => ({}),
  });
  const result = await t.verifyLink();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.checks[0].ok, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/telephony-helpers.test.js`
Expected: FAIL — `t.verifyLink is not a function`

- [ ] **Step 3: Implement `verifyLink` in `telephony.js`**

Add inside the object returned by `createTelephony`:

```js
    // Read-only. Three GetProperties calls, no state change, and above all no
    // Dial: a wizard that rings the handset to prove the handset can ring is
    // not an acceptable test.
    async verifyLink() {
      const checks = [];
      let modem = null;
      try {
        const m = await iface(modemPath, 'org.ofono.Modem');
        modem = unwrap(await m.GetProperties());
        checks.push({ label: 'Handset modem is online', ok: modem.Online === true });
      } catch (err) {
        checks.push({ label: 'Handset modem is online', ok: false, detail: describeDBusError(err) });
      }
      const ifaces = (modem && modem.Interfaces) || [];
      checks.push({
        label: 'Telephony interface present',
        ok: ifaces.includes('org.ofono.VoiceCallManager'),
      });
      try {
        const cv = await iface(modemPath, 'org.ofono.CallVolume');
        await cv.GetProperties();
        checks.push({ label: 'Call volume readable', ok: true });
      } catch (err) {
        checks.push({ label: 'Call volume readable', ok: false, detail: describeDBusError(err) });
      }
      const failed = checks.find((c) => !c.ok);
      return { ok: !failed, reason: failed ? failed.label : null, checks };
    },
```

Export nothing new — `verifyLink` is reached through the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/telephony-helpers.test.js`
Expected: PASS

- [ ] **Step 5: Add the IPC channels**

In `src/main/ipc.js`, `registerIpc` gains one more parameter and four handlers:

```js
function registerIpc({
  backend, store, broadcast, hasLiveCall = () => false, liveCalls = () => [],
  getMac = () => null, selectDevice = async () => ({ relaunching: false }),
}) {
```

```js
    'devices:list': () => backend.listDevices(),
    'devices:connect': (_e, mac) => backend.connect(mac),
    'devices:disconnect': () => backend.disconnect(),
    // Persisting the choice and deciding whether to relaunch belongs to main,
    // not the renderer: the renderer cannot restart the process, and a
    // renderer that wrote device_mac directly could leave the running backend
    // bound to a different handset than the setting claims.
    'device:select': (_e, mac) => selectDevice(mac),
    'device:verify': () => backend.verifyLink(),
```

In `src/main/preload.js`:

```js
  listDevices: () => ipcRenderer.invoke('devices:list'),
  connectDevice: (mac) => ipcRenderer.invoke('devices:connect', mac),
  disconnectDevice: () => ipcRenderer.invoke('devices:disconnect'),
  selectDevice: (mac) => ipcRenderer.invoke('device:select', mac),
  verifyLink: () => ipcRenderer.invoke('device:verify'),
```

- [ ] **Step 6: Implement `selectDevice` in main**

In `src/main/index.js`, above the `registerIpc` call:

```js
// Changing the bound handset relaunches rather than rebuilding the backend in
// place. The backend threads `mac` into four long-lived subsystems, and a
// hot-swap would add a teardown path that runs almost never - a leaked D-Bus
// listener there is invisible until status updates silently stop. A relaunch
// is the most exercised path in the application. See spec section 3.1.
async function selectDevice(newMac) {
  const current = store.getSetting('device_mac');
  store.setSetting('device_mac', newMac);
  if (current === newMac) return { relaunching: false };
  app.relaunch();
  app.exit(0);
  return { relaunching: true };
}
```

Pass it in:

```js
    selectDevice,
```

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/main/backend/linux/telephony.js src/main/ipc.js src/main/preload.js src/main/index.js test/telephony-helpers.test.js
git commit -m "feat: device listing, selection and read-only link verification over IPC"
```

---

### Task 6: Renderer split and Settings shell

`src/renderer/app.js` is 555 lines and the wizard plus settings add roughly 350. ES modules do not load from a `file://` origin under `webSecurity`, so the split is plain `<script>` files sharing globals — no bundler, no dependency.

**Files:**
- Create: `src/renderer/settings.js`, `src/renderer/wizard.js`
- Modify: `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`

**Interfaces:**
- Produces: globals `showView(name)` and `$(sel)` from `app.js`; `renderSettings()` from `settings.js`; `openWizard(opts)` from `wizard.js`

- [ ] **Step 1: Add the Settings tab and script tags**

In `src/renderer/index.html`, add a nav button after `Setup`:

```html
    <button data-view="settings">Settings</button>
```

Add the section after `view-setup`:

```html
    <section id="view-settings" class="view">
      <h1>Settings</h1>

      <fieldset><legend>Device</legend>
        <p class="v" id="set-device">-</p>
        <button id="set-change-device">Change handset</button>
      </fieldset>

      <fieldset><legend>Audio devices</legend><div id="set-audio"></div></fieldset>
      <fieldset><legend>Volume</legend><div id="set-volume"></div></fieldset>
      <fieldset><legend>Ringtone</legend><div id="set-ring"></div></fieldset>

      <fieldset><legend>Recording</legend>
        <label><input type="checkbox" id="s-record"> Record calls</label>
        <p class="muted">
          Saved to ~/Konnect/recordings and linked to the call log. Remote
          audio on the left channel, your microphone on the right.
        </p>
      </fieldset>

      <fieldset><legend>Startup</legend><div id="set-startup"></div></fieldset>
    </section>

    <div id="wizard" class="modal" hidden><div class="modal-box" id="wizard-box"></div></div>
```

Replace the single script tag with three, in dependency order — `app.js` defines `$` and `showView`, which the other two use:

```html
  <script src="app.js"></script>
  <script src="settings.js"></script>
  <script src="wizard.js"></script>
```

- [ ] **Step 2: Move the record toggle out of Status**

Delete the entire `<div class="setting">…</div>` block from `#view-status` in `index.html` — its markup was reproduced inside the new `Recording` fieldset in Step 1, so the `#s-record` handler in `app.js` keeps working unchanged with no JavaScript edit.

This is why no task touches `record_calls`, `loadRecordSetting()` or `recordCalls` in `app.js`: `$('#s-record')` still resolves because the element moved rather than being replaced. **Verify this rather than assuming it** — after the move, toggle `Record calls` in Settings, reopen the app, and confirm the checkbox comes back in the state you left it. A silently dead toggle here would mean recording quietly stops working.

- [ ] **Step 3: Wire the tab**

In `src/renderer/app.js`, extend the nav click handler:

```js
    if (b.dataset.view === 'calls') renderCalls();
    if (b.dataset.view === 'contacts') loadContacts();
    if (b.dataset.view === 'settings') renderSettings();
```

- [ ] **Step 4: Create the two new files as working stubs**

```js
// src/renderer/settings.js
'use strict';

// Populated task by task: audio devices, volume, ringtone and startup each
// own one section. Sections render independently so one failing subsystem
// cannot blank the whole page.
async function renderSettings() {
  const mac = await window.konnect.getSetting('device_mac');
  const devices = await window.konnect.listDevices().catch(() => []);
  const bound = devices.find((d) => d.mac === mac);
  $('#set-device').textContent = mac
    ? `${bound ? bound.name : 'Unknown device'} (${mac})`
    : 'No handset selected';
}

$('#set-change-device').addEventListener('click', () => openWizard({ startStep: 2 }));
```

```js
// src/renderer/wizard.js
'use strict';

const WIZARD_STEPS = ['Welcome', 'Device', 'Checks', 'Done'];
let wizardStep = 1;
let wizardMac = null;

function openWizard({ startStep = 1 } = {}) {
  wizardStep = startStep;
  $('#wizard').hidden = false;
  renderWizard();
}

function closeWizard() {
  $('#wizard').hidden = true;
}

function renderWizard() {
  const box = $('#wizard-box');
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = `${WIZARD_STEPS[wizardStep - 1]} — step ${wizardStep} of 4`;
  box.append(h);
}
```

- [ ] **Step 5: Style the modal and fieldsets**

Append to `src/renderer/styles.css`:

```css
fieldset { border: 1px solid #d8d8d8; border-radius: 6px; margin: 0 0 16px; padding: 12px 16px; }
legend { font-weight: 600; padding: 0 6px; }
.modal {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal-box {
  background: #fff; border-radius: 8px; padding: 24px;
  width: 520px; max-height: 80vh; overflow-y: auto;
}
.steps { display: flex; gap: 8px; margin-bottom: 16px; }
.steps span { flex: 1; height: 4px; background: #ddd; border-radius: 2px; }
.steps span.done { background: #2d6cdf; }
```

- [ ] **Step 6: Verify and commit**

Launch with an isolated profile, click through every nav tab, confirm Settings renders the bound device and that `Record calls` still toggles and persists. Kill by explicit PID.

```bash
npm test
git add src/renderer/
git commit -m "feat: settings view shell and renderer script split"
```

---

### Task 7: The onboarding wizard

**Files:**
- Modify: `src/renderer/wizard.js`, `src/renderer/app.js`

**Interfaces:**
- Consumes: `listDevices()`, `selectDevice(mac)`, `verifyLink()`, `runSetupChecks()`, `remediate(id)`
- Produces: `openWizard({ startStep, blocking })`

- [ ] **Step 1: Replace `renderWizard` with the full four-step flow**

```js
// src/renderer/wizard.js
'use strict';

const WIZARD_STEPS = ['Welcome', 'Device', 'Checks', 'Done'];
let wizardStep = 1;
let wizardMac = null;
let wizardBlocking = false;

function openWizard({ startStep = 1, blocking = false } = {}) {
  wizardStep = startStep;
  wizardBlocking = blocking;
  $('#wizard').hidden = false;
  renderWizard();
}

function closeWizard() {
  // Blocking means there is no handset at all; dismissing would leave an app
  // whose every action rejects with "No handset selected" and no way back.
  if (wizardBlocking) return;
  $('#wizard').hidden = true;
}

function stepBar() {
  const bar = document.createElement('div');
  bar.className = 'steps';
  for (let i = 1; i <= WIZARD_STEPS.length; i += 1) {
    const s = document.createElement('span');
    if (i <= wizardStep) s.className = 'done';
    bar.append(s);
  }
  return bar;
}

function navRow({ back, next, nextLabel = 'Next', nextEnabled = true }) {
  const row = document.createElement('div');
  row.className = 'dial-actions';
  if (back) {
    const b = document.createElement('button');
    b.textContent = 'Back';
    b.addEventListener('click', back);
    row.append(b);
  }
  const n = document.createElement('button');
  n.className = 'primary';
  n.textContent = nextLabel;
  n.disabled = !nextEnabled;
  n.addEventListener('click', next);
  row.append(n);
  if (!wizardBlocking) {
    const c = document.createElement('button');
    c.textContent = 'Close';
    c.addEventListener('click', closeWizard);
    row.append(c);
  }
  return row;
}

function goto(step) { wizardStep = step; renderWizard(); }

async function renderWizard() {
  const box = $('#wizard-box');
  box.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = `${WIZARD_STEPS[wizardStep - 1]} — step ${wizardStep} of 4`;
  box.append(h, stepBar());

  if (wizardStep === 1) return renderWelcome(box);
  if (wizardStep === 2) return renderDevicePick(box);
  if (wizardStep === 3) return renderWizardChecks(box);
  return renderDone(box);
}

function renderWelcome(box) {
  const p = document.createElement('p');
  p.textContent =
    'Konnect connects to a phone that is already paired with this computer. '
    + 'It uses the phone’s Bluetooth hands-free profile to place and receive '
    + 'calls, read status, and receive contacts.';
  const p2 = document.createElement('p');
  p2.className = 'muted';
  p2.textContent = 'If your phone is not paired yet, pair it in your system Bluetooth settings first.';
  box.append(p, p2, navRow({ next: () => goto(2) }));
}

async function renderDevicePick(box) {
  const list = document.createElement('div');
  list.textContent = 'Loading devices…';
  box.append(list);

  let devices = [];
  try {
    devices = await window.konnect.listDevices();
  } catch (err) {
    list.textContent = `Could not read Bluetooth devices: ${err.message}`;
    box.append(navRow({ back: () => goto(1), next: () => goto(2), nextLabel: 'Retry' }));
    return;
  }

  // Paired first: an unpaired device cannot carry HFP, so offering it as an
  // equal choice invites a selection that can never connect.
  const paired = devices.filter((d) => d.paired)
    .sort((a, b) => Number(b.connected) - Number(a.connected));
  list.replaceChildren();

  if (paired.length === 0) {
    const none = document.createElement('p');
    none.textContent = 'No paired phones found.';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Pair your phone in your system Bluetooth settings, then press Refresh.';
    list.append(none, hint);
  }

  for (const d of paired) {
    const label = document.createElement('label');
    label.className = 'device-row';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'wizard-device';
    radio.value = d.mac;
    radio.checked = wizardMac ? wizardMac === d.mac : d.connected;
    radio.addEventListener('change', () => { wizardMac = d.mac; renderWizard(); });
    if (radio.checked) wizardMac = d.mac;
    const name = document.createElement('span');
    name.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${d.mac} · ${d.connected ? 'connected' : 'not connected'}`;
    label.append(radio, name, meta);
    list.append(label);
  }

  const refresh = document.createElement('button');
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => renderWizard());
  box.append(refresh, navRow({
    back: () => goto(1),
    next: () => goto(3),
    nextEnabled: Boolean(wizardMac),
  }));
}

async function renderWizardChecks(box) {
  const ul = document.createElement('ul');
  ul.id = 'wizard-checks';
  const loading = document.createElement('li');
  loading.className = 'muted';
  loading.textContent = 'Running…';
  ul.append(loading);
  box.append(ul);

  const results = await window.konnect.runSetupChecks();
  ul.replaceChildren();
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
      fix.addEventListener('click', async () => {
        fix.disabled = true;
        const res = await window.konnect.remediate(r.id);
        if (!res.ok) {
          const pre = document.createElement('pre');
          pre.textContent = `${res.detail}\n\nRun this by hand:\n${res.command || ''}`;
          li.append(pre);
        }
        fix.disabled = false;
        renderWizard();
      });
      li.append(fix);
    }
    ul.append(li);
  }

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent =
    'These checks run against the handset you selected. You can continue with '
    + 'failures, but calls will not work until they pass.';
  box.append(note, navRow({ back: () => goto(2), next: () => goto(4) }));
}

async function renderDone(box) {
  const ul = document.createElement('ul');
  box.append(ul);
  const result = await window.konnect.verifyLink().catch((err) => ({
    ok: false, reason: err.message, checks: [],
  }));
  for (const c of result.checks) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${c.ok ? 'ok' : 'bad'}`;
    const label = document.createElement('span');
    label.textContent = c.detail ? `${c.label} — ${c.detail}` : c.label;
    li.append(dot, label);
    ul.append(li);
  }

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent =
    'These are read-only checks. Konnect never places a call to test the link.';

  const finish = document.createElement('button');
  finish.className = 'primary';
  finish.textContent = 'Finish';
  finish.addEventListener('click', async () => {
    finish.disabled = true;
    const res = await window.konnect.selectDevice(wizardMac);
    if (res.relaunching) {
      box.replaceChildren();
      const p = document.createElement('p');
      p.textContent = 'Restarting to connect to the selected handset…';
      box.append(p);
      return;
    }
    wizardBlocking = false;
    closeWizard();
    renderSettings();
  });

  box.append(note, document.createElement('hr'), finish);
  if (!wizardBlocking) {
    const back = document.createElement('button');
    back.textContent = 'Back';
    back.addEventListener('click', () => goto(3));
    box.append(back);
  }
}
```

- [ ] **Step 2: Open the wizard automatically on first run**

Append to `src/renderer/wizard.js`:

```js
// Shown whenever device_mac is unset. Blocking only when there is genuinely
// no handset to bind to - if bootstrap resolution found a paired device the
// app is usable and the wizard is a suggestion, not a wall (spec 4.2).
(async () => {
  if (await window.konnect.getSetting('device_mac')) return;
  const status = await window.konnect.getStatus().catch(() => ({}));
  openWizard({ blocking: status.error === 'No handset selected' });
})();
```

- [ ] **Step 3: Style the device rows**

Append to `src/renderer/styles.css`:

```css
.device-row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 8px 0; }
#wizard-box pre { white-space: pre-wrap; background: #f4f4f4; padding: 8px; border-radius: 4px; font-size: 12px; }
```

- [ ] **Step 4: Verify against real hardware**

Launch with an isolated profile. The wizard should not appear (your `device_mac` is set). Open **Settings › Change handset**: the list must show **F120B** and **OnePlus 10R 5G** with correct connected badges. Step through to step 4 and confirm all three verification rows report against F120B.

**Select F120B (the device already bound) and press Finish** — expected: no relaunch, wizard closes. Do not select the OnePlus unless you intend the app to relaunch bound to it.

- [ ] **Step 5: Run the suite and commit**

```bash
npm test
git add src/renderer/
git commit -m "feat: four-step onboarding wizard for choosing the bound handset"
```

---

### Task 8: Autostart

**Files:**
- Create: `src/main/autostart.js`
- Test: `test/autostart.test.js`
- Modify: `src/main/ipc.js`, `src/main/preload.js`, `src/main/index.js`, `src/renderer/settings.js`

**Interfaces:**
- Produces: `desktopEntry({ execPath, args })`, `isEnabled()`, `enable({ execPath, args })`, `disable()`, `AUTOSTART_PATH`

- [ ] **Step 1: Write the failing test**

```js
// test/autostart.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-autostart-'));
process.env.HOME = tmpHome;
process.env.XDG_CONFIG_HOME = path.join(tmpHome, '.config');

const { desktopEntry, isEnabled, enable, disable, AUTOSTART_PATH } = require('../src/main/autostart');

test('the desktop entry is a valid autostart file that starts hidden', () => {
  const body = desktopEntry({ execPath: '/opt/konnect/konnect', args: ['--hidden'] });
  assert.match(body, /^\[Desktop Entry\]$/m);
  assert.match(body, /^Type=Application$/m);
  assert.match(body, /^Exec=\/opt\/konnect\/konnect --hidden$/m);
  assert.match(body, /^Terminal=false$/m);
  assert.match(body, /^X-GNOME-Autostart-enabled=true$/m);
});

test('a path containing spaces is quoted so Exec does not split it', () => {
  const body = desktopEntry({ execPath: '/home/a b/konnect', args: ['--hidden'] });
  assert.match(body, /^Exec="\/home\/a b\/konnect" --hidden$/m);
});

test('enable creates the file, isEnabled sees it, disable removes it', async () => {
  assert.strictEqual(isEnabled(), false);
  await enable({ execPath: '/opt/konnect/konnect', args: ['--hidden'] });
  assert.strictEqual(isEnabled(), true);
  assert.ok(fs.existsSync(AUTOSTART_PATH));
  await disable();
  assert.strictEqual(isEnabled(), false);
});

test('disable is idempotent when the file is already gone', async () => {
  await disable();
  await assert.doesNotReject(() => disable());
});

test('enable creates the autostart directory when it does not exist', async () => {
  fs.rmSync(path.dirname(AUTOSTART_PATH), { recursive: true, force: true });
  await enable({ execPath: '/opt/konnect/konnect', args: [] });
  assert.strictEqual(isEnabled(), true);
  await disable();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/autostart.test.js`
Expected: FAIL — `Cannot find module '../src/main/autostart'`

- [ ] **Step 3: Implement**

```js
// src/main/autostart.js
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// XDG_CONFIG_HOME is honoured because the tests set it, and because a user
// who has moved their config directory expects everything to follow.
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const AUTOSTART_PATH = path.join(CONFIG_HOME, 'autostart', 'konnect.desktop');

// The FILE is the single source of truth - there is deliberately no
// `autostart` settings key. Two records of one fact drift, and the one the
// checkbox shows would then disagree with the one the session actually reads.
// Desktop-entry Exec fields are whitespace-split, so any component holding a
// space silently becomes two arguments and the entry never launches. EVERY
// component needs this, not just execPath: in development `args` carries
// app.getAppPath(), a real filesystem path. Inside a quoted value the spec
// requires ", `, $ and \ to be backslash-escaped.
function quoteExecPart(part) {
  if (!/[\s"`$\\]/.test(part)) return part;
  return `"${part.replace(/(["`$\\])/g, '\\$1')}"`;
}

function desktopEntry({ execPath, args = [] }) {
  const exec = [execPath, ...args].map(quoteExecPart).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Konnect',
    'Comment=PC suite for JioPhone over Bluetooth',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function isEnabled() {
  return fs.existsSync(AUTOSTART_PATH);
}

async function enable({ execPath, args = [] }) {
  await fsp.mkdir(path.dirname(AUTOSTART_PATH), { recursive: true });
  await fsp.writeFile(AUTOSTART_PATH, desktopEntry({ execPath, args }), 'utf8');
}

async function disable() {
  await fsp.rm(AUTOSTART_PATH, { force: true });
}

module.exports = { AUTOSTART_PATH, desktopEntry, isEnabled, enable, disable };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/autostart.test.js`
Expected: PASS

- [ ] **Step 5: Wire IPC**

In `src/main/ipc.js` add the import and two handlers:

```js
const autostart = require('./autostart');
const { app } = require('electron');
```

```js
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
```

In `src/main/preload.js`:

```js
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
```

- [ ] **Step 6: Honour `--hidden` at startup**

In `src/main/index.js`, replace the `ready-to-show` handler in `createWindow`:

```js
  // --hidden comes from the autostart entry. Starting hidden is only safe
  // when a tray icon will actually appear; with no StatusNotifier host the
  // window would be unreachable except by kill - the same reasoning that
  // governs the close handler below.
  win.once('ready-to-show', () => {
    if (process.argv.includes('--hidden') && trayAvailable) return;
    win.show();
  });
```

- [ ] **Step 7: Render the Startup section**

Append to `src/renderer/settings.js`, and call it from `renderSettings`:

```js
async function renderStartup() {
  const host = $('#set-startup');
  host.replaceChildren();
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = await window.konnect.getAutostart();
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
```

Add `await renderStartup();` to the end of `renderSettings()`.

- [ ] **Step 8: Verify, then leave the machine as you found it**

Toggle the checkbox on, confirm `~/.config/autostart/konnect.desktop` exists and its `Exec` line is runnable, then **toggle it back off** unless you want Konnect starting at login. Confirm the file is gone.

- [ ] **Step 9: Run the suite and commit**

```bash
npm test
git add src/main/autostart.js test/autostart.test.js src/main/ipc.js src/main/preload.js src/main/index.js src/renderer/settings.js
git commit -m "feat: start Konnect at login via an XDG autostart entry"
```

---
### Task 9: Audio device enumeration

**Files:**
- Create: `src/main/backend/linux/audio.js`, `test/audio-helpers.test.js`, `test/fixtures/pw-dump.json`
- Modify: `src/main/backend/linux/index.js`, `src/main/ipc.js`, `src/main/preload.js`, `src/renderer/settings.js`

**Interfaces:**
- Produces: `parseNodes(dumpArray)`, `listAudioDevices()`, and the optional `backend.audio` namespace

`backend.audio` is deliberately **not** part of `BACKEND_METHODS`. PipeWire has no Windows equivalent, and stubbing `pw-play` into a cross-platform contract would claim a capability that will never exist there. IPC handlers check for the namespace and report a clear platform error when it is absent.

- [ ] **Step 1: Capture a real fixture**

```bash
mkdir -p test/fixtures
pw-dump > test/fixtures/pw-dump.json
node -e "const j=require('./test/fixtures/pw-dump.json');console.log('objects:',j.length)"
```

Expected: a non-empty array. This is real output from the target machine — do not hand-write it. Every defect on this project so far came from a data shape a test invented rather than observed.

- [ ] **Step 2: Write the failing test**

```js
// test/audio-helpers.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseNodes } = require('../src/main/backend/linux/audio');
const dump = require('./fixtures/pw-dump.json');

test('parseNodes finds sinks and sources in a real pw-dump', () => {
  const nodes = parseNodes(dump);
  assert.ok(nodes.length > 0, 'expected at least one audio node');
  assert.ok(nodes.some((n) => n.mediaClass === 'Audio/Sink'), 'expected a sink');
  assert.ok(nodes.some((n) => n.mediaClass === 'Audio/Source'), 'expected a source');
  for (const n of nodes) {
    assert.strictEqual(typeof n.id, 'number');
    assert.strictEqual(typeof n.name, 'string');
    assert.ok(n.name.length > 0);
    assert.strictEqual(typeof n.description, 'string');
  }
});

test('parseNodes ignores non-node objects and non-audio nodes', () => {
  const nodes = parseNodes([
    { id: 1, type: 'PipeWire:Interface:Port', info: { props: {} } },
    { id: 2, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Video/Source', 'node.name': 'cam' } } },
    { id: 3, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'ok' } } },
  ]);
  assert.deepStrictEqual(nodes.map((n) => n.id), [3]);
});

test('parseNodes falls back to node.name when there is no description', () => {
  const [n] = parseNodes([
    { id: 7, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Source', 'node.name': 'bare' } } },
  ]);
  assert.strictEqual(n.description, 'bare');
});

test('parseNodes survives malformed entries without throwing', () => {
  assert.deepStrictEqual(parseNodes([null, {}, { info: null }, 'nonsense']), []);
  assert.deepStrictEqual(parseNodes(null), []);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/audio-helpers.test.js`
Expected: FAIL — `Cannot find module '../src/main/backend/linux/audio'`

- [ ] **Step 4: Implement enumeration**

```js
// src/main/backend/linux/audio.js
'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// pw-dump emits one object per PipeWire global. Only Audio/Sink and
// Audio/Source nodes are selectable devices; everything else - ports, links,
// devices, video nodes - is noise here.
function parseNodes(dump) {
  const out = [];
  for (const obj of Array.isArray(dump) ? dump : []) {
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type !== 'PipeWire:Interface:Node') continue;
    const props = (obj.info && obj.info.props) || {};
    const mediaClass = props['media.class'];
    if (mediaClass !== 'Audio/Sink' && mediaClass !== 'Audio/Source') continue;
    const name = props['node.name'];
    if (typeof name !== 'string' || name === '') continue;
    out.push({
      id: obj.id,
      name,
      // node.description is the human label shown in Sound Settings;
      // node.name is the stable identifier we store and pass to pw-link.
      description: props['node.description'] || name,
      mediaClass,
    });
  }
  return out;
}

async function listAudioDevices() {
  const { stdout } = await execFileAsync('pw-dump', [], { maxBuffer: 32 * 1024 * 1024 });
  const nodes = parseNodes(JSON.parse(stdout));
  return {
    sinks: nodes.filter((n) => n.mediaClass === 'Audio/Sink'),
    sources: nodes.filter((n) => n.mediaClass === 'Audio/Source'),
  };
}

module.exports = { parseNodes, listAudioDevices };
```

`maxBuffer` is raised because `pw-dump` output runs to hundreds of kilobytes and the 1 MB default would truncate it into a JSON parse error on a busy system.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/audio-helpers.test.js`
Expected: PASS

- [ ] **Step 6: Expose the namespace and IPC**

In `src/main/backend/linux/index.js`, require the module and add to the `api` object (bound backend only — the unbound backend from Task 4 gets the same block, since enumeration needs no handset):

```js
const audio = require('./audio');
```
```js
    audio: {
      listAudioDevices: () => audio.listAudioDevices(),
    },
```

In `src/main/ipc.js`:

```js
// backend.audio is Linux-only by design; PipeWire has no Windows equivalent.
const needAudio = () => {
  if (!backend.audio) throw new Error('Audio control is not available on this platform');
  return backend.audio;
};
```
```js
    'audio:devices': () => needAudio().listAudioDevices(),
```

In `src/main/preload.js`:

```js
  listAudioDevices: () => ipcRenderer.invoke('audio:devices'),
```

- [ ] **Step 7: Render the Audio devices section**

Append to `src/renderer/settings.js` and call it from `renderSettings`:

```js
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

async function renderAudio() {
  const host = $('#set-audio');
  host.replaceChildren();

  let devices;
  try {
    devices = await window.konnect.listAudioDevices();
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Audio devices unavailable: ${err.message}`;
    host.append(p);
    return;
  }

  const [mode, sink, source] = await Promise.all([
    window.konnect.getSetting('audio_mode'),
    window.konnect.getSetting('audio_sink'),
    window.konnect.getSetting('audio_source'),
  ]);

  const modeRow = document.createElement('div');
  for (const [value, label] of [['konnect', "Use Konnect's own routing"], ['system', 'Follow system defaults']]) {
    const l = document.createElement('label');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'audio-mode';
    r.value = value;
    r.checked = (mode || 'system') === value;
    r.addEventListener('change', async () => {
      await window.konnect.setSetting('audio_mode', value);
      renderAudio();
    });
    const s = document.createElement('span');
    s.textContent = ` ${label} `;
    l.append(r, s);
    modeRow.append(l);
  }

  const outLabel = document.createElement('label');
  outLabel.textContent = 'Call audio plays through ';
  const outSel = deviceSelect('set-sink', devices.sinks, sink);
  outSel.addEventListener('change', async () => {
    await window.konnect.setSetting('audio_sink', outSel.value);
    // Choosing a device is the act that opts in to Konnect-owned routing;
    // the radio above always wins if the user says otherwise afterwards.
    if (outSel.value) await window.konnect.setSetting('audio_mode', 'konnect');
    renderAudio();
  });
  outLabel.append(outSel);

  const inLabel = document.createElement('label');
  inLabel.textContent = 'Microphone the caller hears ';
  const inSel = deviceSelect('set-source', devices.sources, source);
  inSel.addEventListener('change', async () => {
    await window.konnect.setSetting('audio_source', inSel.value);
    if (inSel.value) await window.konnect.setSetting('audio_mode', 'konnect');
    renderAudio();
  });
  inLabel.append(inSel);

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent =
    'Routing is applied when a call starts — the call audio devices do not '
    + 'exist until then, so this cannot be fully tested while the line is idle.';

  host.append(modeRow, outLabel, inLabel, note);
}
```

Add `await renderAudio();` to `renderSettings()`.

- [ ] **Step 8: Run the suite and commit**

```bash
npm test
git add src/main/backend/linux/audio.js test/audio-helpers.test.js test/fixtures/pw-dump.json src/main/ src/renderer/settings.js
git commit -m "feat: enumerate PipeWire sinks and sources for audio device selection"
```

---

### Task 10: PC-side volume

**Files:**
- Modify: `src/main/backend/linux/audio.js`, `src/main/backend/linux/index.js`, `src/main/ipc.js`, `src/main/preload.js`, `src/renderer/settings.js`
- Test: `test/audio-helpers.test.js`

**Interfaces:**
- Produces: `parseWpctlVolume(text)`, `getPcVolume(nodeName)`, `setPcVolume(nodeName, pct)`

- [ ] **Step 1: Write the failing test**

`wpctl get-volume` prints `Volume: 0.46` — and `Volume: 0.46 [MUTED]` when muted. Append to `test/audio-helpers.test.js`:

```js
const { parseWpctlVolume } = require('../src/main/backend/linux/audio');

test('parseWpctlVolume reads a plain volume line as a percentage', () => {
  assert.deepStrictEqual(parseWpctlVolume('Volume: 0.46\n'), { pct: 46, muted: false });
});

test('parseWpctlVolume detects the muted marker', () => {
  assert.deepStrictEqual(parseWpctlVolume('Volume: 0.62 [MUTED]\n'), { pct: 62, muted: true });
});

test('parseWpctlVolume handles a volume above 1.0 without clamping the reading', () => {
  assert.strictEqual(parseWpctlVolume('Volume: 1.40').pct, 140);
});

test('parseWpctlVolume returns null on unexpected output rather than guessing', () => {
  assert.strictEqual(parseWpctlVolume(''), null);
  assert.strictEqual(parseWpctlVolume('Node 51 not found'), null);
  assert.strictEqual(parseWpctlVolume(null), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/audio-helpers.test.js`
Expected: FAIL — `parseWpctlVolume is not a function`

- [ ] **Step 3: Implement**

Append to `src/main/backend/linux/audio.js` and add all three to the exports:

```js
// `wpctl get-volume <id>` prints "Volume: 0.46", or "Volume: 0.46 [MUTED]".
// Returning null rather than a default on unrecognised output matters: a
// slider silently showing 0 for a device that failed to read is a lie the
// user cannot see.
function parseWpctlVolume(text) {
  const m = /Volume:\s*([0-9]*\.?[0-9]+)/.exec(String(text || ''));
  if (!m) return null;
  return {
    pct: Math.round(Number(m[1]) * 100),
    muted: /\[MUTED\]/.test(String(text)),
  };
}

// wpctl addresses nodes by numeric id, and ids are not stable across
// restarts or device reconnects - so resolve the stored node.name to an id
// on every call rather than caching one.
async function nodeIdFor(nodeName) {
  const { sinks, sources } = await listAudioDevices();
  const found = [...sinks, ...sources].find((n) => n.name === nodeName);
  if (!found) throw new Error(`audio device not found: ${nodeName}`);
  return found.id;
}

async function getPcVolume(nodeName) {
  const { stdout } = await execFileAsync('wpctl', ['get-volume', String(await nodeIdFor(nodeName))]);
  return parseWpctlVolume(stdout);
}

async function setPcVolume(nodeName, pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  await execFileAsync('wpctl', ['set-volume', String(await nodeIdFor(nodeName)), `${clamped / 100}`]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/audio-helpers.test.js`
Expected: PASS

- [ ] **Step 5: Wire through the namespace and IPC**

In `src/main/backend/linux/index.js`, extend the `audio` namespace:

```js
      getPcVolume: (n) => audio.getPcVolume(n),
      setPcVolume: (n, p) => audio.setPcVolume(n, p),
```

In `src/main/ipc.js`:

```js
    'volume:pc:get': (_e, nodeName) => needAudio().getPcVolume(nodeName),
    'volume:pc:set': (_e, nodeName, pct) => needAudio().setPcVolume(nodeName, pct),
```

In `src/main/preload.js`:

```js
  getPcVolume: (n) => ipcRenderer.invoke('volume:pc:get', n),
  setPcVolume: (n, p) => ipcRenderer.invoke('volume:pc:set', n, p),
```

- [ ] **Step 6: Render the PC half of the Volume section**

Append to `src/renderer/settings.js`. The handset half arrives in Task 11; this renders only the `On this PC` group so the section is useful immediately.

```js
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

async function renderPcVolume(host) {
  const [sink, source] = await Promise.all([
    window.konnect.getSetting('audio_sink'),
    window.konnect.getSetting('audio_source'),
  ]);
  const group = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = 'On this PC';
  group.append(h);

  for (const [label, node, setter] of [
    ['Output', sink, window.konnect.setPcVolume],
    ['Input gain', source, window.konnect.setPcVolume],
  ]) {
    if (!node) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `${label}: choose a device above to control its level.`;
      group.append(p);
      continue;
    }
    const current = await window.konnect.getPcVolume(node).catch(() => null);
    group.append(volumeSlider({
      label, value: current ? current.pct : null,
      onChange: (v) => setter(node, v),
    }));
  }

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Only affects your side. The caller’s volume is unchanged.';
  group.append(note);
  host.append(group);
}
```

In `renderSettings()`, add:

```js
  const vol = $('#set-volume');
  vol.replaceChildren();
  await renderPcVolume(vol);
```

Append to `src/renderer/styles.css`:

```css
.vol-row { display: grid; grid-template-columns: 110px 1fr 40px; gap: 10px; align-items: center; padding: 4px 0; }
.vol-read { text-align: right; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 7: Run the suite and commit**

```bash
npm test
git add src/main/backend/linux/audio.js test/audio-helpers.test.js src/main/ src/renderer/
git commit -m "feat: PC-side output and input level control via wpctl"
```

---

### Task 11: Handset call volume over HFP

`org.ofono.CallVolume` was confirmed live on the handset: `SpeakerVolume y 50`, `MicrophoneVolume y 50`, `Muted b false`. Values are D-Bus `y` (uint8) — the marshalling is pinned by a test because this project has already shipped one bug from a D-Bus numeric type arriving as something other than a JavaScript number.

**Files:**
- Modify: `src/main/backend/linux/telephony.js`, `src/main/backend/linux/index.js`, `src/main/ipc.js`, `src/main/preload.js`, `src/renderer/settings.js`
- Test: `test/callvolume.test.js`

**Interfaces:**
- Produces: `clampVolume(n)`, `getCallVolume()`, `setCallVolume({speaker, microphone, muted})`, `onCallVolume(cb)`

- [ ] **Step 1: Write the failing test**

```js
// test/callvolume.test.js
const test = require('node:test');
const assert = require('node:assert');
const { clampVolume, createTelephony } = require('../src/main/backend/linux/telephony');
const { modemPathFor } = require('../src/main/backend/linux/bus');

const MAC = '44:CD:0E:AD:5E:34';

test('clampVolume constrains to the 0-100 byte range and rounds', () => {
  assert.strictEqual(clampVolume(50), 50);
  assert.strictEqual(clampVolume(0), 0);
  assert.strictEqual(clampVolume(100), 100);
  assert.strictEqual(clampVolume(-5), 0);
  assert.strictEqual(clampVolume(140), 100);
  assert.strictEqual(clampVolume(49.6), 50);
  assert.strictEqual(clampVolume('50'), 50);
  assert.strictEqual(clampVolume(null), 0);
  assert.strictEqual(clampVolume(NaN), 0);
});

function fakeTelephony(cv) {
  return createTelephony({
    mac: MAC,
    getInterfaceFn: async (_bus, _svc, path, iface) => {
      if (path === modemPathFor(MAC) && iface === 'org.ofono.CallVolume') return cv;
      throw new Error(`No such interface '${iface}'`);
    },
    systemBusFn: () => ({}),
  });
}

test('getCallVolume unwraps the variant dictionary', async () => {
  const t = fakeTelephony({
    async GetProperties() {
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 40 }, Muted: { value: false } };
    },
    on() {},
  });
  assert.deepStrictEqual(await t.getCallVolume(), {
    speaker: 50, microphone: 40, muted: false, error: null,
  });
});

test('getCallVolume reports an unreachable interface instead of inventing zeros', async () => {
  const t = createTelephony({
    mac: MAC,
    getInterfaceFn: async () => { throw new Error("No such interface 'org.ofono.CallVolume'"); },
    systemBusFn: () => ({}),
  });
  const v = await t.getCallVolume();
  assert.strictEqual(v.speaker, null);
  assert.ok(v.error);
});

test('setCallVolume marshals volumes as byte and mute as boolean', async () => {
  const seen = [];
  const t = fakeTelephony({
    async SetProperty(name, variant) { seen.push([name, variant.signature, variant.value]); },
    on() {},
  });
  await t.setCallVolume({ speaker: 70, microphone: 140, muted: true });
  assert.deepStrictEqual(seen, [
    ['SpeakerVolume', 'y', 70],
    ['MicrophoneVolume', 'y', 100],
    ['Muted', 'b', true],
  ]);
});

test('setCallVolume only writes the properties it was given', async () => {
  const seen = [];
  const t = fakeTelephony({
    async SetProperty(name) { seen.push(name); },
    on() {},
  });
  await t.setCallVolume({ speaker: 30 });
  assert.deepStrictEqual(seen, ['SpeakerVolume']);
});

test('onCallVolume emits when the handset changes its own volume', async () => {
  let handler = null;
  const t = fakeTelephony({
    async GetProperties() {
      return { SpeakerVolume: { value: 50 }, MicrophoneVolume: { value: 50 }, Muted: { value: false } };
    },
    on(signal, cb) { if (signal === 'PropertyChanged') handler = cb; },
  });
  const seen = [];
  await t.onCallVolume((v) => seen.push(v));
  handler('SpeakerVolume', { value: 80 });
  assert.strictEqual(seen.at(-1).speaker, 80);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/callvolume.test.js`
Expected: FAIL — `clampVolume is not a function`

- [ ] **Step 3: Implement in `telephony.js`**

Add `Variant` to the dbus import at the top of the file:

```js
const { Variant } = require('dbus-next');
```

Add above `createTelephony`:

```js
// CallVolume properties are D-Bus `y` (uint8). Out-of-range or non-numeric
// input must never reach SetProperty: dbus-next would either throw at
// marshal time or wrap around, and a wrapped value is a volume the user did
// not ask for on a device they are talking through.
function clampVolume(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}
```

Add inside the object returned by `createTelephony`:

```js
    async getCallVolume() {
      try {
        const cv = await iface(modemPath, 'org.ofono.CallVolume');
        const p = unwrap(await cv.GetProperties());
        return {
          speaker: p.SpeakerVolume ?? null,
          microphone: p.MicrophoneVolume ?? null,
          muted: Boolean(p.Muted),
          error: null,
        };
      } catch (err) {
        // Nulls, not zeros. A slider parked at 0 for a failed read is
        // indistinguishable from a handset genuinely muted.
        return { speaker: null, microphone: null, muted: false, error: describeTelephonyError(err) };
      }
    },

    async setCallVolume(patch) {
      const cv = await iface(modemPath, 'org.ofono.CallVolume');
      if (patch.speaker !== undefined) {
        await cv.SetProperty('SpeakerVolume', new Variant('y', clampVolume(patch.speaker)));
      }
      if (patch.microphone !== undefined) {
        await cv.SetProperty('MicrophoneVolume', new Variant('y', clampVolume(patch.microphone)));
      }
      if (patch.muted !== undefined) {
        await cv.SetProperty('Muted', new Variant('b', Boolean(patch.muted)));
      }
    },

    // The handset pushes its own volume-key presses back over HFP, so the
    // sliders have to follow rather than fight them.
    async onCallVolume(cb) {
      const cv = await iface(modemPath, 'org.ofono.CallVolume');
      let state = unwrap(await cv.GetProperties());
      cv.on('PropertyChanged', (name, variant) => {
        state = { ...state, [name]: variant.value };
        cb({
          speaker: state.SpeakerVolume ?? null,
          microphone: state.MicrophoneVolume ?? null,
          muted: Boolean(state.Muted),
          error: null,
        });
      });
      return () => {};
    },
```

Add `clampVolume` to the module exports, keeping the existing order and appending:

```js
module.exports = {
  toCall, directionFor, signalPercent, createTelephony, describeTelephonyError, clampVolume,
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/callvolume.test.js`
Expected: PASS

- [ ] **Step 5: Wire IPC and the live broadcast**

`src/main/ipc.js`:

```js
    'volume:call:get': () => backend.getCallVolume(),
    'volume:call:set': (_e, patch) => backend.setCallVolume(patch),
```

At the bottom of `registerIpc`, beside the other subscriptions:

```js
  // Fails silently by design when no handset is bound: onCallVolume needs a
  // modem path, and a missing one is a normal first-run state, not a fault.
  Promise.resolve(backend.onCallVolume((v) => broadcast('callvolume:changed', v)))
    .catch(() => {});
```

`src/main/preload.js`:

```js
  getCallVolume: () => ipcRenderer.invoke('volume:call:get'),
  setCallVolume: (p) => ipcRenderer.invoke('volume:call:set', p),
  onCallVolume: (cb) => ipcRenderer.on('callvolume:changed', (_e, v) => cb(v)),
```

- [ ] **Step 6: Render the handset half of the Volume section**

Append to `src/renderer/settings.js`, and call it from `renderSettings` **before** `renderPcVolume` so `On the call` appears first:

```js
async function renderCallVolume(host) {
  const group = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = 'On the call';
  group.append(h);

  const v = await window.konnect.getCallVolume().catch((err) => ({ error: err.message }));
  if (v.error) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Handset volume unavailable: ${v.error}`;
    group.append(p);
    host.append(group);
    return;
  }

  group.append(volumeSlider({
    label: 'Earpiece', value: v.speaker,
    onChange: (n) => window.konnect.setCallVolume({ speaker: n }),
  }));
  group.append(volumeSlider({
    label: 'Microphone', value: v.microphone,
    onChange: (n) => window.konnect.setCallVolume({ microphone: n }),
  }));

  const muteLabel = document.createElement('label');
  const mute = document.createElement('input');
  mute.type = 'checkbox';
  mute.checked = v.muted;
  mute.addEventListener('change', async () => {
    try {
      await window.konnect.setCallVolume({ muted: mute.checked });
    } catch (err) {
      mute.checked = !mute.checked;
      alert(`Could not change mute: ${err.message}`);
    }
  });
  const muteText = document.createElement('span');
  muteText.textContent = ' Mute microphone';
  muteLabel.append(mute, muteText);

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Changes what your caller hears. The handset may refuse these while no call is active.';
  group.append(muteLabel, note);
  host.append(group);
}
```

Register the live follow once, at the end of `settings.js`:

```js
// The handset pushes its own volume changes back; re-render only while the
// Settings view is actually on screen.
window.konnect.onCallVolume(() => {
  if ($('#view-settings').classList.contains('active')) renderSettings();
});
```

- [ ] **Step 7: Run the suite and commit**

```bash
npm test
git add src/main/backend/linux/telephony.js test/callvolume.test.js src/main/ src/renderer/settings.js
git commit -m "feat: handset call volume over org.ofono.CallVolume with live follow"
```

---

### Task 12: Ringtone

Played from main with `pw-play`, not a renderer `<audio>`. That avoids Chromium's autoplay policy silently blocking un-gestured audio, avoids `setSinkId()` and its device-permission handler, and makes the ringtone independent of whether any window exists.

**Files:**
- Create: `assets/ringtone.ogg`
- Modify: `src/main/backend/linux/audio.js`, `src/main/backend/linux/index.js`, `src/main/index.js`, `src/main/ipc.js`, `src/main/preload.js`, `src/renderer/settings.js`

**Interfaces:**
- Produces: `startRing({ tone, sink })`, `stopRing()`

- [ ] **Step 1: Generate the bundled tone**

Written as raw WAV by a script rather than an `ffmpeg` filter expression, because the filter form needs comma escaping that differs between shells and silently produces a different waveform when it goes wrong.

```bash
mkdir -p assets
node -e '
const fs = require("node:fs");
const RATE = 24000, SECONDS = 5, N = RATE * SECONDS;
const buf = Buffer.alloc(44 + N * 2);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i += 1) {
  const t = i / RATE, c = t % 5;
  // UK-style double ring: 0.4s on, 0.2s off, 0.4s on, then silence.
  const on = (c < 0.4) || (c >= 0.6 && c < 1.0);
  // 8ms raised-cosine edges stop the abrupt starts from clicking.
  const edge = Math.min(1, Math.min(c, Math.abs(c - 0.4), Math.abs(c - 0.6), Math.abs(c - 1.0)) / 0.008);
  const a = on ? 0.35 * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, edge))) : 0;
  buf.writeInt16LE(Math.round(a * 32767 * Math.sin(2 * Math.PI * 425 * t)), 44 + i * 2);
}
fs.writeFileSync("assets/ringtone.wav", buf);
'
ffmpeg -hide_banner -loglevel error -y -i assets/ringtone.wav -c:a libvorbis -q:a 3 assets/ringtone.ogg
rm assets/ringtone.wav
pw-play assets/ringtone.ogg
```

Expected: a five-second double ring at a comfortable level, no clicks. `ls -l assets/ringtone.ogg` should be well under 100 KB.

- [ ] **Step 2: Implement ring control**

Append to `src/main/backend/linux/audio.js` and add both to the exports:

```js
const { spawn } = require('node:child_process');

let ringProc = null;
let ringWanted = false;

// pw-play exits at the end of the file, so looping means respawning. The
// ringWanted latch is what stops the exit handler from restarting a ring
// that stopRing() has already cancelled - without it, a hangup that lands
// between exit and respawn leaves the ringtone playing forever.
// A legitimate playthrough of the bundled tone lasts about five seconds; a
// missing or undecodable file exits in milliseconds.
const MIN_RING_MS = 1000;

// spawnFn is injectable so the respawn/latch logic - the dangerous part - can
// be tested without a real pw-play.
function startRing({ tone, sink, spawnFn = spawn }) {
  if (ringWanted) return;
  ringWanted = true;
  const spawnOnce = () => {
    if (!ringWanted) return;
    const args = sink ? ['--target', sink, tone] : [tone];
    const startedAt = Date.now();
    ringProc = spawnFn('pw-play', args, { stdio: 'ignore' });
    ringProc.on('exit', (code) => {
      ringProc = null;
      if (!ringWanted) return;   // stopRing() cancelled us; don't respawn or log
      // A missing or undecodable tone makes pw-play exit almost immediately
      // with a non-zero code, and ONLY 'exit' fires - 'error' never does, so
      // the handler below cannot catch it. Respawning regardless spins a
      // silent process storm for the whole ring duration: no sound, no log.
      // Verified against both a missing path and a corrupt .ogg.
      if (code !== 0 && Date.now() - startedAt < MIN_RING_MS) {
        console.error(`[konnect] ringtone failed (pw-play exit ${code}); not ringing: ${tone}`);
        ringWanted = false;
        return;
      }
      spawnOnce();
    });
    ringProc.on('error', (err) => {
      // A missing pw-play must not become an invisible silent ring.
      console.error('[konnect] ringtone failed:', err.message);
      ringWanted = false;
      ringProc = null;
    });
  };
  spawnOnce();
}

function stopRing() {
  ringWanted = false;
  if (ringProc) ringProc.kill('SIGTERM');
  ringProc = null;
}
```

Add `stopRing()` to the backend's `dispose()` step list in `src/main/backend/linux/index.js` so a ring can never outlive the app:

```js
      for (const step of [device.dispose, telephony.dispose, recorder.dispose, audio.stopRing]) {
```

Extend the `audio` namespace:

```js
      startRing: (o) => audio.startRing(o),
      stopRing: () => audio.stopRing(),
```

- [ ] **Step 3: Ring on incoming calls**

In `src/main/index.js`, add near the top:

```js
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
```

In `showIncoming(call)`, immediately after the `incomingCallId = call.id;` assignment:

```js
  const ring = ringSettings();
  if (ring.enabled && backend.audio) backend.audio.startRing(ring);
```

In `closeIncoming(id)`, after the early-return guard and before the window teardown:

```js
  if (backend && backend.audio) backend.audio.stopRing();
```

`showIncoming` is already guarded against re-entry by call id — oFono re-emits the whole call object on every `PropertyChanged`, and without that guard the ringtone would restart on each one.

- [ ] **Step 4: Add the preview channel**

`src/main/ipc.js`:

```js
    'ring:test': () => { needAudio().startRing(ringSettings()); return true; },
    'ring:stop': () => { needAudio().stopRing(); return true; },
```

`registerIpc` needs `ringSettings` passed in — add it to the destructured parameters as `ringSettings = () => ({})` and pass the real one from `index.js`.

Custom tones need a file picker, because `ringSettings()` in Step 3 already
reads `ring_tone` and nothing would ever write it otherwise:

```js
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
```

`src/main/preload.js`:

```js
  testRing: () => ipcRenderer.invoke('ring:test'),
  stopRing: () => ipcRenderer.invoke('ring:stop'),
  chooseRingtone: () => ipcRenderer.invoke('ring:choose'),
```

- [ ] **Step 5: Render the Ringtone section**

Append to `src/renderer/settings.js` and call from `renderSettings`:

```js
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
  const toneRow = document.createElement('p');
  const toneName = document.createElement('span');
  toneName.textContent = !tone || tone === 'bundled'
    ? 'Tone: Konnect default'
    : `Tone: ${tone.split('/').pop()}`;
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
  toneRow.append(toneName, choose, reset);

  const test = document.createElement('button');
  test.textContent = 'Test';
  test.addEventListener('click', async () => {
    await window.konnect.testRing();
    setTimeout(() => window.konnect.stopRing(), 5000);
  });

  host.append(label, toneRow, sinkLabel, test);
}
```

`dialog` is already imported in `src/main/ipc.js` for the export handlers, and
`store` is already a `registerIpc` parameter — neither needs adding.

- [ ] **Step 6: Verify — without ringing the handset**

Press **Test** in Settings. Expected: the ringtone plays for five seconds through the chosen device and stops on its own. Change the device and press Test again — it must follow.

**Do not place a call to test the incoming path.** That path is exercised the next time a real call arrives.

- [ ] **Step 7: Run the suite and commit**

```bash
npm test
git add assets/ringtone.ogg src/main/ src/renderer/settings.js
git commit -m "feat: ring on the PC for incoming calls via pw-play"
```

---

### Task 13: Konnect-owned call audio routing

The riskiest task, deliberately last. Manual routing's failure mode is a call with no audio, or a recording that is the right length and completely silent — indistinguishable from a working one. Every decision therefore lives in a pure function, and the apply step reports what actually attached.

**Files:**
- Modify: `src/main/backend/linux/audio.js`, `src/main/backend/linux/index.js`, `src/main/ipc.js`, `src/main/preload.js`, `src/renderer/settings.js`, `src/renderer/app.js`
- Test: `test/audio-helpers.test.js`

**Interfaces:**
- Consumes: `parsePwLink(text)` from `src/main/backend/linux/recorder.js` — already exported and tested; do not write a second parser
- Produces: `planLinks({ sink, source, ports, links })`, `applyRouting({ sink, source })`, `onRouting(cb)`

- [ ] **Step 1: Write the failing test**

```js
// append to test/audio-helpers.test.js
const { planLinks } = require('../src/main/backend/linux/audio');

const BT_IN = 'bluez_input.44_CD_0E_AD_5E_34';    // remote voice (a source)
const BT_OUT = 'bluez_output.44_CD_0E_AD_5E_34';  // what the caller hears (a sink)
const SINK = 'alsa_output.usb-HyperX.analog-stereo';
const SRC = 'alsa_input.usb-HyperX.mono-fallback';

const PORTS = {
  [BT_IN]: { out: [`${BT_IN}:output_MONO`], in: [] },
  [BT_OUT]: { out: [], in: [`${BT_OUT}:playback_MONO`] },
  [SINK]: { out: [], in: [`${SINK}:playback_FL`, `${SINK}:playback_FR`] },
  [SRC]: { out: [`${SRC}:capture_MONO`], in: [] },
};

test('a mono SCO stream fans out to both channels of a stereo sink', () => {
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links: [] });
  assert.deepStrictEqual(plan.link, [
    [`${BT_IN}:output_MONO`, `${SINK}:playback_FL`],
    [`${BT_IN}:output_MONO`, `${SINK}:playback_FR`],
    [`${SRC}:capture_MONO`, `${BT_OUT}:playback_MONO`],
  ]);
  assert.strictEqual(plan.fallback, false);
});

test('WirePlumber links to a different device are torn down first', () => {
  const OTHER = 'alsa_output.pci-0000_2d_00.4.analog-stereo';
  const links = [
    { output: `${BT_IN}:output_MONO`, input: `${OTHER}:playback_FL` },
    { output: `${OTHER}_mic:capture_MONO`, input: `${BT_OUT}:playback_MONO` },
  ];
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.deepStrictEqual(plan.unlink, [
    [`${BT_IN}:output_MONO`, `${OTHER}:playback_FL`],
    [`${OTHER}_mic:capture_MONO`, `${BT_OUT}:playback_MONO`],
  ]);
});

test('a link that is already correct is neither unlinked nor relinked', () => {
  const links = [{ output: `${BT_IN}:output_MONO`, input: `${SINK}:playback_FL` }];
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.ok(!plan.unlink.some(([, i]) => i === `${SINK}:playback_FL`));
  assert.ok(!plan.link.some(([, i]) => i === `${SINK}:playback_FL`));
});

test('a missing output device falls back without unlinking anything on that leg', () => {
  const links = [{ output: `${BT_IN}:output_MONO`, input: 'alsa_output.other:playback_FL' }];
  const plan = planLinks({ sink: 'alsa_output.unplugged', source: SRC, ports: PORTS, links });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /output device/i);
  assert.deepStrictEqual(plan.unlink, []);
  // The microphone leg is independent and still routed.
  assert.deepStrictEqual(plan.link, [[`${SRC}:capture_MONO`, `${BT_OUT}:playback_MONO`]]);
});

test('a missing microphone falls back on that leg only', () => {
  const plan = planLinks({ sink: SINK, source: 'alsa_input.gone', ports: PORTS, links: [] });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /microphone/i);
  assert.strictEqual(plan.link.length, 2);
});

test('no SCO nodes means no plan at all - never an empty success', () => {
  const plan = planLinks({ sink: SINK, source: SRC, ports: { [SINK]: PORTS[SINK] }, links: [] });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /call audio/i);
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.unlink, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/audio-helpers.test.js`
Expected: FAIL — `planLinks is not a function`

- [ ] **Step 3: Implement the planner**

Append to `src/main/backend/linux/audio.js` and add to the exports:

```js
// A source's output ports link straight to a sink's input ports. pw-loopback
// is deliberately not used - a loopback node is a second graph element to
// keep in sync, and it was what tangled the earlier routing attempt.
function fanOut(fromPorts, toPorts) {
  // Mono SCO into a stereo sink means one source port feeding both channels;
  // a stereo mic into mono SCO means only the first port is used. Indexing
  // the source modulo its length expresses both without a special case.
  return toPorts.map((to, i) => [fromPorts[i % fromPorts.length], to]);
}

function planLinks({ sink, source, ports, links }) {
  const names = Object.keys(ports || {});
  const btIn = names.find((n) => n.startsWith('bluez_input.'));
  const btOut = names.find((n) => n.startsWith('bluez_output.'));

  // No SCO nodes means the call audio link is not up. Returning an empty plan
  // with fallback:false would read as "routed successfully" to every caller.
  if (!btIn && !btOut) {
    return { unlink: [], link: [], fallback: true, reason: 'call audio nodes are not present' };
  }

  const unlink = [];
  const link = [];
  const reasons = [];
  const existing = links || [];

  const remoteOut = btIn ? (ports[btIn].out || []) : [];
  const sinkIn = ports[sink] ? (ports[sink].in || []) : [];
  if (remoteOut.length && sinkIn.length) {
    const wanted = fanOut(remoteOut, sinkIn);
    const wantedSet = new Set(wanted.map(([o, i]) => `${o}|${i}`));
    for (const l of existing) {
      if (!remoteOut.includes(l.output)) continue;
      if (wantedSet.has(`${l.output}|${l.input}`)) continue;
      unlink.push([l.output, l.input]);
    }
    for (const pair of wanted) {
      if (!existing.some((l) => l.output === pair[0] && l.input === pair[1])) link.push(pair);
    }
  } else if (remoteOut.length) {
    // Leave WirePlumber's routing alone on this leg. Unlinking it and then
    // failing to link a replacement is how a call ends up with no audio.
    reasons.push('output device unavailable');
  }

  const micOut = ports[source] ? (ports[source].out || []) : [];
  const btInPorts = btOut ? (ports[btOut].in || []) : [];
  if (micOut.length && btInPorts.length) {
    const wanted = fanOut(micOut, btInPorts);
    const wantedSet = new Set(wanted.map(([o, i]) => `${o}|${i}`));
    for (const l of existing) {
      if (!btInPorts.includes(l.input)) continue;
      if (wantedSet.has(`${l.output}|${l.input}`)) continue;
      unlink.push([l.output, l.input]);
    }
    for (const pair of wanted) {
      if (!existing.some((l) => l.output === pair[0] && l.input === pair[1])) link.push(pair);
    }
  } else if (btInPorts.length) {
    reasons.push('microphone unavailable');
  }

  return {
    unlink, link,
    fallback: reasons.length > 0,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/audio-helpers.test.js`
Expected: PASS

- [ ] **Step 5: Implement apply**

Append to `src/main/backend/linux/audio.js`:

```js
const { parsePwLink, isBenignLinkError } = require('./recorder');
const { createEmitter } = require('../interface');

const routingEmitter = createEmitter();

// `pw-link -i` and `-o` list input and output ports, one per line, as
// "<node.name>:<port>". Grouping them by node is what planLinks consumes.
async function readPorts() {
  const ports = {};
  for (const [flag, side] of [['-i', 'in'], ['-o', 'out']]) {
    const { stdout } = await execFileAsync('pw-link', [flag]).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      const idx = trimmed.lastIndexOf(':');
      if (idx <= 0) continue;
      const node = trimmed.slice(0, idx);
      ports[node] = ports[node] || { in: [], out: [] };
      ports[node][side].push(trimmed);
    }
  }
  return ports;
}

async function applyRouting({ sink, source }) {
  const [ports, linkText] = await Promise.all([
    readPorts(),
    execFileAsync('pw-link', ['-l']).then((r) => r.stdout).catch(() => ''),
  ]);
  const plan = planLinks({ sink, source, ports, links: parsePwLink(linkText) });

  for (const [out, inp] of plan.unlink) {
    await execFileAsync('pw-link', ['-d', out, inp]).catch(() => {});
  }

  let remoteLinked = false;
  let micLinked = false;
  for (const [out, inp] of plan.link) {
    let ok = true;
    try {
      await execFileAsync('pw-link', [out, inp]);
    } catch (err) {
      ok = isBenignLinkError(err);
      if (!ok) console.error(`[konnect] failed to link ${out} -> ${inp}: ${err.message}`);
    }
    if (!ok) continue;
    if (out.startsWith('bluez_input.')) remoteLinked = true;
    if (inp.startsWith('bluez_output.')) micLinked = true;
  }

  const result = { remoteLinked, micLinked, fellBack: plan.fallback, reason: plan.reason };
  if (plan.fallback) console.warn(`[konnect] routing fell back to system defaults: ${plan.reason}`);
  routingEmitter.emit(result);
  return result;
}

function onRouting(cb) { return routingEmitter.on(cb); }
```

- [ ] **Step 6: Apply routing at call start**

In `src/main/backend/linux/index.js`, `createLinuxBackend` gains a settings reader so it can see the user's choice without importing the store:

```js
function createLinuxBackend({ mac = null, getSetting = () => null } = {}) {
```

After the existing `device.onChange(...)` subscription, add:

```js
// Routing is applied at call start because the SCO nodes do not exist before
// then - there is nothing to link to while the line is idle. This fires on
// the SAME trigger as recording (first transition to `active`) so the two
// cannot disagree about when call audio exists, and it runs whether or not
// recording is enabled.
const routed = new Set();
telephony.onCall((call) => {
  if (call.state === 'disconnected') { routed.delete(call.id); return; }
  if (call.state !== 'active' || routed.has(call.id)) return;
  routed.add(call.id);
  if (getSetting('audio_mode') !== 'konnect') return;
  audio.applyRouting({
    sink: getSetting('audio_sink'), source: getSetting('audio_source'),
  }).catch((err) => console.error('[konnect] routing failed:', err.message));
});
```

Extend the `audio` namespace:

```js
      onRouting: (cb) => audio.onRouting(cb),
```

In `src/main/backend/index.js`, pass the reader through:

```js
function createBackend({ platform = process.platform, mock = false, mac, getSetting } = {}) {
```
```js
    return createLinuxBackend({ mac: mac ?? null, getSetting });
```

In `src/main/index.js`, supply it when building the real backend:

```js
  backend = createBackend({ mac, getSetting: (k) => store.getSetting(k) });
```

- [ ] **Step 7: Surface link status in the UI**

In `src/main/ipc.js`, beside the other subscriptions:

```js
  if (backend.audio) backend.audio.onRouting((r) => broadcast('routing:changed', r));
```

In `src/main/preload.js`:

```js
  onRouting: (cb) => ipcRenderer.on('routing:changed', (_e, r) => cb(r)),
```

In `src/renderer/app.js`, show a banner when routing degrades — the whole hazard of manual routing is a failure the user cannot hear the cause of:

```js
window.konnect.onRouting((r) => {
  const banner = $('#s-error');
  if (!r.fellBack && r.remoteLinked) return;
  banner.textContent = r.fellBack
    ? `Call audio is using system defaults: ${r.reason}`
    : 'Call audio could not be routed to the selected device.';
  banner.hidden = false;
});
```

Append the live status dots to `renderAudio()` in `src/renderer/settings.js`, before the closing `host.append(...)`:

```js
  const status = document.createElement('p');
  status.id = 'set-audio-status';
  status.className = 'muted';
  status.textContent = 'Link status: idle (call audio devices appear only during a call)';
  window.konnect.onRouting((r) => {
    status.textContent = `Link status: remote ${r.remoteLinked ? 'OK' : 'not linked'}`
      + ` · mic ${r.micLinked ? 'OK' : 'not linked'}`
      + (r.reason ? ` · ${r.reason}` : '');
  });

  const testBtn = document.createElement('button');
  testBtn.textContent = 'Test routing';
  testBtn.addEventListener('click', async () => {
    const d = await window.konnect.listAudioDevices();
    const okSink = !outSel.value || d.sinks.some((n) => n.name === outSel.value);
    const okSource = !inSel.value || d.sources.some((n) => n.name === inSel.value);
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
```

Add `status` and `testBtn` to the final `host.append(...)` call.

- [ ] **Step 8: Run the suite and commit**

```bash
npm test
git add src/main/backend/linux/audio.js test/audio-helpers.test.js src/main/ src/renderer/
git commit -m "feat: Konnect-owned call audio routing with visible link status"
```

- [ ] **Step 9: Hardware verification — at the next real call only**

**Do not place a call to test this.** At the next call that happens naturally:

1. Set `audio_mode` to `konnect` with a specific output device chosen.
2. When the call goes active, confirm the caller is audible **through the chosen device**.
3. Confirm the caller can hear you.
4. Check Settings for `Link status: remote OK · mic OK`.
5. If recording is on, play the recording afterwards and confirm **both sides** are present — remote left, microphone right.
6. Note whether the switch caused an audible gap at the start of the call. This is spec section 16's second open question.

If any of these fail, set `audio_mode` back to `system` — that restores WirePlumber's routing on the next call — and report what was observed.

---

## Verification Summary

| Provable by `npm test` | Only provable on real hardware |
| --- | --- |
| Recording path traversal guard | `<audio>` seeking against the protocol handler |
| Setup checks follow the chosen mac | The wizard against a second real handset |
| Bootstrap device selection incl. `null` | Whether `CallVolume` accepts writes with no call active |
| `parseNodes` against a captured `pw-dump` | Whether SCO links attach to real ports |
| `planLinks` incl. fall-back-don't-unlink | Whether recordings still capture both sides under Konnect routing |
| `parseWpctlVolume` | Whether relinking mid-call causes an audible gap |
| `desktopEntry` + enable/disable round trip | Ringtone behaviour during a genuine incoming call |
| `clampVolume` and `Variant('y')` marshalling | |

The right-hand column is the point of the spec's section 16. Nothing in this plan claims a green check for anything in it.
