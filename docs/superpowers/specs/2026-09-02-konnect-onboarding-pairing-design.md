# Konnect — In-App Bluetooth Pairing and the 1a–1e Onboarding Flow

**Date:** 2026-09-02
**Status:** Design approved by user; implementation plan not yet written
**Builds on:** `2026-09-01-konnect-settings-wizard-design.md`
**Design source:** Claude Design project `70020592-a973-4c4b-808d-142a94fcb522`, artboards 1a–1e
**Target platform:** Ubuntu 24.04 (Linux backend only; Windows remains stubbed)

---

## 1. Summary

Replace the four-step select-and-connect wizard with the design canvas's five-state
onboarding flow, and build the Bluetooth capability those states require:

| State | Screen | New capability needed |
| --- | --- | --- |
| 1a | Bluetooth is off | Read and write `org.bluez.Adapter1.Powered` |
| 1b | Looking for your JioPhone | `StartDiscovery` + `InterfacesAdded` stream |
| 1c | Found N phones | Rank discovered devices, connect to one |
| 1d | Pairing PIN | `org.bluez.Agent1` + `Device1.Pair()` |
| 1e | Connected | Existing `verifyLink`, plus the setup checks folded in |

The load-bearing change is that Konnect stops requiring a phone that is *already paired*
in the system Bluetooth settings. It discovers and pairs the handset itself.

### 1.1 This reverses a recorded non-goal

`2026-09-01-konnect-settings-wizard-design.md` says, in §3 and again in §17:

> **Wizard scope** — Guided first-run onboarding: select + connect only. **No in-app
> pairing** — no `StartDiscovery`, no `org.bluez.Agent1`. Pairing stays in the system
> Bluetooth settings.

That was a scope decision, not a feasibility finding — no technical blocker was recorded.
It is reversed here deliberately, on 2026-09-02, at the user's direction. §17 of the prior
spec must be amended to point at this document rather than left contradicting the code.

---

## 2. Verified facts

Read from the developer machine on 2026-09-02, not assumed:

| Fact | Value |
| --- | --- |
| Adapter object | `/org/bluez/hci0`, `Powered=true`, `Discovering=false` |
| Adapter identity | `vicky-MS-7C95`, `78:46:5C:8E:35:AE` |
| A known phone | `OnePlus 10R 5G`, `Class=0x5a020c`, `Icon="phone"`, `Paired=true`, `Connected=false` |
| CoD major class | `(0x5a020c >> 8) & 0x1f == 0x02` — Phone |
| The JioPhone's advertised name | `F120B` — **not** "JioPhone" |
| OBEX agent precedent | `src/main/backend/linux/opp.js` already registers an `org.bluez.obex.Agent1` |

Two consequences follow directly:

1. **Filtering on the name "JioPhone" would hide the target handset.** The canvas's
   "Found 2 JioPhones" headline is aspirational copy, not a filter specification.
   Identification uses `Icon === 'phone'` or CoD major class `0x02`.
2. **Registering a D-Bus agent is already a solved problem in this codebase.** The
   pairing agent follows `opp.js`'s shape rather than inventing one.

---

## 3. Decisions taken

| Question | Decision |
| --- | --- |
| Scope | **Full in-app pairing.** Adapter power control, discovery, agent, and `Pair()`. All five states are real. |
| Setup checks | **Folded into 1e.** Failing checks render inline with their `[Fix]` button before `[Open dialer]`. Non-blocking, matching today's behaviour. |
| Scan results | **Ranked, never filtered.** Phones first; everything else behind a `Show all devices` disclosure. |
| Binding | **Keep the relaunch.** `selectDevice()` still relaunches; 1e shows the existing `res.relaunching` state honestly. |
| Default agent | **Never `RequestDefaultAgent`.** See §5.2. |
| Agent failure | **Degrade, never dead-end.** See §7. |

### 3.1 Why ranked and not filtered

BlueZ populates `Class` and `Icon` asynchronously during discovery. A device appears via
`InterfacesAdded` with little more than an address, and its name and class arrive in later
`PropertiesChanged` signals — sometimes seconds later, sometimes never for a handset that
does not answer the remote-name request. A hard filter on "is a phone" therefore hides the
target device for an unpredictable window, with no user-visible way to override it.

Ranking gets the same headline ("Found 2 phones") and the same top-of-list result, while a
device that never reports a class stays reachable.

### 3.2 Why the relaunch stays

Unchanged from `2026-09-01`'s §3.1: the backend threads `mac` into four long-lived
subsystems. First run is arguably a special case — there is no bound backend to tear down,
only the no-handset stubs — but introducing a second binding path would put an exception
inside the invariant the prior spec deliberately kept simple. 1e reuses the
`res.relaunching` branch that `renderDone()` already implements.

---

## 4. Where the capability lives

### 4.1 The constraint that decides this

`src/main/backend/linux/index.js` has two branches. When `mac === null` it returns a
backend whose `connect`, `dial`, `getStatus` and the rest are rejections and `NO_HANDSET`
sentinels. **That branch is exactly when onboarding runs.** Any pairing capability placed
behind the bound-handset path is unreachable at the only moment it is needed.

### 4.2 A `backend.adapter` namespace

The backend already namespaces a sub-capability that is not a handset operation:
`backend.audio.*`, present in both branches. Pairing follows that established shape rather
than inventing a parallel lifecycle or widening `BACKEND_METHODS`.

```
backend.adapter = {
  power(),                 // -> boolean | null when no adapter
  setPower(on),            // -> boolean, rejects with the real reason
  onPower(cb),             // -> unsubscribe
  startScan(), stopScan(),
  onDiscovered(cb),        // -> unsubscribe; { mac, name, icon, cls, paired, rssi }
  pair(mac),               // -> resolves on Paired=true
  onPairingRequest(cb),    // -> unsubscribe; { mac, passkey }
  confirmPairing(ok),      // resolves the pending Agent1 reply
}
```

`BACKEND_METHODS` is left alone: these are adapter operations, and listing them as backend
methods would oblige the mock and Windows stubs to pretend they are handset operations.
The namespace is present-but-inert on backends that cannot implement it, exactly as
`audio` already is.

### 4.3 New files

| File | Contains |
| --- | --- |
| `src/main/backend/linux/adapter.js` | `Powered` read/write/watch, discovery start/stop, the `InterfacesAdded`/`InterfacesRemoved` device stream |
| `src/main/backend/linux/pairing.js` | `org.bluez.Agent1` registration, `Device1.Pair()`, passkey plumbing |
| `src/shared/onboarding-state.js` | The pure state machine (§6.2) |
| `src/renderer/onboarding.js` | Rendering and IPC wiring; replaces `wizard.js`'s four-step model |

The single `backend.adapter` namespace in §4.2 is assembled from both backend modules by
`linux/index.js`, the same way `backend.audio` is assembled today. They are separate files
because they have separate lifetimes: discovery starts and stops per onboarding session,
while the agent is registered once and released on dispose.

`src/renderer/wizard.js` is retired. Its concurrency discipline is not: the `renderToken`
guard that stops an out-of-order async tail from appending to a superseded render carries
over to `onboarding.js` unchanged, as does the "never dead-end on a failed Fix" rule that
keeps a manual command on screen.

---

## 5. Pairing mechanics

### 5.1 The agent

Registered on the system bus at `/org/konnect/agent` with capability `KeyboardDisplay`,
which is what makes BlueZ choose numeric comparison — the six-digit code both sides
display — for a handset that supports Secure Simple Pairing. The canvas's 1d ("check that
the phone shows the same code, then press Pair") is exactly `RequestConfirmation`.

Methods implemented: `RequestConfirmation`, `RequestPinCode`, `DisplayPasskey`,
`AuthorizeService`, `Cancel`, `Release`.

Only `AuthorizeService` is answered automatically, and only for the mac currently being
paired — every other device is rejected. `RequestConfirmation` and `RequestPinCode` always
go to the user. `Cancel` and `Release` are lifecycle notifications, not requests, and are
handled by clearing pending state. An agent that blanket-authorises any caller is a
standing security hole, so the target-mac check is the load-bearing line in this file.

### 5.2 Never `RequestDefaultAgent`

BlueZ routes an agent callback for a `Device1.Pair()` to the agent registered by the D-Bus
connection that called `Pair()`, falling back to the default agent only when the calling
connection has registered none. Registering a plain agent is therefore sufficient, and
calling `RequestDefaultAgent` would make Konnect the handler for *every* pairing prompt on
the desktop, including ones started from GNOME or KDE settings.

**Verified 2026-09-02:** `RegisterAgent` without `RequestDefaultAgent` succeeds on BlueZ 5.72
against adapter `/org/bluez/hci0`, confirming BlueZ accepts a plain agent registration from
this application. Callback routing to the registering connection was NOT empirically
exercised — the probe never calls `Pair()`, per the never-pair constraint — and remains
inferred from BlueZ's documented agent-selection behaviour. Task 9's hardware run is where
it is confirmed in practice; if routing instead reaches the desktop's default agent, §7.1's
degraded path takes over, which is what §7.1 exists for.

### 5.3 Ordering

`Pair()` then `Connect()`, never the reverse. A `Connect()` on an unpaired device triggers
its own pairing through whichever agent BlueZ picks, which is the exact loss of control
this design exists to avoid.

---

## 6. The onboarding flow

### 6.1 Shell behaviour

Onboarding is **full-window** — the title bar and a centred card, with `#shell` hidden —
when it is blocking. It stays a **modal over the app shell** when dismissible.

This preserves `2026-09-01` §4.2 unchanged: the flow is a wall only when bootstrap
resolution found no paired device at all. When a handset was resolved the app is usable
and onboarding is a suggestion, so hiding the app behind it would be a lie.

### 6.2 The state machine

Extracted to `src/shared/onboarding-state.js` as a pure reducer — `(state, event) ->
state` — with no DOM and no IPC, following the `src/shared/phone.js` precedent. This is
what makes the flow testable under `node --test` without Electron.

```
                  power on
   bt-off ──────────────────▶ scanning ──pick──▶ pairing ──paired──▶ connecting
      ▲                          │  │               │                     │
      └────── power off ─────────┘  │        confirm passkey              ▼
                                    │               │                 connected
                                    │         (reject/timeout)             │
                                    │               └──────▶ scanning  [Open dialer]
                                    │
                                    └── pick an ALREADY-PAIRED device ──▶ connecting
     1a                        1b / 1c            1d                      1e
```

The `pick` event therefore has two outcomes, decided by the device's `Paired`
property at the moment it is chosen, not by which list it came from: unpaired
goes to `pairing`, already-paired goes straight to `connecting`.

`scanning` and `found` are one state with a device count, not two: the canvas's 1b and 1c
differ only in whether the list is empty.

### 6.3 State detail

| State | Shows | Actions |
| --- | --- | --- |
| `bt-off` | Adapter name and why it is unavailable | `Turn on Bluetooth`, `Open system settings` |
| `scanning` (0 devices) | Spinner, "Looking for your JioPhone…", the phone-side instruction | `Cancel` |
| `scanning` (n>0) | "Found n phones", ranked list, `Show all devices (m more)` | `Connect to <name>`, `Scan again` |
| `pairing` | Six-digit passkey, "check the phone shows the same code" | `Pair`, `Cancel` |
| `connecting` | Progress against the chosen handset | — |
| `connected` | `verifyLink` results, plus failing setup checks with `[Fix]` | `Open dialer` |

### 6.4 1e in detail

`verifyLink(mac)` results render as they do today. Then `runSetupChecks(mac)` runs, and
**only failing** checks are listed, each with its `[Fix]` button and the existing
never-dead-end behaviour: a failed remediation leaves the manual command on screen rather
than re-rendering it away. A clean link shows the canvas's success copy and nothing else.

`[Open dialer]` calls `selectDevice(mac)`, which relaunches. The button's own state
becomes "Starting Konnect with your JioPhone…" via the existing `res.relaunching` branch.

---

## 7. Error handling

Every failure resolves to a state the user can act from. None dead-ends.

| Failure | Behaviour |
| --- | --- |
| No `hci0` object | `bt-off` with "No Bluetooth adapter found"; no Turn-on button, since there is nothing to turn on |
| `Powered = true` rejected (rfkill, permissions) | Stay in `bt-off`, show the D-Bus reason, offer `Open system settings` |
| Adapter disappears mid-flow | Return to `bt-off` from any state |
| Nothing discovered within 30s | Stay in `scanning`: "Still looking — make sure the phone is discoverable" |
| Device vanishes between listing and connect | Remove the row, return to `scanning` with the reason |
| `Pair()` rejected, cancelled, or timed out | Return to `scanning` with the reason on that device's row |
| Already paired but not connected | Skip `pairing` entirely, go straight to `connecting` |
| **`RegisterAgent` fails** | **Degrade to the previous flow** (§7.1) |

### 7.1 The agent-registration fallback

Another agent may already hold the name, or the routing assumption in §5.2 may prove
wrong. Either way the feature must not become a wall.

On `RegisterAgent` failure, onboarding drops to the behaviour this design replaces: list
already-paired devices, tell the user to pair in the system Bluetooth settings, and offer
select-and-connect. That path is the shipped, verified `2026-09-01` flow, so the fallback
is not new code so much as the old code kept reachable.

The degraded state is visibly different — it says pairing is unavailable and why — because
silently offering fewer capabilities reads as the app being broken.

---

## 8. IPC surface

Declared in `src/main/ipc.js`, which states that one place is where every renderer-reachable
capability is declared. Implementations live in the backend namespace, not in `ipc.js`.

| Channel | Direction | Purpose |
| --- | --- | --- |
| `adapter:power-get` | invoke | Current `Powered`, or `null` when no adapter |
| `adapter:power-set` | invoke | Write `Powered`; rejects with the real reason |
| `scan:start` / `scan:stop` | invoke | `StartDiscovery` / `StopDiscovery` |
| `pair:start` | invoke | `Pair()` the given mac |
| `pair:confirm` | invoke | Resolve a pending `RequestConfirmation` |
| `adapter:changed` | event | `{ powered, present }` |
| `scan:device` | event | One discovered or updated device |
| `pair:request` | event | `{ mac, passkey }` |

Discovery must be stopped when onboarding closes and when the window is destroyed — an
adapter left discovering drains the handset's battery and degrades every other Bluetooth
link on the machine.

---

## 9. Testing

| File | Covers |
| --- | --- |
| `test/onboarding-state.test.js` | Every transition in §6.2 as a pure reducer: no DOM, no Electron |
| `test/adapter.test.js` | Power read/write, discovery stream dedupe, phone ranking, late-arriving `Class` promoting a device up the list |
| `test/pairing.test.js` | `RequestConfirmation` emits the passkey; `confirmPairing` resolves the reply; `Pair()` rejection surfaces its reason; a non-target device is **not** auto-authorised |
| `test/setup.test.js` (extend) | The new IPC channels route to the adapter namespace |

All against injected fakes, matching how `device-select.test.js` and
`telephony-helpers.test.js` inject `getInterfaceFn` and `systemBusFn` today. No test
requires a live handset.

Two things tests cannot prove, which need the real handset and are called out rather than
assumed:

- That BlueZ routes the confirmation to our agent rather than the desktop's (§5.2).
- That the F120B negotiates numeric comparison rather than a legacy PIN entry.

---

## 10. Build order

1. **Verify the §5.2 agent-routing assumption** against the real handset. Everything else
   depends on it, and the §7.1 fallback becomes the primary path if it fails.
2. `adapter.js` — power and discovery, with tests.
3. `onboarding-state.js` — the reducer, with tests. No UI yet.
4. `pairing.js` — agent and `Pair()`, with tests.
5. IPC and preload wiring.
6. `onboarding.js` — rendering against the canvas, replacing `wizard.js`.
7. Amend `2026-09-01-konnect-settings-wizard-design.md` §3 and §17.

---

## 11. Non-goals

- Pairing anything that is not a phone. The ranking is a convenience; the flow's purpose
  is binding one handset.
- Multiple simultaneous handsets. `device_mac` stays single-valued.
- `RequestDefaultAgent` and any system-wide pairing role (§5.2).
- Windows pairing — the namespace is stubbed, as `audio` already is.
- Removing or un-pairing a device from within Konnect. The canvas's Settings artboard
  draws "Forget this phone"; it has no backend and stays unbuilt.
