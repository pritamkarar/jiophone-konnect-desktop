# Konnect — Hold, Swap and Conference; Handsfree Extras; PnP Identity

**Date:** 2026-09-05
**Status:** Design approved by user in chat; implementation plan not yet written
**Builds on:** `2026-09-01-jiophone-konnect-design.md` (§2 verified capabilities, §5 call log), `2026-09-01-konnect-settings-wizard-design.md` (Settings handset row)
**Target device:** LYF JioPhone F120B (KaiOS), BD_ADDR `44:CD:0E:AD:5E:34`
**Target platform:** Ubuntu 24.04 (Linux backend only; Windows remains stubbed)

---

## 1. Summary

Three additions, all read or driven through interfaces Konnect already binds:

| Item | Source | Outcome |
| --- | --- | --- |
| Hold, swap, and three-way calling | `org.ofono.VoiceCallManager` methods that telephony.js never exposed | A second call can be answered, held, swapped and merged from the PC. A second outgoing call can be placed once the first is held. |
| Own phone number | `org.ofono.Handsfree.SubscriberNumbers` | Read opportunistically; shown only when the handset reports one. The F120B does not (§2). |
| PnP identity | `org.bluez.Device1.Modalias` | Vendor, product and firmware version shown under the handset name in Settings and logged at startup. |

The approach is a thin pass-through (§3). Nothing new is modelled in main: the
renderer already keeps a map of live calls, `callsession.js` already persists
each call independently, and `index.js` already scopes the incoming popup by
call id. Those three learn about one new state (`held`) and one new flag
(`multiparty`), and two methods are added to the backend contract.

---

## 2. Verified handset facts

Every row was read from the live handset on 2026-09-05 with `busctl`, no
state change, no call placed.

| Query | Result |
| --- | --- |
| `org.ofono.Handsfree` `Features` | `three-way-calling`, `echo-canceling-and-noise-reduction`, `release-all-held`, `create-multiparty` |
| `org.ofono.Handsfree` `SubscriberNumbers` | **absent** |
| `org.ofono.Handsfree` `InbandRinging` | `false` |
| `org.ofono.Handsfree` `VoiceRecognition` | `false` (property present; the feature bit is not in `Features`) |
| `org.ofono.Modem` `Interfaces` | `VoiceCallManager`, `CallVolume`, `Handsfree`, `NetworkRegistration` |
| `org.ofono.VoiceCallManager` methods | `Dial`, `DialLast`, `DialMemory`, `HangupAll`, `HangupMultiparty`, `CreateMultiparty`, `PrivateChat`, `HoldAndAnswer`, `ReleaseAndAnswer`, `ReleaseAndSwap`, `SwapCalls`, `Transfer`, `SendTones`, `GetCalls` |
| `org.bluez.Device1` `Modalias` | `bluetooth:v001Dp1200d1436` |

What follows from this:

- **Hold, swap, merge and decline-waiting are supported.** `three-way-calling`
  covers CHLD=1 and CHLD=2 (hold, swap, hold-and-answer), `release-all-held`
  covers CHLD=0 (decline a waiting call, release held calls), and
  `create-multiparty` covers CHLD=3.
- **Transfer and private chat are not.** `transfer` and `private-chat` are
  missing from `Features`, so `Transfer` and `PrivateChat` are out of scope
  even though oFono lists the methods. oFono lists every method on every HFP
  modem and returns an error for unsupported ones.
- **The own-number read is dead on this handset.** oFono sends `AT+CNUM` when
  the service-level connection comes up and publishes `SubscriberNumbers` only
  when the phone answers with at least one number. The F120B answers with
  none, which is normal for Jio SIMs that carry no MSISDN. The property is
  documented as optional; absent means "not provided", not "not yet read".
- **Modalias decodes as** vendor `0x001D` (Qualcomm Technologies
  International, Bluetooth SIG company identifier), product `0x1200`, device
  version `0x1436`. The Bluetooth Device ID profile encodes version as
  `0xJJMN` (major, minor, sub-minor), so `0x1436` is firmware **20.3.6**.

The commands, so the table can be re-checked on another handset:

```
MODEM=/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34
DEV=/org/bluez/hci0/dev_44_CD_0E_AD_5E_34
busctl --system call org.ofono $MODEM org.ofono.Handsfree GetProperties
busctl --system introspect org.ofono $MODEM org.ofono.VoiceCallManager
busctl --system get-property org.bluez $DEV org.bluez.Device1 Modalias
```

---

## 3. Approach: thin pass-through

Two approaches were weighed.

**A. Thin pass-through (chosen).** Add `swapCalls` and `createMultiparty` to
the backend contract. Fold the two awkward cases into methods that already
exist: `answer(id)` on a *waiting* call routes to `HoldAndAnswer`, and
`hangup(id)` on a *multiparty* call routes to `HangupMultiparty`. The renderer
derives every button from the live-call map it already holds. Smallest diff;
each piece sits beside its siblings.

**B. Main-owned call model.** A new module reduces the oFono stream into one
snapshot (`{active, held, waiting, conference}`) and exposes high-level
commands (hold, resume, merge, addCall). Cleaner renderer API, but it
duplicates the call map the renderer and session already keep, adds a
subsystem, and roughly doubles the test surface for two extra buttons.
Rejected.

---

## 4. Telephony and the backend contract

### 4.1 Call object

`toCall()` gains one field:

```js
{
  id, direction, state, number, name, startedAt,
  multiparty: Boolean(p.Multiparty),   // NEW
}
```

`state` already carries every oFono value through unchanged; `held` and
`waiting` simply start mattering. The full set is `dialing`, `alerting`,
`incoming`, `waiting`, `active`, `held`, `disconnected`.

### 4.2 `answer(id)` routes a waiting call through the manager

oFono defines `VoiceCall.Answer` for the `incoming` state only. A `waiting`
call is answered through `VoiceCallManager.HoldAndAnswer`, which holds the
active call and accepts the waiting one in a single CHLD=2. Telephony already
tracks each call's last-seen properties in `watched`, so:

```js
async answer(callId) {
  if (watched.get(callId)?.props?.State === 'waiting') {
    const mgr = await start();
    await mgr.HoldAndAnswer();
    return;
  }
  const call = await iface(callId, 'org.ofono.VoiceCall');
  await call.Answer();
}
```

The incoming popup's Answer button therefore needs no change.

oFono refuses `HoldAndAnswer` when a held call *and* an active call already
exist (it would need a third slot). The error surfaces to the popup as it
does today; §12 covers wording.

### 4.3 `hangup(id)` routes a conference through the manager

`VoiceCall.Hangup` on a member of a multiparty group needs the
`release-specified-active-call` feature, which the F120B lacks. Hanging up
"the conference" is `VoiceCallManager.HangupMultiparty`:

```js
async hangup(callId) {
  if (watched.get(callId)?.props?.Multiparty === true) {
    const mgr = await start();
    await mgr.HangupMultiparty();
    return;
  }
  const call = await iface(callId, 'org.ofono.VoiceCall');
  await call.Hangup();
}
```

`Hangup` on a held call and on a waiting call already work through oFono's
own mapping to CHLD=0, backed by `release-all-held`. Nothing to add.

### 4.4 New methods

```js
async swapCalls()        { const mgr = await start(); await mgr.SwapCalls(); }
async createMultiparty() { const mgr = await start(); await mgr.CreateMultiparty(); }
```

`SwapCalls` is CHLD=2 and does three jobs depending on what exists: one
active call and nothing held becomes held; one held call and nothing active
resumes; one of each swaps. The renderer labels the button Hold, Resume or
Swap accordingly (§7). oFono refuses `SwapCalls` while a call is *waiting*;
the renderer hides the button in that state rather than let it fail.

`CreateMultiparty` requires exactly one active and one held call and no
waiting call. Same rule: the renderer shows Merge only then.

Both join `BACKEND_METHODS`. The unbound Linux backend maps them to `reject`;
the Windows stub picks them up from the list automatically.

### 4.5 `getHandsfree` replaces `getBattery`

Battery, features and subscriber numbers are three properties of one
`org.ofono.Handsfree.GetProperties` call that `getBattery` already makes.
Rename it and return all three:

```js
async getHandsfree() {
  try {
    const p = unwrap(await hf.GetProperties());
    return {
      battery: typeof p.BatteryChargeLevel === 'number'
        ? Math.max(0, Math.min(100, p.BatteryChargeLevel * 20)) : null,
      features: Array.isArray(p.Features) ? p.Features : [],
      numbers: Array.isArray(p.SubscriberNumbers) ? p.SubscriberNumbers : [],
      error: null,
    };
  } catch (err) {
    return { battery: null, features: [], numbers: [], error: describeTelephonyError(err) };
  }
}
```

The status object assembled in `linux/index.js` gains `features`, `numbers`
and `pnp` (§10):

```js
{
  connected, model, battery, signal, operator, roaming, error,   // unchanged
  features: string[],    // NEW: [] when the modem is offline
  numbers:  string[],    // NEW: [] on the F120B (§2)
  pnp: { vendor, product, version } | null,   // NEW, from BlueZ (§10)
}
```

The unbound backend returns `features: []`, `numbers: []`, `pnp: null`.

### 4.6 Mock backend

The mock moves from a single `current` call to a `Map` keyed by id so the
whole feature can be exercised without a handset:

- `dial()` while a call is live is allowed only if every live call is held
  (the same rule main enforces, §5); the new call goes `dialing → alerting →
  active` on the existing timers.
- `simulateIncoming()` emits `incoming` when nothing is live and `waiting`
  when something is. `KONNECT_MOCK_INCOMING=<ms>` therefore produces a
  waiting call if the tester dials first.
- `answer(id)` on a waiting call moves every active call to `held` and the
  waiting one to `active`. On an incoming call it behaves as today.
- `swapCalls()` moves every `active` call to `held` and every `held` call to
  `active`, emitting one event per call.
- `createMultiparty()` sets `multiparty: true` on every active and held call
  and makes them all `active`.
- `hangup(id)` on a multiparty call disconnects every multiparty member; on
  any other call, that call alone.
- `getStatus()` reports `features: ['three-way-calling', 'release-all-held',
  'create-multiparty']`, `numbers: []` (matching the real handset), and a
  `pnp` value that is **not** the real handset's (the mock must not carry real
  identifiers, per the existing rule for the MAC).

---

## 5. Dial guard and "Add call"

The guard in `call:dial` and in `dialFromTray` today refuses any dial while a
call exists. The new rule is **refuse unless every live call is held**:

- `callsession.js` entries record `state` alongside direction, number, name
  and start time, and the session exposes `canDial()`:
  `[...live.values()].every((e) => e.state === 'held')`. Vacuously true when
  nothing is live, so the idle path is unchanged.
- `hasLiveCall()` stays as it is; `device:forget` still refuses on *any* live
  call, held or not.
- `ipc.js` and `index.js` swap `hasLiveCall()` for `!canDial()` in their dial
  guards. The error text becomes "a call is in progress; put it on hold to
  dial another".

"Add call" is therefore **Hold, then dial**, with no new button. The keypad
already types into the number field whenever the primary call is not
`active`, so once the call is held the dialer behaves as if idle, and the
Call button re-enables (§7). An accidental Call press during a conversation
is still refused, which is the money-safety property the guard exists for.

Whether the F120B places a second outgoing call while one is held is the
first item in §11.

---

## 6. Call waiting

A `waiting` call already reaches `showIncoming()` in `index.js` and gets the
popup plus the desktop notification. Two changes:

1. **No PC ringtone for a waiting call.** `startRing()` plays through the
   sink that is carrying the conversation, so it would ring over the live
   call. `showIncoming` skips `startRing` when `call.state === 'waiting'`. The
   notification and the always-on-top popup are the alert.
2. **The popup says so.** `state` joins the query string; `incoming.html`
   titles the card "Call waiting" for it and "Incoming call" otherwise. The
   Answer button is unchanged and now holds the first call (§4.2). Decline is
   unchanged: `hangup(waiting id)` is CHLD=0.

If the handset generates its own call-waiting beep in the SCO stream, the user
hears it through the PC as well; nothing in Konnect suppresses or duplicates
it.

---

## 7. In-call panel

`primaryCall()` keeps its rule: an active call outranks everything, then the
most recent. Everything below is derived on each `renderCall()` from
`liveCalls` and the `features` list held from the last status event.

**Counts.** `active`, `held`, `waiting` are the live calls in each state;
`conference` is true when the primary call is `multiparty`.

**State text.** `held` renders as "On hold"; a multiparty primary renders as
"Conference"; every other state keeps its raw oFono word as today.

**Second line.** When more than one call is live, a line under the primary
shows the other one: "On hold: Priya Nair" or "Waiting: +91 98…". A waiting
call's line carries its own Answer button, so a waiting call whose popup was
dismissed is still answerable from the panel. A held call's line carries
nothing; Swap covers it.

**Buttons.** Shown only when `features` includes `three-way-calling`, except
Hang up and Answer, which are unconditional.

| Button | Shown when | Calls |
| --- | --- | --- |
| Hold | `active ≥ 1`, `held = 0`, `waiting = 0` | `swapCalls()` |
| Resume | `active = 0`, `held ≥ 1`, `waiting = 0` | `swapCalls()` |
| Swap | `active ≥ 1`, `held ≥ 1`, `waiting = 0` | `swapCalls()` |
| Merge | Swap's condition, and not `conference`, and `features` includes `create-multiparty` | `createMultiparty()` |
| Answer (panel) | primary is `incoming` (unchanged) | `answer(primary.id)` |
| Hang up | always | `hangup(primary.id)` |

Hang up on a conference ends the whole conference (§4.3). Hang up on the
active call of an active-plus-held pair ends that call; whether the handset
then resumes the held call on its own or leaves it held is the handset's
choice, and the panel follows the events either way, offering Resume if the
call stays held.

**Timer and mute.** The timer follows the primary call's `startedAt`, so a
swap moves it to the call now being spoken on. Mute is unchanged.

**Call button.** `updateDialButton()` disables the Call button when a dial is
pending or any live call is not held, mirroring §5. The click handler's "A
call is already in progress" alert becomes the same wording as the IPC error.

---

## 8. Recording with more than one call

The SCO link carries one conversation at a time, so **one recorder runs at a
time, following the audio link**:

- The rule lives in `recording-policy.js`, not in the recorder. The record
  handler remembers the id it is recording: a `start` for a different id
  while one is recording is skipped, and a `stop` for the remembered id
  clears it. `recorder.js` stays dumb and unchanged. This is main's policy,
  and the handler already has the fake-backend seam the recorder lacks.
- The session's start trigger is unchanged: the first `active` transition of
  each call. For a second call this now results in no recorder.
- **Hand-off.** In the `disconnected` path of `callsession.js`, after the
  ending call's recorder has stopped and its row is written, the session
  calls `onRecord({ phase: 'start', call })` for every remaining live entry
  whose state is `active`. The handler's setting check and its one-at-a-time
  rule both apply, so this is a no-op unless a recorder can and should start.
- The overlap audio lands in the first call's file. A conference is recorded
  as one file attached to whichever call started the recorder.

This is a documented ceiling, marked in code with a `ponytail:` comment. The
upgrade path, if ever wanted, is a session-level recorder with one file per
overlapping group; nothing here forecloses it.

Whether the SCO link survives a hold decides whether a held call's recorder
keeps running or exits when its PipeWire node vanishes. Either outcome is
handled today (the recorder already reaps a child that exits), but the
answer belongs in §11 so the README can say which it is.

---

## 9. Own phone number

Carried as `numbers` in status (§4.5). Settings renders it under the handset
name only when the array is non-empty, joined with a comma exactly as oFono
reports them; there is no display formatter in `shared/phone.js` and none is
added. On the F120B it never renders. Kept because
it costs a handful of lines on a call already made and gives a different
handset the row for free.

No manual-entry fallback. That is a different feature with a different
purpose and is not asked for.

---

## 10. PnP identity

**Parsing** is a pure helper in `src/shared/modalias.js`, dual-exported like
`rank.js` so tests and the renderer can both load it:

```js
// "bluetooth:v001Dp1200d1436" -> { vendor: '001D', product: '1200', version: '20.3.6' }
// Anything else (USB modalias, malformed, missing) -> null
function parseModalias(s)
```

Version decodes `0xJJMN` as `JJ.M.N` in decimal. Vendor and product stay as
four uppercase hex digits; there is no vendor-name table. One entry
(Qualcomm) is not a table, and the raw identifier is what a bug report needs.

**Reading** costs nothing extra: `device.getStatus()` already does `GetAll` on
`org.bluez.Device1`; it returns `pnp: parseModalias(dev.props.Modalias)`.
`linux/index.js` passes it through into status. It is logged once at startup
alongside the model name so journals from other handsets carry it.

**Display** is a muted sub-line under the handset name in the Settings
handset row: `Qualcomm 001D:1200 · firmware 20.3.6` when vendor is `001D`,
otherwise `Vendor 001D · product 1200 · firmware 20.3.6`. Hidden when `pnp`
is null. Nothing else keys off it (approved: display only, no per-model
feature gating).

---

## 11. Hardware verification

These cannot be unit-tested and are the acceptance gate for the feature. Each
is a manual step in the implementation plan, following the probe-script
pattern in `scripts/verify-*.js`, and its outcome is written back into this
section.

| # | Question | How | Decides |
| --- | --- | --- | --- |
| 1 | Does `Dial` succeed while the only live call is held? | Hold A from the panel, dial B | Whether "Add call" works on the F120B or must be documented as receive-only |
| 2 | Does the SCO link survive a hold? | Hold A, watch `pw-link -l` for the `bluez_input` node | README wording for recording of held calls (§8) |
| 3 | Does `HoldAndAnswer` on a waiting call leave A held and B active? | Have a second phone call in during A | The popup Answer path (§4.2, §6) |
| 4 | After hanging up B, is A resumed by the handset or left held? | Continue from 3 | Nothing in code; documented behaviour for the README (§7) |
| 5 | Does `CreateMultiparty` set `Multiparty=true` on both and does `HangupMultiparty` end both? | Continue from 3 | Merge and conference hang-up (§4.3, §7) |

Outcomes pending: run `node scripts/verify-multicall.js 44:CD:0E:AD:5E:34` and record each row's result here.

Steps 1 and 3 to 5 each place or receive a real call and cost airtime. The
probe script prints every call event so the sequence is recorded verbatim.

---

## 12. Error handling

- Every new backend call is `await`ed behind a button whose failure is shown
  with `alert()`, exactly as Hang up and Answer are today. Wording names the
  action: "Could not hold", "Could not swap", "Could not merge".
- oFono's refusals (`SwapCalls` while waiting, `CreateMultiparty` without one
  held and one active, `HoldAndAnswer` with both slots full) are prevented by
  the visibility rules in §7 and surface as alerts if they happen anyway.
- `getHandsfree` failing yields empty `features`, which hides every new
  button. The status card already shows the underlying error.
- A malformed Modalias yields `pnp: null` and no sub-line. Never an error.
- The recording hand-off is fire-and-forget with a caught rejection, the same
  discipline as the existing start trigger inside a D-Bus signal handler.

---

## 13. Tests

Node's built-in runner, matching the existing suites.

| Suite | Covers |
| --- | --- |
| `telephony-helpers.test.js` | `toCall` carries `multiparty`; `answer` on a `waiting` call invokes `HoldAndAnswer` and not `Answer`; `hangup` on a multiparty call invokes `HangupMultiparty`; `getHandsfree` maps battery, features and numbers, and returns empty arrays with an error when offline |
| `callsession.test.js` | entries record `state`; `canDial()` is true when idle and when all calls are held, false with an active or waiting call; recording hand-off fires `start` for the remaining active call after a disconnect, and not for a held one |
| `backend.test.js` | mock: dial, waiting second call, answer puts the first on hold, swap flips both, merge marks both multiparty, hangup on the conference ends both; mock refuses dial while a call is active and allows it while held; mock status carries features and a non-real `pnp`. Unbound Linux backend (already tested here) returns empty `features`/`numbers` and null `pnp`, and `swapCalls`/`createMultiparty` reject with the no-handset error |
| `modalias.test.js` | the F120B string; a USB modalias; garbage; empty; version decoding of `0x1436` and of `0x0100` |
| `recording-policy.test.js` | a `start` for a second id while one is recording does not reach the backend; a `stop` for the recorded id clears it so the next `start` does; a `stop` for an unrecorded id still reaches the backend (existing behaviour) |

No renderer tests; the renderer has none today and the button rules are
simple enough to verify in mock mode.

---

## 14. Files

| File | Change |
| --- | --- |
| `src/main/backend/interface.js` | `swapCalls`, `createMultiparty` in `BACKEND_METHODS` |
| `src/main/backend/linux/telephony.js` | `multiparty` in `toCall`; `answer`/`hangup` routing; new methods; `getBattery` → `getHandsfree` |
| `src/main/backend/linux/device.js` | `pnp` from Modalias |
| `src/main/backend/linux/index.js` | status gains `features`, `numbers`, `pnp`; delegates for the new methods; unbound defaults |
| `src/main/recording-policy.js` | one recorder at a time: remember the recorded id, skip a `start` for another |
| `src/main/backend/mock/index.js` | multi-call map, new methods, status fields |
| `src/main/callsession.js` | `state` in entries; `canDial()`; recording hand-off |
| `src/main/ipc.js` | dial guard uses `canDial`; `call:swap`, `call:merge` channels |
| `src/main/index.js` | tray dial guard; no ring for waiting; `state` in popup query; log `pnp` at startup |
| `src/main/preload.js` | `swapCalls`, `createMultiparty` |
| `src/shared/modalias.js` | new, `parseModalias` |
| `src/renderer/index.html` | Hold/Resume/Swap/Merge buttons; second-line element; Settings sub-line; `modalias.js` script tag |
| `src/renderer/app.js` | button rules, state text, second line, dial-button rule, features from status |
| `src/renderer/settings.js` | numbers and PnP under the handset name |
| `src/renderer/incoming.html` | "Call waiting" title |
| `scripts/verify-multicall.js` | new probe for §11 |
| `README.md` | features list and known-limitations updates after §11 |
| tests as in §13 | |

---

## 15. Out of scope

- `Transfer` and `PrivateChat`: not advertised by the handset (§2).
- `ReleaseAndAnswer` ("end current, answer waiting") and `ReleaseAndSwap`:
  supported by the handset but not asked for; one method and one button each
  if wanted later.
- Voice recognition (`VoiceRecognition` property): the feature bit is absent
  from `Features`, so setting it would be refused.
- Manual entry of the user's own number (§9).
- Per-model feature gating from PnP (§10).
- A per-conversation recording model (§8).
