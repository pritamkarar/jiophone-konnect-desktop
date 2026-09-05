# Hold/Swap/Conference, Handsfree Extras and PnP Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Konnect hold, swap and merge calls on the JioPhone, place a second call once the first is held, read the handset's own number when it reports one, and show the handset's Bluetooth PnP identity in Settings.

**Architecture:** Thin pass-through. Two methods (`swapCalls`, `createMultiparty`) join the backend contract; `answer` and `hangup` learn to route a *waiting* call and a *conference* through `org.ofono.VoiceCallManager`. The status object gains `features`, `numbers` and `pnp`. The renderer derives every new button from the live-call map it already keeps. One recorder runs at a time, enforced in the recording policy handler.

**Tech Stack:** Electron 44, Node.js built-in test runner (`node --test`), dbus-next against oFono and BlueZ, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-konnect-multicall-handsfree-pnp-design.md`

## Global Constraints

- No new npm dependencies.
- Tests use `node:test` and `node:assert` only, run with `npm test` (`node --test`).
- Every D-Bus-touching module keeps its `getInterfaceFn`/`systemBusFn` injection seams; tests never open the system bus.
- The mock backend must not carry the real handset's identifiers (BD_ADDR `44:CD:0E:AD:5E:34`, Modalias `bluetooth:v001Dp1200d1436`).
- Renderer scripts share one global scope and have no `require()`; shared helpers use the dual-export pattern in `src/shared/rank.js`.
- Never power the oFono modem off to work around anything (spec 2026-09-01 §2.2).
- Feature list strings are oFono's verbatim: `three-way-calling`, `release-all-held`, `create-multiparty`.
- Error copy: dial refused → `a call is in progress; put it on hold to dial another`.
- Work on branch `feat/multicall-handsfree-pnp` (already created, spec committed on it).
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV
  ```

---

## File map

| File | Responsibility after this plan |
| --- | --- |
| `src/shared/modalias.js` (new) | Pure parse of a BlueZ Modalias string and a one-line description of it |
| `src/main/backend/linux/device.js` | Adds `pnp` to the BlueZ device status |
| `src/main/backend/linux/telephony.js` | `multiparty` on calls; `getHandsfree`; waiting/conference routing; `swapCalls`, `createMultiparty` |
| `src/main/backend/mock/index.js` | Multi-call simulation |
| `src/main/backend/interface.js` | Contract gains the two methods |
| `src/main/backend/linux/index.js` | Status gains `features`, `numbers`, `pnp`; delegates; unbound defaults |
| `src/main/recording-policy.js` | One recorder at a time |
| `src/main/callsession.js` | Entries record `state`; `canDial()`; recording hand-off |
| `src/main/ipc.js`, `src/main/preload.js` | Dial guard; `call:swap`, `call:merge` |
| `src/main/index.js` | Tray guard; no ring for waiting; popup gets `state`; PnP log |
| `src/renderer/incoming.html` | "Call waiting" label |
| `src/renderer/index.html`, `app.js`, `styles.css` | Hold/Resume, Swap, Merge, second line |
| `src/renderer/settings.js` | Number and PnP under the handset name |
| `scripts/verify-multicall.js` (new) | Interactive hardware probe for spec §11 |
| `README.md` | Features and limitations |

---

### Task 1: `parseModalias` and `describePnp`

**Files:**
- Create: `src/shared/modalias.js`
- Test: `test/modalias.test.js`

**Interfaces:**
- Produces: `parseModalias(s: string|null) → { vendor: string, product: string, version: string } | null` and `describePnp(pnp) → string` (empty string for null). Both exported via `module.exports` and `window.Modalias`.

- [ ] **Step 1: Write the failing tests**

```js
// test/modalias.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseModalias, describePnp } = require('../src/shared/modalias');

test('parses the F120B modalias into vendor, product and firmware version', () => {
  assert.deepStrictEqual(parseModalias('bluetooth:v001Dp1200d1436'), {
    vendor: '001D', product: '1200', version: '20.3.6',
  });
});

test('version 0xJJMN decodes as JJ.M.N in decimal', () => {
  assert.strictEqual(parseModalias('bluetooth:v0001p0002d0100').version, '1.0.0');
  assert.strictEqual(parseModalias('bluetooth:v0001p0002d0A1F').version, '10.1.15');
});

test('hex digits are normalised to upper case', () => {
  const p = parseModalias('bluetooth:v001dp12aBd1436');
  assert.strictEqual(p.vendor, '001D');
  assert.strictEqual(p.product, '12AB');
});

test('a USB modalias, garbage, empty, null and undefined are all null', () => {
  for (const s of ['usb:v1D6Bp0002d0510dc09dsc00dp00ic09isc00ip00in00', 'bluetooth:v001D', 'hello', '', null, undefined, 42]) {
    assert.strictEqual(parseModalias(s), null, `expected null for ${JSON.stringify(s)}`);
  }
});

test('describePnp names Qualcomm for vendor 001D and falls back to the raw vendor otherwise', () => {
  assert.strictEqual(describePnp({ vendor: '001D', product: '1200', version: '20.3.6' }),
    'Qualcomm 001D:1200 · firmware 20.3.6');
  assert.strictEqual(describePnp({ vendor: '000F', product: '0001', version: '1.0.0' }),
    'Vendor 000F · product 0001 · firmware 1.0.0');
  assert.strictEqual(describePnp(null), '');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/modalias.test.js`
Expected: FAIL with `Cannot find module '../src/shared/modalias'`

- [ ] **Step 3: Write the implementation**

```js
// src/shared/modalias.js
'use strict';

// BlueZ publishes org.bluez.Device1.Modalias for a handset that carries a
// Bluetooth Device ID record, e.g. "bluetooth:v001Dp1200d1436": vendor and
// product are Bluetooth SIG identifiers, and the device version is packed as
// 0xJJMN (major, minor, sub-minor) - so 0x1436 is firmware 20.3.6.
const BT_MODALIAS = /^bluetooth:v([0-9A-Fa-f]{4})p([0-9A-Fa-f]{4})d([0-9A-Fa-f]{4})$/;

function parseModalias(s) {
  if (typeof s !== 'string') return null;
  const m = BT_MODALIAS.exec(s.trim());
  if (!m) return null;
  const v = parseInt(m[3], 16);
  return {
    vendor: m[1].toUpperCase(),
    product: m[2].toUpperCase(),
    version: `${v >> 8}.${(v >> 4) & 0xf}.${v & 0xf}`,
  };
}

// One vendor is not a table: the only handset this was built against is
// Qualcomm inside. Everything else shows its raw identifier, which is what a
// bug report needs anyway.
function describePnp(pnp) {
  if (!pnp) return '';
  return pnp.vendor === '001D'
    ? `Qualcomm ${pnp.vendor}:${pnp.product} · firmware ${pnp.version}`
    : `Vendor ${pnp.vendor} · product ${pnp.product} · firmware ${pnp.version}`;
}

// Dual export: required by tests and main under node, loaded as a plain
// <script> by the renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) module.exports = { parseModalias, describePnp };
if (typeof window !== 'undefined') { window.Modalias = { parseModalias, describePnp }; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/modalias.test.js`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add src/shared/modalias.js test/modalias.test.js
git commit -m "feat(shared): parse a BlueZ Modalias into vendor, product and firmware version

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 2: BlueZ device status carries `pnp`

**Files:**
- Modify: `src/main/backend/linux/device.js` (the `getStatus()` return, around lines 90-101)
- Test: `test/linux-helpers.test.js`

**Interfaces:**
- Consumes: `parseModalias` from Task 1.
- Produces: `device.getStatus()` now returns `{ connected, model, battery, pnp, error }` where `pnp` is the Task 1 shape or `null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/linux-helpers.test.js` (the file already imports `createDeviceMonitor`):

```js
// The Properties proxy device.js builds: GetAll per interface, plus the
// PropertiesChanged subscription ensure() attaches. An interface not in
// `props` throws BlueZ's real absent-interface shape so readAll() stays quiet.
function fakeDeviceProps(props) {
  return async () => ({
    on() {}, off() {},
    GetAll: async (iface) => {
      if (props[iface]) return props[iface];
      const err = new Error(`No such interface '${iface}'`);
      err.type = 'org.freedesktop.DBus.Error.InvalidArgs';
      err.name = 'DBusError';
      throw err;
    },
  });
}

test('getStatus carries the PnP identity parsed from Modalias', async () => {
  const monitor = createDeviceMonitor({
    mac: '44:CD:0E:AD:5E:34',
    getInterfaceFn: fakeDeviceProps({
      'org.bluez.Device1': {
        Connected: { value: true }, Alias: { value: 'F120B' },
        Modalias: { value: 'bluetooth:v001Dp1200d1436' },
      },
    }),
    systemBusFn: () => ({}),
  });
  const s = await monitor.getStatus();
  assert.strictEqual(s.model, 'F120B');
  assert.deepStrictEqual(s.pnp, { vendor: '001D', product: '1200', version: '20.3.6' });
  assert.strictEqual(s.error, null);
});

test('a device with no Modalias reports pnp null, not an error', async () => {
  const monitor = createDeviceMonitor({
    mac: '44:CD:0E:AD:5E:34',
    getInterfaceFn: fakeDeviceProps({
      'org.bluez.Device1': { Connected: { value: false }, Name: { value: 'F120B' } },
    }),
    systemBusFn: () => ({}),
  });
  const s = await monitor.getStatus();
  assert.strictEqual(s.pnp, null);
  assert.strictEqual(s.error, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/linux-helpers.test.js`
Expected: the first new test FAILS with `Expected values to be strictly deep-equal: undefined !== { vendor: '001D', ... }`; the second FAILS with `undefined !== null`.

- [ ] **Step 3: Add the field**

In `src/main/backend/linux/device.js`, add the require at the top, under the existing `createEmitter` require:

```js
const { parseModalias } = require('../../../shared/modalias');
```

and in `getStatus()` change the returned object to:

```js
      return {
        connected: Boolean(dev.props.Connected),
        model: dev.props.Alias || dev.props.Name || null,
        battery: typeof bat.props.Percentage === 'number' ? bat.props.Percentage : null,
        // Bluetooth Device ID, present for a paired handset whether or not it
        // is connected right now. Free: GetAll already fetched it.
        pnp: parseModalias(dev.props.Modalias),
        error,
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/linux-helpers.test.js`
Expected: all passing, including the two new tests

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/linux/device.js test/linux-helpers.test.js
git commit -m "feat(linux): read the handset's PnP identity from BlueZ Modalias

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 3: `multiparty` on calls and `getHandsfree`

**Files:**
- Modify: `src/main/backend/linux/telephony.js` (`toCall` around line 43; `getBattery` around lines 200-215)
- Modify: `src/main/backend/linux/index.js` (the one `getBattery` caller in `getStatus`, around line 122)
- Test: `test/telephony-helpers.test.js` (replace the `fakeOfono` helper; add tests)

**Interfaces:**
- Produces: call objects gain `multiparty: boolean`. `telephony.getHandsfree() → { battery: number|null, features: string[], numbers: string[], error: string|null }`. `getBattery` is removed.
- The extended `fakeOfono` (with `handsfree` option, `managerCalls`, `callCalls`) is what Task 4's tests use.

- [ ] **Step 1: Replace `fakeOfono` in the test file and add the tests**

Replace the whole `fakeOfono` function in `test/telephony-helpers.test.js` (currently lines 67-123, starting at the comment `// Fakes org.ofono over dbus-next's ...`) with:

```js
// What the live F120B reports (spec 2026-09-05 §2): no SubscriberNumbers.
const DEFAULT_HANDSFREE = {
  BatteryChargeLevel: { value: 4 },
  Features: { value: ['three-way-calling', 'echo-canceling-and-noise-reduction', 'release-all-held', 'create-multiparty'] },
};

// Fakes org.ofono over dbus-next's getInterfaceFn/systemBusFn injection
// seams (the same pattern device.js's tests use) so createTelephony's real
// watchCall/unwatchCall/start logic runs against scripted signals instead of
// the live bus. One fake object per (path, interface name), so a test can
// grab it back out of `registry` and fire signals on it. Manager and call
// method invocations are recorded in order so routing can be asserted.
// `handsfree: null` simulates the modem being offline for that interface.
function fakeOfono({ calls = [], handsfree = DEFAULT_HANDSFREE } = {}) {
  const registry = new Map();
  const vcmListenerCounts = { CallAdded: 0, CallRemoved: 0 };
  const managerCalls = [];
  const callCalls = [];

  function makeEmitter() {
    const listeners = new Map();
    return {
      on(event, cb) { listeners.set(event, cb); },
      off(event, cb) { if (listeners.get(event) === cb) listeners.delete(event); },
      emit(event, ...args) { const cb = listeners.get(event); if (cb) cb(...args); },
    };
  }

  function getOrCreate(path, ifaceName, build) {
    const key = `${path}|${ifaceName}`;
    if (!registry.has(key)) registry.set(key, build());
    return registry.get(key);
  }

  const getInterfaceFn = async (_bus, _service, path, ifaceName) => {
    if (ifaceName === 'org.ofono.Modem') {
      return getOrCreate(path, ifaceName, () => ({
        GetProperties: async () => ({ Powered: { value: true } }),
        SetProperty: async () => {},
      }));
    }
    if (ifaceName === 'org.ofono.Handsfree') {
      // dbus-next's real wording when oFono has dropped the interface.
      if (!handsfree) throw new Error('interface not found in proxy object: org.ofono.Handsfree');
      return getOrCreate(path, ifaceName, () => ({ GetProperties: async () => handsfree }));
    }
    if (ifaceName === 'org.ofono.VoiceCallManager') {
      return getOrCreate(path, ifaceName, () => {
        const e = makeEmitter();
        const record = (name) => async () => { managerCalls.push(name); };
        return {
          ...e,
          on(event, cb) {
            if (event === 'CallAdded' || event === 'CallRemoved') vcmListenerCounts[event] += 1;
            e.on(event, cb);
          },
          GetCalls: async () => calls,
          Dial: async () => '/call/dialed',
          SendTones: async () => {},
          HoldAndAnswer: record('HoldAndAnswer'),
          HangupMultiparty: record('HangupMultiparty'),
          SwapCalls: record('SwapCalls'),
          CreateMultiparty: record('CreateMultiparty'),
        };
      });
    }
    if (ifaceName === 'org.ofono.VoiceCall') {
      return getOrCreate(path, ifaceName, () => {
        const e = makeEmitter();
        return {
          ...e,
          Answer: async () => { callCalls.push('Answer'); },
          Hangup: async () => { callCalls.push('Hangup'); },
        };
      });
    }
    throw new Error(`fakeOfono: unexpected interface requested: ${ifaceName}`);
  };

  return {
    getInterfaceFn, systemBusFn: () => ({}), registry, vcmListenerCounts, managerCalls, callCalls,
  };
}
```

Then append these tests at the end of the file:

```js
test('toCall carries the Multiparty flag, false when absent', () => {
  assert.strictEqual(toCall(PATH, { State: 'active', Multiparty: true }).multiparty, true);
  assert.strictEqual(toCall(PATH, { State: 'active' }).multiparty, false);
});

test('getHandsfree maps battery, features and subscriber numbers', async () => {
  const f = fakeOfono({ handsfree: {
    BatteryChargeLevel: { value: 4 },
    Features: { value: ['three-way-calling', 'create-multiparty'] },
    SubscriberNumbers: { value: ['+919804464251'] },
  } });
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  assert.deepStrictEqual(await telephony.getHandsfree(), {
    battery: 80, features: ['three-way-calling', 'create-multiparty'], numbers: ['+919804464251'], error: null,
  });
});

test('getHandsfree reports an empty numbers list when the handset omits SubscriberNumbers, as the F120B does', async () => {
  const f = fakeOfono();
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  const h = await telephony.getHandsfree();
  assert.deepStrictEqual(h.numbers, []);
  assert.ok(h.features.includes('three-way-calling'));
  assert.strictEqual(h.error, null);
});

test('getHandsfree reports offline with empty lists when the interface is gone', async () => {
  const f = fakeOfono({ handsfree: null });
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  assert.deepStrictEqual(await telephony.getHandsfree(), {
    battery: null, features: [], numbers: [], error: 'handset modem offline',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/telephony-helpers.test.js`
Expected: existing tests still pass; `toCall ... Multiparty` FAILS (`undefined !== true`); the three `getHandsfree` tests FAIL with `telephony.getHandsfree is not a function`.

- [ ] **Step 3: Implement**

In `src/main/backend/linux/telephony.js`, in `toCall()` add the field after `startedAt`:

```js
    startedAt: p.StartTime || null,
    // True for every member of a conference. Hanging one of them up needs
    // the manager, not the call (see hangup()).
    multiparty: p.Multiparty === true,
```

Replace the whole `getBattery` method with:

```js
    // One GetProperties, three answers. Battery comes from HFP's 0-5
    // `battchg` indicator (BlueZ's Battery1 is absent while oFono owns HFP,
    // see device.js); 20% per level matches what BlueZ reported before oFono
    // took over. Features is oFono's list of what the handset's AG advertised
    // (the F120B: three-way-calling, release-all-held, create-multiparty) and
    // gates the hold/swap/merge buttons. SubscriberNumbers is optional in
    // oFono and absent on the F120B, which answers AT+CNUM with nothing.
    async getHandsfree() {
      try {
        const hf = await iface(modemPath, 'org.ofono.Handsfree');
        const p = unwrap(await hf.GetProperties());
        const level = p.BatteryChargeLevel;
        return {
          battery: typeof level === 'number' ? Math.max(0, Math.min(100, level * 20)) : null,
          features: Array.isArray(p.Features) ? p.Features : [],
          numbers: Array.isArray(p.SubscriberNumbers) ? p.SubscriberNumbers : [],
          error: null,
        };
      } catch (err) {
        return { battery: null, features: [], numbers: [], error: describeTelephonyError(err) };
      }
    },
```

In `src/main/backend/linux/index.js`, in the bound `getStatus()`, change the destructuring and the two uses of `b`:

```js
      const [d, n, h] = await Promise.all([
        device.getStatus(), telephony.getNetwork(), telephony.getHandsfree(),
      ]);
      return {
        connected: d.connected,
        model: d.model,
        // oFono first: BlueZ's Battery1 is absent while oFono owns HFP.
        battery: h.battery ?? d.battery,
        signal: n.signal, operator: n.operator, roaming: n.roaming,
        // A BlueZ fault outranks an oFono one: if the device link is down,
        // "handset modem offline" is a symptom, not the cause.
        error: d.error ?? n.error ?? h.error ?? null,
      };
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all passing (the rename has exactly one caller, updated above)

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/linux/telephony.js src/main/backend/linux/index.js test/telephony-helpers.test.js
git commit -m "feat(telephony): carry Multiparty on calls; read features and subscriber numbers with battery

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 4: Waiting/conference routing, `swapCalls`, `createMultiparty`

**Files:**
- Modify: `src/main/backend/linux/telephony.js` (`answer`, `hangup` around lines 245-255; new methods beside them)
- Test: `test/telephony-helpers.test.js`

**Interfaces:**
- Consumes: the Task 3 `fakeOfono` with `managerCalls` / `callCalls`.
- Produces: `telephony.answer(id)` (waiting → `HoldAndAnswer`), `telephony.hangup(id)` (multiparty → `HangupMultiparty`), `telephony.swapCalls()`, `telephony.createMultiparty()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/telephony-helpers.test.js`:

```js
// Boots telephony, attaches its CallAdded listener, and adds one call with
// the given (already-unwrapped-shaped) properties.
async function withCall(f, props) {
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  telephony.onCall(() => {});
  await tick();
  const vcm = f.registry.get(`${modemPathFor(MAC)}|org.ofono.VoiceCallManager`);
  vcm.emit('CallAdded', PATH, props);
  await tick();
  return telephony;
}

test('answer on a waiting call goes through HoldAndAnswer, never VoiceCall.Answer', async () => {
  const f = fakeOfono();
  const telephony = await withCall(f, { State: { value: 'waiting' }, LineIdentification: { value: '+919804464251' } });
  await telephony.answer(PATH);
  assert.deepStrictEqual(f.managerCalls, ['HoldAndAnswer']);
  assert.deepStrictEqual(f.callCalls, []);
  telephony.dispose();
});

test('answer on an incoming call still uses VoiceCall.Answer', async () => {
  const f = fakeOfono();
  const telephony = await withCall(f, { State: { value: 'incoming' } });
  await telephony.answer(PATH);
  assert.deepStrictEqual(f.callCalls, ['Answer']);
  assert.deepStrictEqual(f.managerCalls, []);
  telephony.dispose();
});

test('hangup on a conference member ends the conference through HangupMultiparty', async () => {
  const f = fakeOfono();
  const telephony = await withCall(f, { State: { value: 'active' }, Multiparty: { value: true } });
  await telephony.hangup(PATH);
  assert.deepStrictEqual(f.managerCalls, ['HangupMultiparty']);
  assert.deepStrictEqual(f.callCalls, []);
  telephony.dispose();
});

test('hangup on an ordinary call still uses VoiceCall.Hangup', async () => {
  const f = fakeOfono();
  const telephony = await withCall(f, { State: { value: 'active' } });
  await telephony.hangup(PATH);
  assert.deepStrictEqual(f.callCalls, ['Hangup']);
  assert.deepStrictEqual(f.managerCalls, []);
  telephony.dispose();
});

test('swapCalls and createMultiparty call the manager', async () => {
  const f = fakeOfono();
  const telephony = createTelephony({ mac: MAC, getInterfaceFn: f.getInterfaceFn, systemBusFn: f.systemBusFn });
  await telephony.swapCalls();
  await telephony.createMultiparty();
  assert.deepStrictEqual(f.managerCalls, ['SwapCalls', 'CreateMultiparty']);
  telephony.dispose();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/telephony-helpers.test.js`
Expected: the waiting and conference tests FAIL (`[ 'Answer' ]` / `[ 'Hangup' ]` recorded instead of the manager call); the last FAILS with `telephony.swapCalls is not a function`.

- [ ] **Step 3: Implement**

In `src/main/backend/linux/telephony.js`, replace `answer` and `hangup` and add the two methods directly after `hangup`:

```js
    // oFono defines VoiceCall.Answer for the 'incoming' state only. A second
    // inbound call while one is up is 'waiting', and is answered through the
    // manager: HoldAndAnswer is one CHLD=2 that holds the active call and
    // accepts the waiting one. oFono refuses it when a held AND an active
    // call already exist - there is no third slot - and that error surfaces
    // to the caller as any other.
    async answer(callId) {
      if (watched.get(callId)?.props?.State === 'waiting') {
        const mgr = await start();
        await mgr.HoldAndAnswer();
        return;
      }
      const call = await iface(callId, 'org.ofono.VoiceCall');
      await call.Answer();
    },

    // Hanging up ONE member of a conference needs release-specified-active-
    // call (CHLD=1x), which the F120B does not advertise. "Hang up the
    // conference" is what the button means, and that is HangupMultiparty.
    // A held or waiting call still goes through VoiceCall.Hangup, which oFono
    // maps to CHLD=0 (release-all-held, advertised).
    async hangup(callId) {
      if (watched.get(callId)?.props?.Multiparty === true) {
        const mgr = await start();
        await mgr.HangupMultiparty();
        return;
      }
      const call = await iface(callId, 'org.ofono.VoiceCall');
      await call.Hangup();
    },

    // CHLD=2. Holds the lone active call, resumes the lone held call, or
    // swaps one of each. oFono refuses it while a call is waiting; the
    // renderer hides the button in that state rather than let it fail.
    async swapCalls() {
      const mgr = await start();
      await mgr.SwapCalls();
    },

    // CHLD=3. Needs exactly one active and one held call.
    async createMultiparty() {
      const mgr = await start();
      await mgr.CreateMultiparty();
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/telephony-helpers.test.js`
Expected: all passing

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/linux/telephony.js test/telephony-helpers.test.js
git commit -m "feat(telephony): route waiting answers and conference hangups through the manager; add swapCalls and createMultiparty

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 5: Mock backend simulates hold, swap, waiting and conference

**Files:**
- Modify: `src/main/backend/mock/index.js` (the call section, lines 17-58, and `status` at line 27)
- Test: `test/backend.test.js`

**Interfaces:**
- Produces: mock `dial`, `answer`, `hangup`, `swapCalls`, `createMultiparty`, `simulateIncoming` over a map of calls; mock status carries `features`, `numbers: []`, `pnp` (non-real).

- [ ] **Step 1: Write the failing tests**

Append to `test/backend.test.js`:

```js
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('mock: a second incoming call arrives as waiting; answering it holds the first; swap and merge follow', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const calls = new Map();
  backend.onCall((c) => calls.set(c.id, c));

  const a = await backend.dial('+919876543210');
  await settle();
  assert.strictEqual(calls.get(a).state, 'active');

  const b = backend.simulateIncoming('+919804464251');
  assert.strictEqual(calls.get(b).state, 'waiting', 'a second inbound call must be waiting, not incoming');

  await backend.answer(b);
  assert.strictEqual(calls.get(a).state, 'held', 'answering the waiting call must hold the first');
  assert.strictEqual(calls.get(b).state, 'active');

  await backend.swapCalls();
  assert.strictEqual(calls.get(a).state, 'active');
  assert.strictEqual(calls.get(b).state, 'held');

  await backend.createMultiparty();
  assert.strictEqual(calls.get(a).multiparty, true);
  assert.strictEqual(calls.get(b).multiparty, true);
  assert.strictEqual(calls.get(b).state, 'active');

  await backend.hangup(a);
  assert.strictEqual(calls.get(a).state, 'disconnected');
  assert.strictEqual(calls.get(b).state, 'disconnected', 'hanging up a conference ends every member');
  backend.dispose();
});

test('mock refuses a dial while a call is active and allows one once every call is held', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const calls = new Map();
  backend.onCall((c) => calls.set(c.id, c));
  const a = await backend.dial('+919876543210');
  await settle();
  await assert.rejects(() => backend.dial('+919804464251'), /put it on hold/);
  await backend.swapCalls();
  assert.strictEqual(calls.get(a).state, 'held');
  const b = await backend.dial('+919804464251');
  await settle();
  assert.strictEqual(calls.get(b).state, 'active');
  assert.strictEqual(calls.get(a).state, 'held');
  backend.dispose();
});

test('mock status carries handsfree features, no subscriber numbers, and a non-real pnp', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  const s = await backend.getStatus();
  assert.deepStrictEqual(s.features, ['three-way-calling', 'release-all-held', 'create-multiparty']);
  assert.deepStrictEqual(s.numbers, []);
  assert.deepStrictEqual(s.pnp, { vendor: '0000', product: '0000', version: '0.0.0' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/backend.test.js`
Expected: the first FAILS at the `waiting` assertion (mock emits `incoming`); the second FAILS because the second dial does not reject; the third FAILS with `undefined` features.

- [ ] **Step 3: Rewrite the mock's call section**

In `src/main/backend/mock/index.js`:

Replace `let current = null;` (line 17) with:

```js
  // Every live call keyed by id, so hold, swap, waiting and conference can
  // be exercised without a handset. Mirrors the real oFono state words.
  const calls = new Map();
```

Replace the `status` object with:

```js
  const status = {
    connected: true, model: 'F120B', battery: 80,
    signal: 100, operator: 'JIO', roaming: false, error: null,
    // What the real F120B advertises (spec 2026-09-05 §2), minus the
    // echo-cancelling flag nothing reads. numbers is empty because the real
    // handset reports none. pnp is deliberately NOT the real handset's.
    features: ['three-way-calling', 'release-all-held', 'create-multiparty'],
    numbers: [],
    pnp: { vendor: '0000', product: '0000', version: '0.0.0' },
  };
```

Replace the `emitCall` function with:

```js
  function emitCall(id, patch) {
    const c = calls.get(id);
    if (!c) return;
    const next = { ...c, ...patch };
    if (next.state === 'disconnected') calls.delete(id); else calls.set(id, next);
    callEmitter.emit(next);
  }

  // Same rule main enforces in callsession.canDial(): vacuously true when idle.
  const canDial = () => [...calls.values()].every((c) => c.state === 'held');
```

Replace `dial`, `answer`, `hangup` and `simulateIncoming` with:

```js
    async dial(number) {
      if (!canDial()) throw new Error('a call is in progress; put it on hold to dial another');
      const id = `mock-call-${++seq}`;
      calls.set(id, { id, direction: 'out', state: 'dialing', number, name: null, startedAt: null, multiparty: false });
      later(0, () => emitCall(id, { state: 'dialing' }));
      later(60, () => emitCall(id, { state: 'alerting' }));
      later(120, () => emitCall(id, { state: 'active', startedAt: new Date().toISOString() }));
      return id;
    },
    // A waiting call is answered with HoldAndAnswer on the real backend, which
    // holds whatever is active first.
    async answer(id) {
      const c = calls.get(id);
      if (!c) return;
      if (c.state === 'waiting') {
        for (const other of [...calls.values()]) {
          if (other.state === 'active') emitCall(other.id, { state: 'held' });
        }
      }
      emitCall(id, { state: 'active', startedAt: new Date().toISOString() });
    },
    // Hanging up a conference member ends the conference (HangupMultiparty).
    async hangup(id) {
      const c = calls.get(id);
      if (!c) return;
      const victims = c.multiparty ? [...calls.values()].filter((x) => x.multiparty) : [c];
      for (const v of victims) emitCall(v.id, { state: 'disconnected' });
    },
    async sendDtmf() {},
    // CHLD=2: active <-> held, all at once.
    async swapCalls() {
      for (const c of [...calls.values()]) {
        if (c.state === 'active') emitCall(c.id, { state: 'held' });
        else if (c.state === 'held') emitCall(c.id, { state: 'active' });
      }
    },
    // CHLD=3: every active and held call joins one active conference.
    async createMultiparty() {
      for (const c of [...calls.values()]) {
        if (c.state === 'active' || c.state === 'held') emitCall(c.id, { state: 'active', multiparty: true });
      }
    },
    onCall(cb) { return callEmitter.on(cb); },

    // Mock-only, deliberately NOT part of the backend contract: lets the
    // incoming-call window and its notification be exercised without ringing a
    // real phone. A call arriving while another is live is 'waiting', exactly
    // as oFono reports it, so KONNECT_MOCK_INCOMING after a dial exercises
    // the call-waiting path.
    simulateIncoming(number = '+919804464251', name = null) {
      const id = `mock-call-${++seq}`;
      const state = calls.size > 0 ? 'waiting' : 'incoming';
      calls.set(id, { id, direction: 'in', state, number, name, startedAt: null, multiparty: false });
      callEmitter.emit(calls.get(id));
      return id;
    },
```

(Remove the old `async sendDtmf() {}` and `onCall` lines that the block above re-declares, so each appears once.)

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all passing, including the existing `mock emits a call lifecycle ending in disconnected`

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/mock/index.js test/backend.test.js
git commit -m "feat(mock): simulate call waiting, hold, swap and conference

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 6: Contract and Linux backend status

**Files:**
- Modify: `src/main/backend/interface.js:11-16`
- Modify: `src/main/backend/linux/index.js` (unbound backend around lines 62-84; bound `getStatus` around line 120; delegates around line 145)
- Test: `test/backend.test.js`

**Interfaces:**
- Produces: `BACKEND_METHODS` includes `swapCalls`, `createMultiparty`. Status from every backend has `features: string[]`, `numbers: string[]`, `pnp: object|null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/backend.test.js`:

```js
test('the contract names swapCalls and createMultiparty', () => {
  assert.ok(BACKEND_METHODS.includes('swapCalls'));
  assert.ok(BACKEND_METHODS.includes('createMultiparty'));
});

test('unbound linux backend reports empty handsfree lists and no pnp, and refuses the new calls', async () => {
  const backend = createLinuxBackend({ mac: null });
  const s = await backend.getStatus();
  assert.deepStrictEqual(s.features, []);
  assert.deepStrictEqual(s.numbers, []);
  assert.strictEqual(s.pnp, null);
  await assert.rejects(() => backend.swapCalls(), /No handset selected/);
  await assert.rejects(() => backend.createMultiparty(), /No handset selected/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/backend.test.js`
Expected: the contract test FAILS; the unbound test FAILS with `undefined` features (and `backend.swapCalls is not a function`).

- [ ] **Step 3: Implement**

`src/main/backend/interface.js`, in `BACKEND_METHODS`:

```js
  'dial', 'answer', 'hangup', 'sendDtmf', 'swapCalls', 'createMultiparty', 'onCall',
```

`src/main/backend/linux/index.js`, unbound backend: extend `getStatus` and the reject line:

```js
    async getStatus() {
      return {
        connected: false, model: null, battery: null, signal: null,
        operator: null, roaming: false, error: NO_HANDSET,
        features: [], numbers: [], pnp: null,
      };
    },
    onDeviceStatus(cb) { return statusEmitter.on(cb); },
    dial: reject, answer: reject, hangup: reject, sendDtmf: reject,
    swapCalls: reject, createMultiparty: reject,
```

Bound backend `getStatus` (the Task 3 shape) gains three fields:

```js
      return {
        connected: d.connected,
        model: d.model,
        // oFono first: BlueZ's Battery1 is absent while oFono owns HFP.
        battery: h.battery ?? d.battery,
        signal: n.signal, operator: n.operator, roaming: n.roaming,
        // What the handset's AG advertised; gates hold/swap/merge in the UI.
        features: h.features,
        // Optional in oFono; empty on the F120B (spec 2026-09-05 §2).
        numbers: h.numbers,
        pnp: d.pnp,
        // A BlueZ fault outranks an oFono one: if the device link is down,
        // "handset modem offline" is a symptom, not the cause.
        error: d.error ?? n.error ?? h.error ?? null,
      };
```

Bound delegates, after `sendDtmf`:

```js
    sendDtmf: (d) => telephony.sendDtmf(d),
    swapCalls: () => telephony.swapCalls(),
    createMultiparty: () => telephony.createMultiparty(),
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all passing; `mock backend implements every method in the contract` and `unbound linux backend implements every method` both still pass because Task 5 already gave the mock both methods and the Windows stub derives from the list.

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/interface.js src/main/backend/linux/index.js test/backend.test.js
git commit -m "feat(backend): add swapCalls and createMultiparty to the contract; status carries features, numbers and pnp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 7: One recorder at a time

**Files:**
- Modify: `src/main/recording-policy.js`
- Test: `test/recording-policy.test.js`

**Interfaces:**
- Produces: `createRecordHandler(...)` unchanged signature; the returned handler skips a `start` for a second id while one is recording.

- [ ] **Step 1: Write the failing tests**

Append to `test/recording-policy.test.js`:

```js
test('a second call going active while one is recording does not start a second recorder', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'start', call: { id: 'b' } });
  assert.deepStrictEqual(h.calls.started, ['a']);
});

test('once the recorded call stops, the next start is accepted', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'stop', call: { id: 'a' } });
  await h.handler({ phase: 'start', call: { id: 'b' } });
  assert.deepStrictEqual(h.calls.started, ['a', 'b']);
});

test('a stop for a call that was never recorded still reaches the backend and does not free the slot', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'stop', call: { id: 'b' } });
  assert.deepStrictEqual(h.calls.stopped, ['b']);
  await h.handler({ phase: 'start', call: { id: 'c' } });
  assert.deepStrictEqual(h.calls.started, ['a'], 'slot was freed by an unrelated stop');
});

test('a start that fails frees the slot for the next call', async () => {
  const started = [];
  const handler = createRecordHandler({
    store: { getSetting: () => 'true' },
    backend: {
      startRecording: async (id) => { if (id === 'a') throw new Error('pw-record missing'); started.push(id); },
      stopRecording: async () => null,
    },
    attachRecording: () => {},
  });
  await handler({ phase: 'start', call: { id: 'a' } });
  await handler({ phase: 'start', call: { id: 'b' } });
  assert.deepStrictEqual(started, ['b']);
});

test('a repeated start for the SAME call is passed through (the recorder is idempotent per id)', async () => {
  const h = harness('true');
  await h.handler({ phase: 'start', call: { id: 'a' } });
  await h.handler({ phase: 'start', call: { id: 'a' } });
  assert.deepStrictEqual(h.calls.started, ['a', 'a']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recording-policy.test.js`
Expected: the first and third new tests FAIL (`[ 'a', 'b' ]` / `[ 'a', 'c' ]` started); the others pass already.

- [ ] **Step 3: Implement**

Replace the body of `src/main/recording-policy.js` with:

```js
'use strict';

// The record_calls setting gates STARTING a recording, never stopping one.
// A recorder already running must always be stopped: gating 'stop' too means
// that switching recording off mid-call leaves pw-record capturing audio the
// user has just asked not to capture, with the file never encoded or attached.
//
// ponytail: one recorder at a time. The SCO link carries one conversation,
// so a second call going active while one is recording gets no recorder of
// its own - its audio lands in the first call's file until that call ends,
// and callsession's hand-off then starts one for it. Upgrade path: a
// session-level recorder with one file per overlapping group.
function createRecordHandler({ store, backend, attachRecording }) {
  let recording = null;   // id of the call whose recorder is running
  return async ({ phase, call }) => {
    if (phase === 'start' && store.getSetting('record_calls') !== 'true') return;
    if (phase === 'start' && recording && recording !== call.id) return;
    try {
      if (phase === 'start') {
        // Claimed before the await so a concurrent start cannot slip past.
        recording = call.id;
        await backend.startRecording(call.id);
      } else {
        if (recording === call.id) recording = null;
        const finalPath = await backend.stopRecording(call.id);
        if (finalPath) attachRecording(call.id, finalPath);
      }
    } catch (err) {
      if (phase === 'start' && recording === call.id) recording = null;
      console.error('recording failed:', err.message);
    }
  };
}

module.exports = { createRecordHandler };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/recording-policy.test.js`
Expected: all passing (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/recording-policy.js test/recording-policy.test.js
git commit -m "feat(recording): one recorder at a time, following the audio link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 8: Call session records state, exposes `canDial()`, hands off recording

**Files:**
- Modify: `src/main/callsession.js` (`handle()` around lines 63-105; the returned object around lines 107-140)
- Test: `test/callsession.test.js`

**Interfaces:**
- Produces: `session.canDial() → boolean`; `session.liveCalls()` entries include `state`; after a call disconnects, `onRecord({ phase: 'start', call })` fires for each remaining `active` entry.

- [ ] **Step 1: Write the failing tests**

Append to `test/callsession.test.js`:

```js
test('canDial is true when idle, false with an active or waiting call, true once every call is held', () => {
  const { backend, session, store } = setup();
  assert.strictEqual(session.canDial(), true, 'idle line refused a dial');

  backend.emit({ id: 'c1', direction: 'out', number: '+919876543210', state: 'active', startedAt: '2026-09-01T12:00:00Z' });
  assert.strictEqual(session.canDial(), false, 'dial allowed over an active call');

  backend.emit({ id: 'c1', direction: 'out', number: '+919876543210', state: 'held', startedAt: '2026-09-01T12:00:00Z' });
  assert.strictEqual(session.canDial(), true, 'dial refused although the only call is held');
  assert.strictEqual(session.liveCalls()[0].state, 'held', 'liveCalls must report the current state');

  backend.emit({ id: 'c2', direction: 'in', number: '+919804464251', state: 'waiting' });
  assert.strictEqual(session.canDial(), false, 'a waiting call must block dialing');
  store.close();
});

test('when the recorded call ends, a start is handed to the call still active', async () => {
  const phases = [];
  const { backend, store } = setup({
    onRecord: async ({ phase, call }) => { phases.push(`${phase}:${call.id}`); },
  });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'active', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'waiting' });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'held', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'active', startedAt: '2026-09-01T12:00:30Z' });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'disconnected', startedAt: '2026-09-01T12:00:00Z' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(phases, ['start:a', 'start:b', 'stop:a', 'start:b']);
  store.close();
});

test('no start is handed to a call that is held when the other ends', async () => {
  const phases = [];
  const { backend, store } = setup({
    onRecord: async ({ phase, call }) => { phases.push(`${phase}:${call.id}`); },
  });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'active', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'waiting' });
  backend.emit({ id: 'a', direction: 'out', number: '+919876543210', state: 'held', startedAt: '2026-09-01T12:00:00Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'active', startedAt: '2026-09-01T12:00:30Z' });
  backend.emit({ id: 'b', direction: 'in', number: '+919804464251', state: 'disconnected', startedAt: '2026-09-01T12:00:30Z' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(phases, ['start:a', 'start:b', 'stop:b']);
  store.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/callsession.test.js`
Expected: the first FAILS with `session.canDial is not a function`; the second FAILS with `[ 'start:a', 'start:b', 'stop:a' ]` (no hand-off); the third passes already.

- [ ] **Step 3: Implement**

In `src/main/callsession.js`:

Update the comment on the `live` map and the `next` entry in `handle()`:

```js
  const live = new Map();   // call id -> { direction, number, name, startedAt, state }
```

```js
    const next = {
      direction: prev.direction || call.direction,
      number: call.number || prev.number || null,
      name: call.name || prev.name || null,
      // StartTime arrives once and must never be overwritten with null.
      startedAt: call.startedAt || prev.startedAt || null,
      recordingPath: prev.recordingPath || null,
      // The current oFono state. canDial() below reads it, and a renderer
      // re-seeding from liveCalls() after a reload needs it to draw the panel.
      state: call.state,
    };
```

(Keep the existing comment block above `direction:` in place; only the `state` line is new.)

In the `disconnected` branch of `handle()`, after `persist(call.id);` and before `return;`:

```js
      persist(call.id);
      // Hand-off (spec 2026-09-05 §8): the recorder follows the audio link.
      // With the ended call's recorder stopped, the call still being spoken
      // on - if any - gets its turn. The handler's one-at-a-time rule and its
      // setting check both still apply, so this is a no-op unless a recorder
      // can and should start. Fire-and-forget and caught, as the start
      // trigger below is: this runs inside a D-Bus signal handler.
      if (onRecord) {
        for (const [id, entry] of live) {
          if (entry.state !== 'active') continue;
          Promise.resolve(onRecord({ phase: 'start', call: { id, ...entry } }))
            .catch((err) => console.error('[konnect] recorder hand-off failed:', err.message));
        }
      }
      return;
```

In the returned object, after `hasLiveCall()`:

```js
    // The dial guard. "Add call" is hold-then-dial: a dial is refused unless
    // every live call is held, so an accidental Call press during a
    // conversation still cannot place a second real call. Vacuously true
    // when idle.
    canDial() { return [...live.values()].every((e) => e.state === 'held'); },
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all passing

- [ ] **Step 5: Commit**

```bash
git add src/main/callsession.js test/callsession.test.js
git commit -m "feat(session): track call state, expose canDial, hand recording to the call left active

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 9: Main-process wiring: dial guard, IPC channels, waiting popup, PnP log

**Files:**
- Modify: `src/main/ipc.js` (`registerIpc` params around line 39; `'call:dial'` around line 112; new channels after `'call:dtmf'`)
- Modify: `src/main/preload.js` (after `sendDtmf`)
- Modify: `src/main/index.js` (`showIncoming` around lines 249-284; `dialFromTray` around line 296; `registerIpc({...})` around line 565; startup log around line 539)
- Modify: `src/renderer/incoming.html` (`.via` label around line 110; script at the bottom)

**Interfaces:**
- Consumes: `session.canDial()` (Task 8), `backend.swapCalls()` / `backend.createMultiparty()` (Task 6), status `pnp` (Task 6).
- Produces: IPC channels `call:swap`, `call:merge`; `window.konnect.swapCalls()`, `window.konnect.createMultiparty()`; popup query param `state`.

There are no unit tests for these Electron modules (none exist today). Verification is in mock mode, Step 6.

- [ ] **Step 1: IPC**

In `src/main/ipc.js`, add the parameter after `hasLiveCall`:

```js
  backend, store, broadcast, hasLiveCall = () => false, liveCalls = () => [],
  canDial = () => true,
```

Replace the `'call:dial'` handler's first guard line:

```js
    'call:dial': (_e, number) => {
      // "Add call" is hold-then-dial (spec 2026-09-05 §5): refused unless
      // every live call is held, so the money-safety property this guard
      // exists for survives a second call.
      if (!canDial()) throw new Error('a call is in progress; put it on hold to dial another');
```

(Keep the rest of that handler and its existing comment block as they are.)

Add after `'call:dtmf'`:

```js
    // CHLD=2 and CHLD=3. Which of hold/resume/swap a swap means is decided by
    // what is live, and the renderer already knows that; main does not need
    // a separate channel per meaning.
    'call:swap': () => backend.swapCalls(),
    'call:merge': () => backend.createMultiparty(),
```

- [ ] **Step 2: Preload**

In `src/main/preload.js`, after `sendDtmf`:

```js
  swapCalls: () => ipcRenderer.invoke('call:swap'),
  createMultiparty: () => ipcRenderer.invoke('call:merge'),
```

- [ ] **Step 3: index.js**

In the `registerIpc({...})` call, after `hasLiveCall:`:

```js
    hasLiveCall: () => callSession?.hasLiveCall() ?? false,
    canDial: () => callSession?.canDial() ?? true,
```

In `dialFromTray`, replace the live-call guard line:

```js
    if (callSession && !callSession.canDial()) throw new Error('A call is in progress; put it on hold to dial another.');
```

In `showIncoming(call)`:

```js
  incomingCallId = call.id;
  const waiting = call.state === 'waiting';
  const ring = ringSettings();
  // No PC ringtone for a waiting call: it would play through the sink that
  // is carrying the conversation. The popup and the notification remain.
  if (ring.enabled && backend.audio && !waiting) backend.audio.startRing(ring);
  const q = new URLSearchParams({
    id: call.id, number: call.number || '', name: call.name || 'Unknown', state: call.state,
  }).toString();
```

and the notification:

```js
  new Notification({
    title: `${waiting ? 'Call waiting' : 'Incoming call'} - ${call.name || 'Unknown'}`,
    body: call.number || '',
    icon: ICON,
  }).show();
```

After `console.log('[konnect] bound to handset:', ...)`:

```js
  // Logged once so a journal from another JioPhone model carries the
  // identifiers a bug report needs. Modalias survives disconnection, so this
  // answers even when the handset is out of range at launch.
  backend.getStatus().then((s) => {
    if (s.pnp) console.log(`[konnect] handset ${s.model || '?'} pnp ${s.pnp.vendor}:${s.pnp.product} firmware ${s.pnp.version}`);
  }).catch(() => {});
```

- [ ] **Step 4: Popup label**

In `src/renderer/incoming.html`, wrap the label text so the script can change it:

```html
      <div class="via">
        <svg ...unchanged...></svg>
        <span id="via-text">Incoming via JioPhone</span>
      </div>
```

In the script, after the avatar lines:

```js
    if (params.get('state') === 'waiting') {
      document.title = 'Call waiting';
      document.getElementById('via-text').textContent = 'Call waiting via JioPhone';
    }
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all passing (nothing here is under test; this catches a syntax slip in the shared modules only)

- [ ] **Step 6: Verify in mock mode**

Run: `KONNECT_MOCK=1 KONNECT_MOCK_INCOMING=8000 npm start`

1. Within 8 seconds, type any number and press Call. The panel shows the call going active.
2. At 8 seconds a popup appears titled "Call waiting via JioPhone" and a desktop notification says "Call waiting". (The mock has no audio namespace, so no-ring cannot be observed here; it is code-verified and checked on hardware in Task 12.)
3. Press Accept on the popup. The panel now shows the second call; the first is held. (The panel's own Hold/Swap buttons arrive in Task 10.)
4. With the second call still up, open the tray menu and pick the recent number under it (the first call is already in the log). The dialog reads `A call is in progress; put it on hold to dial another.` The keypad's own alert still says "A call is already in progress." until Task 10 replaces it.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.js src/main/preload.js src/main/index.js src/renderer/incoming.html
git commit -m "feat(main): hold-then-dial guard, swap/merge channels, silent call-waiting popup, PnP startup log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 10: In-call panel: Hold/Resume, Swap, Merge, second line

**Files:**
- Modify: `src/renderer/index.html` (call panel, lines 97-108)
- Modify: `src/renderer/app.js` (`renderStatus` at line 23; dialer section from line 193; `renderCall` at line 319; dial click handler at line 391; handlers after `#c-answer`)
- Modify: `src/renderer/styles.css` (after the `#c-hangup` rule, around line 358)

**Interfaces:**
- Consumes: `window.konnect.swapCalls()`, `window.konnect.createMultiparty()`, `window.konnect.answer(id)` (Task 9); status `features` (Task 6); call `multiparty` and `held` state (Tasks 3, 8).

- [ ] **Step 1: Markup**

In `src/renderer/index.html`, replace the call panel block with:

```html
          <div id="call-panel" hidden>
            <div class="call-name" id="c-name">-</div>
            <div class="call-number" id="c-number">-</div>
            <div class="call-state" id="c-state">-</div>
            <div class="call-rec" id="c-rec" hidden><span class="dot bad"></span>REC</div>
            <div class="call-timer" id="c-timer">00:00</div>
            <!-- The other call, when two are live: held behind the one shown,
                 or waiting to be answered. -->
            <div class="call-other" id="c-other" hidden>
              <span id="c-other-text"></span>
              <button id="c-other-answer" hidden>Answer</button>
            </div>
            <div class="dial-actions">
              <button id="c-answer" hidden>Answer</button>
              <button id="c-hold" hidden>Hold</button>
              <button id="c-swap" hidden>Swap</button>
              <button id="c-merge" hidden>Merge</button>
              <button id="c-mute" hidden aria-pressed="false" aria-label="Mute microphone" title="Mute microphone"></button>
              <button id="c-hangup">Hang up</button>
            </div>
          </div>
```

- [ ] **Step 2: Styles**

In `src/renderer/styles.css`, after the `#c-hangup { ... }` rule:

```css
/* The call behind the one shown. Plain text plus, for a waiting call, its
   own Answer - a dismissed popup must not make a waiting call unreachable. */
.call-other {
  display: flex; align-items: center; gap: 10px;
  font: 500 13px var(--sans); color: var(--fg2); margin-top: -8px; margin-bottom: 8px;
}
.call-other[hidden] { display: none; }
#c-other-answer {
  height: 28px; padding: 0 12px; border-radius: 9px; border: 0;
  background: linear-gradient(135deg, #34D399, #0FA36B); color: #fff;
  font: 600 12px var(--sans); cursor: pointer;
}
```

- [ ] **Step 3: app.js — feature list from status**

Near the top of `src/renderer/app.js`, directly after `const $ = ...` (line 3):

```js
// What the handset's HFP gateway advertised, from the last status event.
// Gates the hold/swap/merge buttons: absent feature, absent button.
let handsfreeFeatures = [];
```

In `renderStatus(s)`, after the `$('#s-bat')` line at the end of the function:

```js
  // Re-derive the call panel's buttons only when the list actually changes:
  // status events arrive every 30s and on every BlueZ property change.
  const features = Array.isArray(s.features) ? s.features : [];
  if (features.join() !== handsfreeFeatures.join()) {
    handsfreeFeatures = features;
    renderCall(null);
  }
```

- [ ] **Step 4: app.js — dial guard mirrors main**

Replace `updateDialButton`:

```js
// Mirrors callsession.canDial() in main: a dial is allowed only when every
// live call is held. Main independently refuses; this is the display half.
const allHeld = () => [...liveCalls.values()].every((c) => c.state === 'held');

function updateDialButton() {
  $('#d-call').disabled = dialPending || !allHeld();
}
```

In the `#d-call` click handler, replace the `liveCalls.size > 0` block:

```js
  if (!allHeld()) {
    alert('A call is in progress; put it on hold to dial another.');
    return;
  }
```

- [ ] **Step 5: app.js — renderCall**

Replace `renderCall` entirely:

```js
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
  if (liveCalls.size > 0) clearDialPending();
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
```

- [ ] **Step 6: app.js — handlers**

After the `#c-answer` click handler:

```js
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
```

- [ ] **Step 7: Verify in mock mode**

Run: `KONNECT_MOCK=1 KONNECT_MOCK_INCOMING=8000 npm start`

1. Dial any number. Once "active", the panel shows **Hold** beside Mute and Hang up. Press Hold: state reads "On hold", the button reads **Resume**, the timer keeps running, the Call button re-enables.
2. Type a second number and press Call. The second call goes active; the panel shows it, with "On hold: +91…" underneath, and **Swap** and **Merge** buttons.
3. Press Swap: the shown call and the second line trade places. Press Merge: state reads "Conference", Swap and Merge disappear, Hold remains.
4. Press Hang up: both calls end, the panel hides.
5. Restart with the env var, dial, wait for the waiting call, then close the popup with its X. The panel shows "Waiting: +919804464251" with its own **Answer**; Hold is hidden while it waits. Press Answer: the first call is held, the second shown.
6. `KONNECT_MOCK=1 npm start` and check the dialer while idle still enables Call and shows no panel.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/styles.css
git commit -m "feat(dialer): hold, resume, swap and merge from the in-call panel; show the second call

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 11: Settings handset row shows number and PnP

**Files:**
- Modify: `src/renderer/index.html` (Settings device card around line 192; script tags around line 279)
- Modify: `src/renderer/settings.js` (`renderDevice` around lines 22-35)
- Modify: `src/renderer/styles.css` (the `#set-device` rule at line 574)

**Interfaces:**
- Consumes: `window.Modalias.describePnp` (Task 1), status `numbers` and `pnp` (Task 6).

- [ ] **Step 1: Markup and script include**

In `src/renderer/index.html`, under `<p id="set-device">-</p>`:

```html
          <p id="set-device">-</p>
          <p id="set-device-number" hidden></p>
          <p id="set-device-pnp" hidden></p>
```

Add the shared script before `rank.js`:

```html
  <script src="../shared/modalias.js"></script>
  <script src="../shared/rank.js"></script>
```

- [ ] **Step 2: Style**

In `src/renderer/styles.css`, extend the selector:

```css
#set-device, #set-device-number, #set-device-pnp { font: 400 11.5px var(--mono); color: var(--fg3); margin: 0; text-align: center; }
```

- [ ] **Step 3: Render**

In `src/renderer/settings.js`, at the end of `renderDevice()` after the `#set-forget-device` line:

```js
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
```

- [ ] **Step 4: Verify in mock mode**

Run: `KONNECT_MOCK=1 npm start`, open Settings. Under the handset line, a muted line reads `Vendor 0000 · product 0000 · firmware 0.0.0`. No "Number:" line appears (the mock reports none, as the real handset does).

Then, with the real handset paired: `npm start`, open Settings. The line reads `Qualcomm 001D:1200 · firmware 20.3.6`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/settings.js src/renderer/styles.css
git commit -m "feat(settings): show the handset's subscriber number and PnP identity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

### Task 12: Hardware probe, README, spec write-back

**Files:**
- Create: `scripts/verify-multicall.js`
- Modify: `README.md` (Features line 13; Known limitations after line 48)
- Modify: `docs/superpowers/specs/2026-09-05-konnect-multicall-handsfree-pnp-design.md` (§11 outcomes)

**Interfaces:**
- Consumes: the bound Linux backend (`createLinuxBackend({ mac })`) with every method from Tasks 3-6.

- [ ] **Step 1: Write the probe**

```js
// scripts/verify-multicall.js
// Manual hardware check for hold / swap / merge (spec 2026-09-05 §11).
//   node scripts/verify-multicall.js 44:CD:0E:AD:5E:34
// Prints every call event with its state and Multiparty flag, plus whether
// the SCO audio node exists at that moment, so the sequence can be pasted
// into the spec. Commands on stdin:
//   d <number>  dial (only allowed while every live call is held)
//   h           SwapCalls: hold the active call / resume the held one / swap
//   a           answer the waiting call (HoldAndAnswer)
//   m           CreateMultiparty
//   x           hang up the active call (a conference ends whole)
//   q           quit
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');
const { createLinuxBackend } = require('../src/main/backend/linux');

const mac = process.argv[2];
if (!mac) {
  console.error('usage: node scripts/verify-multicall.js <handset-mac>');
  process.exit(2);
}

// The recorder captures from bluez_input.*; if that node is gone, so is
// the audio link (spec §11 step 2).
function scoNode() {
  try {
    const out = execFileSync('pw-link', ['-o']).toString();
    return out.split('\n').some((l) => l.startsWith('bluez_input.')) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

(async () => {
  const backend = createLinuxBackend({ mac });
  await backend.ensureOnline();
  const status = await backend.getStatus();
  console.log('features:', status.features);
  console.log('numbers :', status.numbers);
  console.log('pnp     :', status.pnp);

  const live = new Map();
  backend.onCall((c) => {
    if (c.state === 'disconnected') live.delete(c.id); else live.set(c.id, c);
    const short = c.id.split('/').pop();
    console.log(`${new Date().toISOString()} ${c.state.padEnd(12)} multiparty=${c.multiparty} dir=${c.direction} num=${c.number} ${short}   sco=${scoNode()}`);
  });

  console.log('commands: d <num> | h | a | m | x | q');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    const calls = [...live.values()];
    try {
      if (cmd === 'd') console.log('dialed', await backend.dial(arg));
      else if (cmd === 'h') await backend.swapCalls();
      else if (cmd === 'a') {
        const w = calls.find((c) => c.state === 'waiting');
        if (w) await backend.answer(w.id); else console.log('no waiting call');
      } else if (cmd === 'm') await backend.createMultiparty();
      else if (cmd === 'x') {
        const c = calls.find((x) => x.state === 'active') || calls[0];
        if (c) await backend.hangup(c.id); else console.log('no call');
      } else if (cmd === 'q') { await backend.dispose(); process.exit(0); }
    } catch (err) {
      console.log('error:', err.message);
    }
  });
})();
```

- [ ] **Step 2: Run the five checks on the handset**

With Konnect **not** running (it would hold the same oFono listeners), Bluetooth on, the F120B paired:

```bash
node scripts/verify-multicall.js 44:CD:0E:AD:5E:34
```

| # | Do | Record |
| --- | --- | --- |
| 1 | `d <number A>`, wait for `active`, `h` (expect `held`), `d <number B>` | Did B go `dialing → active`? Any `error:`? |
| 2 | Same as 1, read the `sco=` column on the `held` event | `present` or `absent` |
| 3 | `d <number A>`, wait for `active`, have another phone call the handset (expect `waiting`), `a` | A `held`, B `active`? |
| 4 | `x` (ends B) | Does A come back `active` on its own, or stay `held`? |
| 5 | Repeat 3, then `m` (expect `multiparty=true` on both), then `x` | Do both end? |

Paste the printed lines into spec §11 as the outcome of each row.

- [ ] **Step 3: README**

Replace the Calls feature bullet:

```markdown
- **📞 Calls** — Dial numbers, answer and hang up calls, send DTMF tones, and view live call state and duration. Hold, resume, swap and merge calls; answer a second call while on the first; put a call on hold to dial another.
```

Add under Known limitations, after the Hardware compatibility section, adjusting the recording and hold sentences to what Step 2 found:

```markdown
### Own phone number
The F120B does not report its subscriber number over HFP (the SIM carries no MSISDN), so Konnect cannot show it. A handset that does report one shows it in Settings.

### Recording with two calls
One recorder runs at a time and follows the audio link. While a second call is up, its audio lands in the first call's recording until that call ends; the second call then gets a recorder of its own.
```

- [ ] **Step 4: Spec write-back**

Fill in the §11 table's outcomes in `docs/superpowers/specs/2026-09-05-konnect-multicall-handsfree-pnp-design.md` with the lines recorded in Step 2. If step 1 failed (no second outgoing call while held), also add a "Hold-then-dial" limitation to the README naming the error the handset returned.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: all passing

```bash
git add scripts/verify-multicall.js README.md docs/superpowers/specs/2026-09-05-konnect-multicall-handsfree-pnp-design.md
git commit -m "docs: hardware probe for hold/swap/merge; README and spec outcomes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013bcFa5mtVKtY3FXTWPcQdV"
```

---

## Self-review against the spec

| Spec section | Task |
| --- | --- |
| §2 verified facts | Task 3 fake defaults, Task 12 probe re-prints them |
| §4.1 `multiparty` | Task 3 |
| §4.2 answer routing | Task 4 |
| §4.3 hangup routing | Task 4 |
| §4.4 new methods | Tasks 4, 6 |
| §4.5 `getHandsfree`, status fields | Tasks 3, 6 |
| §4.6 mock | Task 5 |
| §5 dial guard, Add call | Tasks 8, 9, 10 |
| §6 call waiting, no ring, label | Task 9 |
| §7 in-call panel | Task 10 |
| §8 recording | Tasks 7, 8 |
| §9 own number | Tasks 3, 6, 11 |
| §10 PnP | Tasks 1, 2, 6, 9 (log), 11 |
| §11 hardware verification | Task 12 |
| §12 error handling | Tasks 4 (comments), 10 (`callAction` alerts), 3 (offline → empty lists) |
| §13 tests | Tasks 1-8 |
| §14 files | file map above |

Type consistency checked: `getHandsfree` returns `{battery, features, numbers, error}` in Tasks 3, 5, 6; status fields are `features`, `numbers`, `pnp` everywhere; `canDial` in Tasks 5 (mock), 8, 9, 10; popup query key is `state` in Task 9 both sides; `window.Modalias.describePnp` in Tasks 1 and 11.
