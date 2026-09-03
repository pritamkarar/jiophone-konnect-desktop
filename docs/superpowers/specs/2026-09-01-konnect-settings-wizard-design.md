# Konnect — Onboarding Wizard, Settings and Recording Playback

**Date:** 2026-09-01
**Status:** Design approved by user; implementation plan not yet written
**Builds on:** `2026-09-01-jiophone-konnect-design.md`
**Target platform:** Ubuntu 24.04 (Linux backend only; Windows remains stubbed)

---

## 1. Summary

Three features on top of the shipped PC suite:

1. **Recording playback** — play a call recording from the call log without leaving the app.
2. **Device connection wizard** — a four-step first-run flow that chooses which paired
   handset Konnect is bound to, runs the dependency checks against *that* handset, and
   verifies the link read-only.
3. **Settings page** — ringtone, volume, autostart, and audio input/output device.

The load-bearing change is not any single feature. It is that `device_mac` stops being a
construction-time constant and becomes a user-chosen value, which forces a duplicate
fact (the handset's D-Bus object paths) to be unified before the wizard can be correct.

---

## 2. Verified facts

Probed on the target machine on 2026-09-01. Every design decision below rests on one of
these rather than on assumption.

| Fact | Evidence |
| --- | --- |
| `org.ofono.CallVolume` exists on the handset | `SpeakerVolume y 50`, `MicrophoneVolume y 50`, `Muted b false` |
| Two devices are paired | `44:CD:0E:AD:5E:34 F120B`, `30:BB:7D:21:99:DA OnePlus 10R 5G` |
| **SCO nodes do not exist outside a call** | `pw-link -o \| grep bluez` and `pw-link -i \| grep bluez` both empty with no call up |
| `pw-dump` yields clean JSON with `node.name` and `node.description` | 8 audio nodes enumerated |
| Tooling present | `pw-dump`, `pw-link`, `wpctl`, `pw-record`, `ffmpeg` all in `/usr/bin` |
| `~/.config/autostart` does not exist | must be created, not assumed |
| `listDevices()` / `connect(mac)` / `disconnect()` already implemented | `src/main/backend/linux/device.js:85-119`, in `BACKEND_METHODS`, **no IPC channel, no UI** |
| Recordings are Ogg-Opus | two `.opus` files in `~/Konnect/recordings` |

The SCO fact is the one that shapes the routing design: Konnect **cannot** apply audio
routing when the user presses Save, because there is nothing to link to.

---

## 3. Decisions taken

| Question | Decision |
| --- | --- |
| Wizard scope | ~~Select + connect only; no in-app pairing.~~ **Superseded 2026-09-02** by `2026-09-02-konnect-onboarding-pairing-design.md`, which adds `StartDiscovery` and `org.bluez.Agent1`. |
| Input/output device | **Konnect-owned routing.** Explicit `pw-link` of chosen devices, overriding WirePlumber's defaults. This deliberately supersedes the earlier "no custom audio routing" constraint from the debugging phase. |
| Volume | **Both**, presented as two labelled groups: handset call volume over HFP, and PC playback/capture level. |
| Device change lifecycle | **Relaunch.** `device_mac` is written, then `app.relaunch(); app.exit(0)`. No hot-swap, no per-subsystem mutable mac. |

### 3.1 Why relaunch

The backend threads `mac` into four long-lived subsystems (BlueZ listener, oFono watcher,
OBEX agent, recorder). A hot-swap would add a teardown path that runs almost never:
`dispose()` has only ever executed during shutdown, where a leaked D-Bus listener is
invisible because the process dies immediately. Leaking one mid-session silently kills
status updates.

Every defect on this project so far came from a path or data shape that testing never
produced. A relaunch is the most exercised path in the application. Changing which phone
a PC suite is bound to happens roughly once.

### 3.2 Routing constraints

`pw-link` on ports directly. **Never `pw-loopback`.** A source's output ports link
straight to a sink's input ports; loopback nodes were what tangled the earlier attempt.

`recorder.js` keeps `pw-record --target 0` and its explicit links. That is unchanged and
not negotiable — anything else silently attaches to the default source.

---

## 4. Device identity

### 4.1 The duplicate that must die first

**Correction to an earlier draft of this section.** It claimed the handset's object paths
were encoded in three places and proposed a new `paths.js`. That was wrong, and checking
before writing the plan is what caught it. `devicePathFor(mac)` and `modemPathFor(mac)`
**already live together** in `src/main/backend/linux/bus.js:14-20`, are already imported
by both `device.js` and `telephony.js`, and are already covered by
`test/linux-helpers.test.js`. No new module is needed.

There is exactly one duplicate:

| Location | Form |
| --- | --- |
| `src/main/backend/linux/bus.js:14-20` | `modemPathFor(mac)`, `devicePathFor(mac)` — shared, tested, correct |
| `src/main/setup.js:5` | `MODEM_PATH` hardcoded string literal — the outlier |

The literal names the F120B. A wizard that lets the user select the OnePlus would run all
four dependency checks against the JioPhone's modem and report green. **This is the same
failure shape as the call-direction bug** — a path no test ever produced.

**Change:** delete `MODEM_PATH` from `setup.js` and import `modemPathFor` from `bus.js`.
Requiring `bus.js` pulls in `dbus-next`, but `systemBus()` is lazy, so nothing connects to
a bus at require time and `setup.test.js` keeps running without D-Bus.

`runChecks({ exec, mac })` and `remediate(id, { exec, writeFile, mac })` become
mac-parameterised. `WIREPLUMBER_MANUAL_COMMAND` is unaffected; `MODEM_MANUAL_COMMAND`
is derived per-call from the mac.

### 4.2 Bootstrap resolution

`DEFAULT_DEVICE_MAC = '44:CD:0E:AD:5E:34'` in `src/main/index.js` and `DEFAULT_MAC` in
`src/main/backend/linux/index.js` are removed. They name the developer's handset.

Resolution order when the app starts:

1. `store.getSetting('device_mac')` if set
2. else the first **connected** paired device from `listDevices()`
3. else the first paired device
4. else `null`

`mac === null` is a real, supported state — a machine with no paired phone, which is the
first-run state for every user but the developer. In that state:

- `getStatus()` returns `{ connected: false, error: 'No handset selected' }`
- `dial` / `answer` / `hangup` / `sendDtmf` / contact import reject with the same message
- the wizard opens and **cannot be dismissed** until a device is chosen

Nothing constructs a D-Bus path from `null`.

Dismissibility follows the resolved mac, not the setting: the wizard is shown whenever
`device_mac` is unset, but it is **dismissible** when bootstrap resolution found a paired
device (cases 2 and 3) and **blocking** only in case 4, where there is no handset to talk
to at all.

---

## 5. Onboarding wizard

A four-step flow in the renderer, shown automatically when `device_mac` is unset, and
re-openable from **Settings › Device › Change handset**.

| Step | Content |
| --- | --- |
| 1. Welcome | What Konnect does; that the phone must already be paired. |
| 2. Device | `listDevices()` as a radio list with paired/connected badges, paired first. `[Refresh]`. Text pointer to the system Bluetooth settings for pairing — no launcher, because settings-panel launchers are desktop-specific and wrong more often than right. |
| 3. Checks | The existing `runChecks` UI, re-hosted, now run against the chosen mac. `[Fix]` buttons behave exactly as today. |
| 4. Done | Read-only link verification, then Finish. |

### 5.1 Step 4 verification is read-only

Three reads against the chosen modem path:

- `Online` is `true`
- `Interfaces` contains `org.ofono.VoiceCallManager`
- `org.ofono.CallVolume` `GetProperties` succeeds

**It never places a call.** A test that rings a handset to prove the handset can ring is
not acceptable here.

### 5.2 Finish behaviour

- Chosen mac **differs** from the running mac → write `device_mac`, show
  "Restarting to connect to <name>…", `app.relaunch(); app.exit(0)`.
- Chosen mac **equals** the running mac → write `device_mac` (it may have been implicit
  from bootstrap resolution), close the wizard, no restart.

---

## 6. Audio subsystem

New module `src/main/backend/linux/audio.js`. The dangerous logic is pure and testable;
only the thin execution layer touches the system.

### 6.1 Surface

| Function | Purity | Role |
| --- | --- | --- |
| `parseNodes(pwDumpJson)` | pure | `Audio/Sink` and `Audio/Source` nodes → `{id, name, description, mediaClass}` |
| `planLinks({ sink, source, bluezPorts, existingLinks })` | pure | → `{ unlink: [], link: [], fallback: bool, reason }` |
| `listAudioDevices()` | I/O | `pw-dump` → `parseNodes` |
| `applyRouting({ sink, source })` | I/O | executes a plan → `{ remoteLinked, micLinked, fellBack }` |
| `getPcVolume(nodeName)` / `setPcVolume(nodeName, pct)` | I/O | via `wpctl`, resolving name → id from `pw-dump` |
| `startRing({ tone, sink })` / `stopRing()` | I/O | `pw-play`, respawn-on-exit loop |

### 6.2 When routing is applied

At **call start**, not at Save — forced by section 2's SCO finding. The hook lives
*inside* the Linux backend, subscribing to `telephony.onCall` and firing once per call id
on the **first transition to `active`** — the same trigger that starts recording, so
routing and recording agree about when audio exists by construction rather than by two
independent guesses. No cross-layer plumbing through `callsession.js`, and it runs
whether or not recording is enabled.

Order is load-bearing: **route first, then record.** The recorder discovers what is
linked into `bluez_output`; routing must already be in place when it looks.

### 6.3 WirePlumber's own links

WirePlumber creates default links when the SCO nodes appear. Konnect-owned routing must
`pw-link -d` those before adding its own, or call audio arrives twice.

### 6.4 The two invariants

**Routing failure degrades to system default, loudly — never to silence.**
If `audio_mode` is `konnect` and the chosen device is absent at call time, Konnect does
**not** unlink WirePlumber's routing. It warns, surfaces a banner, and takes the call
with system defaults. A bad setting must never produce a dead call.

**The recorder needs no changes.** `findMicFeedingPhone()` records whatever is linked
into `bluez_output`. Once Konnect links the chosen mic there, the recorder follows. The
"the mic you are heard through is the mic we record" invariant survives by construction
rather than by configuration.

### 6.5 `[Test routing]` outside a call

Verifies only that the chosen sink and source still exist in `pw-dump`, and says exactly
that in the UI. It cannot prove links will attach, because there is nothing to attach to.
Live link status dots are shown **during** a call, driven by the real `applyRouting`
result.

---

## 7. Volume

### 7.1 Handset call volume

Folded into `telephony.js` — same system bus, same modem path, roughly 45 lines.

- `getCallVolume()` → `org.ofono.CallVolume` `GetProperties`
- `setCallVolume({ speaker, microphone, muted })` → `SetProperty`
- `onCallVolume(cb)` → `PropertyChanged` subscription, broadcast to the renderer so the
  sliders follow the handset's own volume keys live

Values are D-Bus `y` (uint8), 0–100, marshalled as `new Variant('y', n)` and clamped
before marshalling. Given this project's history with `uint64` arriving as `BigInt`, the
marshalling is pinned by a unit test.

Writes may be rejected by the audio gateway outside an active call. A rejected write
surfaces a visible error; a slider must never snap back without a stated reason.

### 7.2 PC volume

`wpctl set-volume <id> <0..1>` on the routed sink and source; read via `wpctl get-volume`.
Node ids are resolved from `pw-dump` on each call because ids are not stable.

---

## 8. Ringtone

Played from **main** via `pw-play --target <sink>`, not from a renderer `<audio>` element.

This avoids three separate hazards: Chromium's autoplay policy silently blocking
un-gestured audio, `setSinkId()` requiring a device-permission handler, and the ringtone
depending on a renderer window existing at all.

- Loop by respawning `pw-play` on exit until `stopRing()`
- Stopped on answer, on hangup, and on call disconnect
- Bundled Ogg-Opus tone in `assets/`; optional user-chosen file
- `[Test]` button in Settings plays it once
- Rings through `ring_sink`, defaulting to the routed output device

---

## 9. Recording playback

- The call log's `Recording` column becomes a `▶` button when `recording_path` is set.
- Clicking expands an inline `<audio controls>` under the row; one open at a time.
- `[Open folder]` via `shell.showItemInFolder`.
- A missing file renders "Recording missing", checked lazily on play rather than per row
  (a per-row `fs.access` is a syscall per row for no benefit).

**Serving the file.** Register `protocol.handle('konnect-rec', …)` resolving a
**basename only** against the recordings directory.

**Correction, established during implementation.** An earlier draft of this section said
`net.fetch` on a `file://` URL "handles ranges and MIME correctly for free". That is false:
Electron 44.1.0's `net.fetch()` ignores a `Range` header on a `file://` URL and answers 200
with the whole body — verified with three forwarding styles and an HTTP cross-check. Since
range support was the stated reason for preferring a custom protocol over a plain `file://`
src, the handler implements Range itself: `200` with `Accept-Ranges` when no range is asked
for, `206` with `Content-Range` when one is, and `416` carrying the real size when the range
is unsatisfiable. The filename also travels in the URL **path**, never the host — Chromium
ASCII-lowercases a `standard` scheme's host during canonicalization, which would destroy the
uppercase MAC hex every recording basename carries.

The traversal guard is written and tested either way: reject any value containing a path
separator, a `..` segment, or an absolute path, and resolve strictly inside the
recordings directory.

`.opus` is Ogg-Opus, which Chromium decodes natively. To be confirmed against the two
real recordings already on disk.

---

## 10. Settings page and renderer structure

New `Settings` nav tab. `Record calls` moves out of the Status view.

Sections: **Device · Audio devices · Volume · Ringtone · Recording · Startup**

`src/renderer/app.js` is 555 lines and these features add roughly 350. ES modules do not
load from `file://` under `webSecurity`, so the split is three plain `<script>` files
sharing globals — `app.js` (shell, status, dialer, call log, contacts), `settings.js`,
`wizard.js` — loaded in order from `index.html`. No bundler, no new dependency.

All handset-derived strings continue to be rendered with `textContent` / `createElement`.

---

## 11. Autostart

New `src/main/autostart.js`.

| Function | Role |
| --- | --- |
| `desktopEntry({ execPath, args })` | pure; returns the `.desktop` file body |
| `isEnabled()` | stats `~/.config/autostart/konnect.desktop` |
| `enable()` / `disable()` | writes / removes it, creating the directory |

The **file is the single source of truth** — no `autostart` settings key, so the checkbox
and the filesystem cannot drift apart.

`Exec` is built from `process.execPath`, branched on `app.isPackaged`, with a `--hidden`
flag. On startup `--hidden` starts to tray **only if a tray host is actually present**;
otherwise the window is shown. Hiding into a tray that does not exist makes the app
unreachable except by `kill` — the same reasoning that already governs the window close
handler.

---

## 12. Settings keys

| Key | Values | Default |
| --- | --- | --- |
| `device_mac` | BD_ADDR | unset → wizard |
| `audio_mode` | `konnect` \| `system` | `system` until the user picks devices |
| `audio_sink` | PipeWire `node.name` | unset |
| `audio_source` | PipeWire `node.name` | unset |
| `ring_enabled` | `true` \| `false` | `true` |
| `ring_tone` | `bundled` \| absolute path | `bundled` |
| `ring_sink` | `node.name` \| empty | empty (follow `audio_sink`) |
| `record_calls` | `true` \| `false` | existing behaviour unchanged |

Autostart is deliberately absent — see section 11.

`audio_mode` is not a contradiction of section 3. Konnect-owned routing is the capability
the user chose to build; `system` is simply the state before any device has been picked,
and a fresh install must not start rewriting audio links it was never told to touch.
Choosing a sink or source in Settings sets `audio_mode` to `konnect`. The
`Use Konnect's own routing` / `Follow system defaults` radio is the explicit control and
always wins over that inference.

---

## 13. IPC surface

Every channel is added to `src/main/ipc.js` **and** mirrored in the `src/main/preload.js`
allowlist. Adding one anywhere else is a bug.

| Channel | Purpose |
| --- | --- |
| `devices:list` | paired/known BlueZ devices |
| `devices:connect` / `devices:disconnect` | explicit connect by mac |
| `device:select` | persist `device_mac`; returns `{ relaunching }` |
| `device:verify` | read-only step-4 link check |
| `audio:devices` | sinks and sources from `pw-dump` |
| `volume:call:get` / `volume:call:set` | HFP `CallVolume` |
| `volume:pc:get` / `volume:pc:set` | `wpctl` |
| `ring:test` / `ring:stop` | ringtone preview |
| `autostart:get` / `autostart:set` | desktop entry |
| `recording:reveal` | `shell.showItemInFolder` |
| broadcast `callvolume:changed` | handset moved its own volume |
| broadcast `routing:changed` | live link status during a call |

`audio:test` was specified in an earlier draft of this table and deliberately dropped during
implementation: everything the idle-time check can honestly assert already comes back from
`audio:devices`, so a dedicated channel would only wrap it.

---

## 14. Testing

`node:test` and `node:assert` only. `npm test` remains bare `node --test`.

Unit-tested:

- `parseNodes` against a `pw-dump` fixture captured from the target machine
- `planLinks`, including the **fall-back-and-do-not-unlink** case when a chosen device is absent
- `desktopEntry` body, and an `enable()` / `isEnabled()` / `disable()` round trip in a temp `HOME`
- recording path resolution: `../../etc/passwd`, absolute paths, embedded separators
- mac-parameterised `runChecks` — asserting the modem path actually follows the mac
- `CallVolume` clamping and `Variant('y', n)` marshalling
- bootstrap mac resolution, including the `null` case

**Not provable without a live call**, and recorded as such rather than dressed in a green
check:

- routing links actually attaching to real SCO ports
- `CallVolume` writes being accepted by the audio gateway
- ringtone behaviour during a real incoming call
- whether tearing down WirePlumber's links mid-call causes an audible gap

These get loud runtime logging and visible link status, not test coverage that would
claim more than it proves.

---

## 15. Build order

1. **Recording playback** — independent, smallest, ships value immediately
2. **Mac-parameterised setup checks** — pure prerequisite, no UI
3. **Wizard** — device select, checks, read-only verify, relaunch
4. **Settings scaffold + autostart** — nav tab, section shells, `Record calls` moved
5. **Volume** — handset and PC
6. **Routing** — last and riskiest; benefits from everything above existing

---

## 16. Open questions requiring a live call

Answerable only against the physical handset, and first on the list at the next hardware
test:

1. Does `org.ofono.CallVolume` accept `SetProperty` outside an active call?
2. Does tearing down WirePlumber's links mid-call cause an audible gap?

Neither blocks implementation. Both change how the UI should behave, so both are
surfaced rather than assumed.

---

## 17. Non-goals

- ~~In-app Bluetooth pairing (`StartDiscovery`, `org.bluez.Agent1`)~~ — **superseded 2026-09-02**, see `2026-09-02-konnect-onboarding-pairing-design.md`
- `pw-loopback`-based routing
- Any change to `pw-record --target 0` or the recorder's link discovery
- Windows implementations of routing, ringtone or autostart — stubs only
- SMS (still impossible: the handset exposes no MAP profile)
