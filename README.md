# Konnect

A desktop PC suite for the JioPhone (KaiOS) over Bluetooth: place and take
calls from the PC, import contacts, keep call logs, record calls, and export
reports.

Konnect is a thin Electron GUI over three Linux daemons that already speak the
Bluetooth profiles — **oFono** (HFP hands-free: dial, answer, hangup, call
state, network, battery), **BlueZ obexd** (contacts pushed in over OBEX), and
**PipeWire/WirePlumber** (SCO call audio). There is no AT-command parsing and
no OBEX protocol code in this repo.

Developed against a LYF JioPhone F120B on Ubuntu 24.04.

## What it does

- **Calls** — dial, answer, hang up, DTMF, live call state and duration, an
  incoming-call popup with contact lookup
- **Contacts** — imported by pushing them from the handset over OBEX
- **Call logs** — searchable history, stats, recently dialled in the tray menu
- **Recording** — per-call capture via `pw-record`, with a waveform player
- **Export** — calls/contacts as CSV, contacts as vCard, a PDF report
- **Google (optional)** — sign-in, contact sync, backup of recordings to Drive
- **Setup wizard** — checks the four host prerequisites and fixes them

### What it can't do

- **SMS is impossible over Bluetooth on this handset.** Messages need the MAP
  profile; the F120B's SDP records don't advertise it. No amount of effort
  changes this.
- **PBAP phonebook pull is a dead end** on this handset, which is why contacts
  arrive by the phone pushing them, rather than the PC fetching them.
- **Windows** has a stub backend only. Linux is the supported platform.

## Running it

`make` on its own lists every target.

```
make dev     # run against the real handset
make mock    # run against the mock backend, no handset needed
make test    # unit tests (node --test)
make dist    # build the AppImage and .deb into dist/
```

`make verify-<name> ARGS=…` runs the manual hardware probes in `scripts/` —
`verify-device`, `verify-telephony`, `verify-recording`, `verify-pairing-agent`.
These talk to a real paired handset; the unit tests don't.

### Mock mode

`KONNECT_MOCK=1` swaps in a fake backend so the whole UI is exercisable with no
hardware. Extra flags shape what that fake reports:

| Variable | Effect |
| --- | --- |
| `KONNECT_MOCK_NO_PHONE=1` | scanning turns up only non-handsets, so the empty state holds |
| `KONNECT_MOCK_BT_OFF=1` | Bluetooth adapter reports powered off |
| `KONNECT_MOCK_INCOMING=<ms>` | simulate an incoming call after that many milliseconds |
| `KONNECT_MOCK_INCOMING_NUMBER` | the number it comes from (use one in Contacts to exercise caller-ID lookup) |

## Releasing

Bump the version and push to `main`:

```
npm version minor    # or patch / major - edits package.json
git push
```

`.github/workflows/release.yml` notices the version field moved, runs the
tests, builds the `.deb` and AppImage, and uploads them to a **draft** GitHub
Release. Review it, then press Publish — that is also the moment GitHub
creates the `v0.2.0` tag. Touching `package.json` without changing the version
builds nothing.

To do the same by hand: `make dist ARGS="--publish always"` with `GH_TOKEN`
set, or plain `make dist` to build into `dist/` without uploading.

## First run

The in-app setup wizard checks and repairs four things:

1. oFono is installed
2. the oFono service is running
3. PipeWire hands HFP signalling to oFono, via
   `~/.config/wireplumber/bluetooth.lua.d/51-konnect-hfp.lua`
4. the handset's HFP modem is online

Step 3 is the load-bearing one: PipeWire's native HFP backend otherwise owns
RFCOMM channel 3 and oFono can never claim it, so the modem never comes up.
The restart order in that remedy matters too. Every check offers the exact
shell command to run by hand if the privileged path is unavailable — see
`src/main/setup.js`, which is the source of truth for both.

## Google account (optional)

Absent credentials mean the feature is simply unconfigured — never a startup
failure. To enable it, drop an OAuth client at
`~/.config/konnect/google.json`. The requested scopes are deliberately narrow:
`contacts.readonly` (Konnect never writes to your address book) and
`drive.file` (it can only touch files it created).

## Where your data lives

| Path | Contents |
| --- | --- |
| `~/Konnect/recordings` | call recordings |
| `<electron userData>/konnect.db` | contacts, call logs, settings |
| `~/.config/konnect/google.json` | Google OAuth client, if configured |

## Layout

```
src/main/            Electron main process — IPC, tray, call session, store
src/main/backend/    linux/ (BlueZ + oFono + PipeWire), mock/, windows/ stub
src/renderer/        UI: dialer, call logs, settings, onboarding
src/shared/          phone numbers, vCard, waveform peaks, speed dial
test/                node --test suites
scripts/             manual hardware probes
docs/superpowers/    design specs and implementation plans
```

`src/main/backend/interface.js` holds the contract every backend implements;
adding a platform means satisfying that list and nothing else.
