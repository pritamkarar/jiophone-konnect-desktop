# Konnect — JioPhone PC Suite

**Date:** 2026-09-01
**Status:** Design approved; phase 0 feasibility spike complete
**Target device:** LYF JioPhone F120B (KaiOS), BD_ADDR `44:CD:0E:AD:5E:34`
**Target platform:** Ubuntu 24.04 first; Windows backend stubbed for later

---

## 1. Summary

A desktop PC suite for the JioPhone over Bluetooth: device status, contacts
import, a dialer that places and receives calls through the handset, call
logs, call recording, and report export.

The application is a thin GUI over three Linux daemons that already implement
the Bluetooth protocols. We write no AT-command parsing and no OBEX protocol
code.

| Daemon | Role |
| --- | --- |
| **oFono** (`hfp_hf_bluez5`) | HFP hands-free: dial, answer, hangup, call state, network status |
| **BlueZ obexd** | OBEX Object Push: receives contacts pushed from the handset |
| **PipeWire / WirePlumber** | SCO call audio, routed automatically |

---

## 2. Verified capabilities

Every row below was tested against the physical handset on 2026-09-01.

| Capability | Result | Evidence |
| --- | --- | --- |
| HFP hands-free connection | ✅ works | oFono modem `Online=true`, 4 interfaces |
| Outgoing call | ✅ works | `dialing → alerting → active`, hangup OK |
| Incoming call + caller ID | ✅ works | `state=incoming from=+919804464251` |
| Answer from PC | ✅ works | `Answer -> (ok)`, active in 1s |
| Call duration | ✅ works | `StartTime` emitted on answer only |
| Network status | ✅ works | `Status=registered Name="JIO" Strength=100` |
| Battery | ✅ works | `BatteryChargeLevel=5` (HFP 0–5 scale) |
| Call audio, both directions | ✅ automatic | WirePlumber links SCO to default devices |
| Audio capture | ✅ works | bit-exact via `--target 0` + `pw-link` |
| PBAP phonebook access | ❌ **not viable** | see §2.2 |
| OBEX Object Push (contacts in) | ✅ transport verified | RFCOMM ch 12 connects |
| **SMS** | ❌ **impossible** | no MAP profile in SDP records |

### 2.1 SMS is out of scope

The handset's SDP records advertise OBEX Object Push, A2DP, AVRCP, HSP AG,
HFP AG, PBAP PSE and PnP. **Message Access Profile (`0x1132`/`0x1134`) is
absent.** MAP is the only Bluetooth profile that carries messages, so SMS
cannot be implemented over Bluetooth on this device at any effort level.

A USB/ADB route may exist (KaiOS is Firefox OS derived) but is a separate
project with a different transport, and is not part of this spec.

---

### 2.2 PBAP is a dead end on this handset

PBAP is advertised in SDP (`0x112f`, RFCOMM channel 19) and the transport
works — a raw socket to channel 19 connects every time. But the handset does
not complete the OBEX handshake:

```
obexd: connect_cb: Timed out waiting for response
```

Across roughly a dozen attempts exactly one session succeeded, at 11:46, when
a consent popup appeared on the handset and was accepted.

**The device-class bootstrap in §4.1 appears to have removed that popup.**
Before the change the phone treated the PC as an unknown computer and prompted
per OBEX session. After it, the phone treats the PC as a car kit — a trust path
that never prompts and instead obeys a stored per-device preference. The
handset's paired-device menu exposes no such preference, so the setting is
permanently off with no way to turn it on. Confirmed by inspection on the
device.

This is a direct trade: the class change is **required** for HFP (dialer,
incoming calls, recording) and **fatal** to PBAP. The dialer wins; contacts
arrive over OPP instead (§6).

Two further constraints found while investigating, both relevant to §6:

- **obexd's OBEX CONNECT timeout is ~10 seconds**, not the D-Bus call timeout.
  Any consent-gated OBEX flow has a ten-second window, whatever we pass.
- **Powering the oFono modem off drops the whole ACL link**, after which SDP
  lookups fail with `Unable to find service record` until the device is
  reconnected. Never toggle HFP to work around an OBEX problem.

Do not re-attempt PBAP on this handset. This section exists so the dead end is
not rediscovered.

---

## 3. Architecture

```
renderer/  HTML + CSS + JS (no framework)
  Status | Contacts | Dialer | Call log | Recordings | Export
              ▲
              │ contextBridge IPC (typed channels)
main/
  backend/index.js ─── platform switch
   ├─ linux/
   │   device.js      → BlueZ    org.bluez.Device1, Battery1
   │   telephony.js   → oFono    VoiceCallManager, NetworkRegistration
   │   phonebook.js   → obexd    PhonebookAccess1
   │   recorder.js    → pw-record + pw-link
   ├─ windows/        → stub, throws Unsupported
   └─ mock/           → fixtures, no phone required
  store.js   → SQLite
  export.js  → CSV + printToPDF
```

**Stack:** Electron, Node main process, `dbus-next` for D-Bus, plain HTML/CSS/JS
renderer. Chosen for one language end to end and free PDF export via
`printToPDF`.

### 3.1 Backend interface

The portability seam. Windows work later means writing one module, not
untangling the app.

```js
listDevices() · connect(mac) · disconnect()
onDeviceStatus(cb)   // {connected, battery, signal, operator, roaming, model}
dial(number) · answer() · hangup() · sendDtmf(d)
onCall(cb)           // {id, direction, state, number, name, startedAt}
startContactImport() · cancelContactImport()   // OPP receive, §6
startRecording(callId) · stopRecording(callId)
```

`mock/` is not scaffolding: it is how the renderer is developed without the
phone and how tests run without hardware.

---

## 4. Setup and bootstrap

The spike proved setup is not trivial and must be a guided wizard. Three
distinct problems, each of which fails silently if mishandled.

### 4.1 Device class bootstrap

The handset refuses HFP to a device whose Class of Device says *Computer*:

```
bluetoothd: Hands-Free unit failed connect to 44:CD:0E:AD:5E:34:
            Connection refused (111)
```

Setting the adapter to `0x240404` (Audio/Video · Hands-free) makes the
connection succeed. **The phone then caches our role permanently** — a later
reconnect succeeded after `bluetoothd` had already reverted the class to
`0x3c0104`.

Therefore the class change is a **one-time bootstrap, not a persistent
setting**:

1. `sudo hciconfig hci0 class 0x240404`
2. Power on the oFono modem (establishes HFP)
3. Let `bluetoothd` revert the class naturally

This deliberately avoids writing `Class` into `/etc/bluetooth/main.conf`,
which would make every other device see the desktop as a car kit forever.

If a user later removes and re-adds the pairing, the bootstrap must be
repeated. The wizard detects this (HFP refuses) and offers to redo it.

### 4.2 Daemon start ordering

oFono and PipeWire compete for the HFP profile UUID. Wrong order produces a
silent half-working state — a modem that exists but can never power on:

```
ofonod: RegisterProfile() replied an error:
        org.bluez.Error.NotPermitted, UUID already registered
```

Required order:

1. Write `~/.config/wireplumber/bluetooth.lua.d/51-konnect-hfp.lua`
   with `bluez5.hfphsp-backend = "ofono"`
2. `systemctl --user restart wireplumber` — releases the HFP UUID
3. `systemctl restart ofono` — claims it
4. `systemctl --user restart wireplumber` — attaches to the oFono backend

Step 4 is required because WirePlumber's oFono backend fails to start if oFono
was unavailable when WirePlumber came up (`Failed to start HFP/HSP backend
ofono`). The dependency is mutual.

### 4.3 Wizard checks

Each step shows an explicit pass/fail state so a broken setup is visible
rather than mysterious:

- `ofono` installed → else show `sudo apt install ofono`
- WirePlumber override present and backend attached
- HFP modem reaches `Powered=true, Online=true`
- OBEX receive agent registers (contact import is exercised in-app, §6)

### 4.4 Privilege handling

Three setup actions need root: installing oFono, restarting it, and the
one-time class bootstrap. An Electron app cannot acquire root silently.

The wizard runs each through **`pkexec`**, which raises the desktop's own
authentication dialog and needs no custom polkit policy:

```sh
pkexec apt install -y ofono
pkexec systemctl restart ofono
pkexec hciconfig hci0 class 0x240404
```

If `pkexec` is unavailable or the user cancels, the wizard falls back to
displaying the exact command with a copy button and a "recheck" action. Setup
must never be a dead end because a password prompt was dismissed.

All three are one-time. Normal operation needs no elevation: oFono, obexd and
PipeWire are all reachable over D-Bus as the session user.

---

---

## 5. Data model

```sql
contacts(id, uid, name, number_e164, number_raw, type, synced_at)
calls(id, direction, number_e164, contact_id, started_at, ended_at,
      duration_s, source, recording_path)
settings(key, value)
```

`source` is `'pbap'` or `'live'` and it matters.

### 5.1 Call log has one writer

With PBAP unavailable (§2.2) there is no historical import path, so **every
call row comes from live oFono observation**. `source` is retained in the
schema as `'live'` for all rows, because an OPP or USB import path may exist
later and a column is cheaper than a migration.

Consequences:

- The call log **starts empty on first run** and builds from that point.
- Calls placed while the app is closed are **not recorded anywhere** — the
  handset's own log is unreachable.
- The UI must state this plainly on an empty call log ("History starts when
  Konnect first runs; calls made while Konnect is closed are not captured")
  rather than showing a bare empty list that reads like a sync failure.

An earlier draft specified a two-writer merge between PBAP and live rows, with
±60s dedupe. **That logic is deleted, not deferred** — there is no second
writer to merge against.

## 6. Contacts import over OPP

PBAP is unavailable (§2.2), so contacts move in the opposite direction: the
**handset pushes** them to the PC over OBEX Object Push, which is advertised
on RFCOMM channel 12 and connects reliably.

### 6.1 Flow

1. User clicks **Import contacts** in Konnect.
2. Konnect registers an `org.bluez.obex.Agent1` on the session bus and shows
   step-by-step instructions.
3. On the handset: Contacts → Options → Share / Send via Bluetooth → select
   `vicky-MS-7C95`.
4. `obexd` receives the vCards; our agent auto-accepts pushes **from the paired
   JioPhone only** and writes them to a staging directory.
5. Konnect parses the vCards, shows a preview with add/skip counts, and merges
   into the `contacts` table on confirmation.

The agent is unregistered when the import screen closes, so Konnect is not a
standing OBEX drop target.

### 6.2 Why this is an acceptable substitute

PBAP would have been a one-click pull, and this is not — it needs several taps
on the handset. But the sync was **always** going to be user-initiated and
consent-gated: even when PBAP worked it demanded an on-screen approval within
ten seconds. The end-to-end effort is comparable, and OPP works reliably
instead of intermittently.

What is genuinely lost is **call history import**, which OPP cannot carry.
That is handled in §5.1.

### 6.3 Trust boundary

Incoming OBEX is a network input from a device, so the agent:

- accepts pushes **only** while an import is in progress,
- accepts **only** from `44:CD:0E:AD:5E:34`,
- accepts **only** `text/vcard` / `text/x-vcard`, rejecting other MIME types,
- caps individual files and total transfer size,
- writes to a staging directory, never directly into the library,
- parses defensively — a malformed vCard skips that entry rather than aborting
  the import or crashing.

### 6.4 vCard parsing

OPP delivers vCard 2.1, commonly with `QUOTED-PRINTABLE` encoded
names. We hand-roll a ~80 line parser for this narrow subset rather than take a
dependency; general-purpose vCard libraries frequently mishandle 2.1
quoted-printable. It gets a unit test with fixtures captured from the handset
during phase 3.

Contacts remain a **read-only mirror** — no write path back to the phone, so no
risk of corrupting its phonebook.

## 7. Call recording

### 7.1 Routing is automatic — do not build loopbacks

During an active call PipeWire creates two **streams** (not devices):

```
bluez_input.<mac>.0    Stream/Output/Audio   remote voice into the graph
bluez_output.<mac>.1   Stream/Input/Audio    local voice out to the phone
```

WirePlumber links both to the default devices with no help from us. Verified
during a live call:

```
bluez_input  → alsa_output (speakers)
alsa_input   → bluez_output
```

An earlier draft of this design specified two `pw-loopback` instances to build
this routing. **That is unnecessary and must not be implemented.**

### 7.2 Capture recipe

`bluez_input` is `Stream/Output/Audio` — a *playback* stream, structurally
like a music player. It is not a source, so `pw-record --target <node>` cannot
attach to it and **silently falls back to the default source**, producing a
recording of the wrong audio with no error. This was observed: two recordings
targeting different nodes came back with identical md5sums.

The verified approach is an unlinked recorder plus explicit port links:

```sh
pw-record --target 0 --channels 2 out.wav     # --target 0 = do not auto-link
pw-link bluez_input.<mac>.0:output_FL  pw-record:input_FL   # remote → left
pw-link <mic-source>:capture_MONO      pw-record:input_FR   # local  → right
```

Measured bit-exact against the source (`mean -24.1 dB`, `max -21.1 dB` on both
source and capture, flat across every second).

One recorder, two channels, two links. Remote voice on the left, local voice
on the right — separable later, no mixing stage, no null sink.

Audio is 8 kHz CVSD (16 kHz if mSBC negotiates); telephone quality is inherent
to HFP.

### 7.3 Behaviour

Auto-record all calls while the master toggle is on, with a visible REC
indicator.

`pw-record` writes WAV, so encoding is a second step. On hangup the WAV is
encoded to Opus and removed:

```sh
ffmpeg -i <temp>.wav -c:a libopus -b:a 24k ~/Konnect/recordings/<call_id>.opus
```

A temp file rather than piping `pw-record` straight into ffmpeg, because the
`pw-link` calls happen *after* the recorder node exists — a two-stage pipeline
keeps that ordering easy to reason about and leaves the raw capture on disk if
encoding fails. Indexed by `calls.recording_path`.

---

## 8. Export

- **Call log → CSV**, **Contacts → CSV / vCard**
- **Report → PDF** via a styled HTML page rendered with `printToPDF`:
  total calls, talk time, in/out/missed split, top contacts, date range.

No XLSX; CSV opens in Excel and avoids a dependency.

---

## 9. Background behaviour

Tray-resident, autostarts with the session, reconnects automatically.
Incoming calls raise a desktop notification and a call window with
Answer/Reject. Tray tooltip shows device, battery and signal.

---

## 10. Testing

`node:test` + `node:assert` — built into Node 24, no framework.

Unit tested (pure functions):
- vCard 2.1 parsing including quoted-printable
- E.164 normalisation for Indian numbers
- Call-log merge and dedupe (§5.1)
- CSV shaping

The `mock` backend drives renderer smoke tests. Device behaviour gets a
written manual checklist; mocking BlueZ, oFono and PipeWire simultaneously
would cost more than it catches.

**Verification scripts get the same scrutiny as product code.** During the
spike a state-parsing bug caused a test to skip the feature under test while
still exiting zero and printing a plausible transcript. Any script that
conditionally exercises a feature must fail loudly when the condition never
fires.

---

## 11. Risks and open items

| Item | Status |
| --- | --- |
| PBAP | **Closed — not viable** (§2.2). Do not re-attempt. |
| OPP import end-to-end | Transport verified; the receive agent and handset share flow are built and validated in phase 3. |
| No historical call log | Accepted limitation. UI must explain it (§5.1). |
| End-to-end recording during a real call | Mechanism proven on an equivalent stream; the only difference is the source node name. Confirm in phase 5. |
| Re-pairing loses the hands-free role | Wizard detects and redoes the class bootstrap (§4.1) |
| `node:sqlite` vs `better-sqlite3` | Prefer the stdlib module if Electron's bundled Node exposes it; one-line check in phase 1 |
| Contact photos | vCard `PHOTO` may arrive over OPP; parsed but not displayed initially |
| Windows backend | Stub only. No public API for HFP hands-free; SCO audio unreachable. Separate project. |

---

## 12. Build order

```
0. SPIKE   ✅ COMPLETE — HFP, dial, incoming, answer, status, audio, capture
1.         backend interface + mock + SQLite
2.         tray, device status, setup wizard (§4)
3.         contacts via OPP receive agent (§6)
4.         dialer + incoming call window
5.         recording (§7)
6.         call log persistence + empty-state messaging (§5.1)
7.         CSV + PDF export
```
