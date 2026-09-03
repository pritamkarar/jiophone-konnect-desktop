# Konnect In-App Pairing and 1a–1e Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-step select-and-connect wizard with the design canvas's five-state onboarding, backed by real Bluetooth adapter control, device discovery and pairing.

**Architecture:** A new `backend.adapter` namespace — assembled from `adapter.js` (power, discovery) and `pairing.js` (agent, `Pair()`) — mirrors the existing `backend.audio` namespace and is present in **both** branches of `linux/index.js`, including the `mac === null` branch where onboarding actually runs. The flow's state machine is a pure reducer in `src/shared/` so it is testable with no DOM and no Electron. `wizard.js` is retired; its re-entrancy discipline carries over.

**Tech Stack:** Electron 44, `dbus-next`, `node:test`. BlueZ interfaces `Adapter1`, `Device1`, `AgentManager1`, `Agent1`, `ObjectManager`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-konnect-onboarding-pairing-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Tests:** `node:test` and `node:assert` only. `npm test` is bare `node --test`. **Never run `node --test test/`** — it fails on Node 24. Run a single file as `node --test test/<file>.test.js`.
- **No new dependencies.** `package.json` gains nothing.
- **IPC:** every channel is declared in `src/main/ipc.js` **and** mirrored in the `src/main/preload.js` allowlist. Adding one anywhere else is a bug. `contextIsolation: true`, `nodeIntegration: false`.
- **Renderer XSS:** all device-derived strings (names come off the air from untrusted peers) are rendered with `textContent` / `createElement`, never `innerHTML`.
- **Never place a call, never ring the handset, never dial to prove anything works.**
- **REVERSED CONSTRAINT.** The previous plan (`2026-09-01-konnect-settings-wizard.md`) states: *"Never register a BlueZ pairing agent. No `StartDiscovery`, no `org.bluez.Agent1`."* This plan deliberately reverses that, per spec §1.1. Task 10 amends the prior spec so the two stop contradicting each other.
- **Never call `RequestDefaultAgent`.** It would make Konnect the pairing handler for the whole desktop. See spec §5.2.
- **Always `StopDiscovery` on teardown.** A leaked discovery drains the handset battery and degrades every other Bluetooth link on the machine.
- **Adapter path** is `/org/bluez/hci0`, matching the hardcoding already in `bus.js`'s `devicePathFor`.
- **Injection seams:** new D-Bus modules take `getInterfaceFn = getInterface, systemBusFn = systemBus` as trailing options, exactly as `device.js` does, so tests never open the real bus.

---

## Task 1: Verify the BlueZ agent-routing assumption

Spec §5.2 records an **assumption**: that BlueZ routes an agent callback for `Device1.Pair()` to the agent registered by the calling D-Bus connection, falling back to the default agent only when that connection registered none. Every later task depends on it. If it is false, spec §7.1's degraded path becomes the primary path and Tasks 5 and 9 shrink drastically.

This task writes no production code. Its deliverable is a recorded finding.

**Files:**
- Create: `scripts/verify-pairing-agent.js` (joins the existing `scripts/verify-*.js` family)
- Modify: `docs/superpowers/specs/2026-09-02-konnect-onboarding-pairing-design.md` (§5.2, record the result)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded yes/no in the spec that Tasks 5 and 9 read.

- [ ] **Step 1: Write the probe script**

```javascript
'use strict';
// Throwaway probe for spec §5.2. Registers a pairing agent WITHOUT
// RequestDefaultAgent, then reports whether BlueZ would route to it.
// Does not pair anything: it registers, reports, and unregisters.
const dbus = require('dbus-next');
const { systemBus, getInterface } = require('../src/main/backend/linux/bus');

const BLUEZ = 'org.bluez';
const AGENT_PATH = '/konnect/pairing/agent/probe';

(async () => {
  const bus = systemBus();
  const { Interface } = dbus.interface;

  class ProbeAgent extends Interface {
    async RequestConfirmation(devicePath, passkey) {
      console.log('ROUTED TO US:', devicePath, passkey);
      throw new dbus.DBusError('org.bluez.Error.Rejected', 'probe only');
    }
    Release() {}
    Cancel() {}
  }
  ProbeAgent.configureMembers({
    methods: {
      RequestConfirmation: { inSignature: 'ou', outSignature: '' },
      Release: { inSignature: '', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  });

  const agent = new ProbeAgent(`${BLUEZ}.Agent1`);
  bus.export(AGENT_PATH, agent);

  const mgr = await getInterface(bus, BLUEZ, '/org/bluez', 'org.bluez.AgentManager1');
  try {
    await mgr.RegisterAgent(AGENT_PATH, 'KeyboardDisplay');
    console.log('RegisterAgent: OK (no RequestDefaultAgent called)');
  } catch (err) {
    console.log('RegisterAgent: FAILED —', err.message);
    console.log('=> spec §7.1 degraded path becomes primary');
    process.exit(0);
  }
  await mgr.UnregisterAgent(AGENT_PATH).catch(() => {});
  bus.unexport(AGENT_PATH, agent);
  console.log('UnregisterAgent: OK');
  process.exit(0);
})().catch((e) => { console.log('PROBE ERROR:', e.message); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `node scripts/verify-pairing-agent.js`
Expected: `RegisterAgent: OK` then `UnregisterAgent: OK`. If it prints `FAILED`, record that and stop — report to the user before continuing, because the plan's shape changes.

- [ ] **Step 3: Record the finding in the spec**

Replace the sentence in §5.2 reading *"**This routing behaviour is an assumption until proven.**"* with the actual result and the date, e.g.:

```markdown
**Verified 2026-09-02:** `RegisterAgent` without `RequestDefaultAgent` succeeds on
BlueZ <version> against adapter `/org/bluez/hci0`. Pairing callbacks route to the
registering connection.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-pairing-agent.js docs/superpowers/specs/2026-09-02-konnect-onboarding-pairing-design.md
git commit -m "chore: verify BlueZ routes pairing callbacks to the Pair() caller's agent"
```

---

## Task 2: `macFromPath` and phone ranking

Two pure functions with no D-Bus, so they are the natural first code. Ranking implements spec §3.1: phones first, **never** filtered out.

**Files:**
- Modify: `src/main/backend/linux/bus.js` (add `macFromPath`, add to exports)
- Create: `src/shared/rank.js` (pure and consumed by the renderer as well as tests, so it belongs in `shared/` alongside `phone.js` — not under `backend/`)
- Test: `test/pairing-helpers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `macFromPath(path: string) -> string | null` — `/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF` → `'AA:BB:CC:DD:EE:FF'`; `null` when the path is not a device path.
  - `isPhone(d: Device) -> boolean`
  - `rankDiscovered(devices: Device[]) -> { phones: Device[], others: Device[] }`
  - `Device` is `{ mac, name, icon, cls, paired, connected, rssi }`.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { macFromPath } = require('../src/main/backend/linux/bus');
const { isPhone, rankDiscovered } = require('../src/shared/rank');

const F120B = { mac: '44:CD:0E:AD:5E:34', name: 'F120B', icon: null, cls: null, paired: false, rssi: -55 };
const ONEPLUS = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', icon: 'phone', cls: 0x5a020c, paired: true, rssi: -70 };
const BUDS = { mac: 'AA:BB:CC:DD:EE:FF', name: 'Sony WH-1000XM4', icon: 'audio-headset', cls: 0x240404, paired: false, rssi: -40 };

test('macFromPath reverses devicePathFor', () => {
  assert.strictEqual(macFromPath('/org/bluez/hci0/dev_44_CD_0E_AD_5E_34'), '44:CD:0E:AD:5E:34');
});

test('macFromPath returns null for a non-device path', () => {
  assert.strictEqual(macFromPath('/org/bluez/hci0'), null);
  assert.strictEqual(macFromPath(''), null);
  assert.strictEqual(macFromPath(null), null);
});

test('isPhone accepts the Icon hint', () => {
  assert.strictEqual(isPhone(ONEPLUS), true);
});

test('isPhone accepts CoD major class 0x02 with no Icon', () => {
  assert.strictEqual(isPhone({ ...F120B, cls: 0x5a020c }), true);
});

test('isPhone rejects a headset', () => {
  assert.strictEqual(isPhone(BUDS), false);
});

test('a device with neither Icon nor Class is not yet a phone, but is NOT dropped', () => {
  const { phones, others } = rankDiscovered([F120B]);
  assert.strictEqual(isPhone(F120B), false);
  assert.deepStrictEqual(phones, []);
  assert.deepStrictEqual(others.map((d) => d.mac), [F120B.mac]);
});

test('phones rank above a closer non-phone', () => {
  const { phones, others } = rankDiscovered([BUDS, ONEPLUS]);
  assert.deepStrictEqual(phones.map((d) => d.mac), [ONEPLUS.mac]);
  assert.deepStrictEqual(others.map((d) => d.mac), [BUDS.mac]);
});

test('a late-arriving Class promotes a device into phones', () => {
  const before = rankDiscovered([F120B]);
  assert.strictEqual(before.phones.length, 0);
  const after = rankDiscovered([{ ...F120B, cls: 0x5a020c }]);
  assert.strictEqual(after.phones.length, 1);
});

test('within a group, stronger RSSI comes first', () => {
  const near = { ...ONEPLUS, mac: '11:11:11:11:11:11', rssi: -30 };
  const { phones } = rankDiscovered([ONEPLUS, near]);
  assert.deepStrictEqual(phones.map((d) => d.mac), [near.mac, ONEPLUS.mac]);
});

test('missing RSSI sorts last but is kept, and ties keep input order', () => {
  const a = { ...ONEPLUS, mac: '11:11:11:11:11:11', rssi: null };
  const b = { ...ONEPLUS, mac: '22:22:22:22:22:22', rssi: null };
  const { phones } = rankDiscovered([a, b, ONEPLUS]);
  assert.deepStrictEqual(phones.map((d) => d.mac), [ONEPLUS.mac, a.mac, b.mac]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/pairing-helpers.test.js`
Expected: FAIL — `macFromPath is not a function` and cannot find module `rank`.

- [ ] **Step 3: Add `macFromPath` to `bus.js`**

Add beside `devicePathFor`:

```javascript
// Reverse of devicePathFor. BlueZ hands us object paths in agent callbacks and
// InterfacesAdded; every other module in this codebase speaks MAC addresses.
function macFromPath(objectPath) {
  const m = /\/dev_([0-9A-Fa-f_]{17})$/.exec(String(objectPath || ''));
  return m ? m[1].replace(/_/g, ':').toUpperCase() : null;
}
```

Add `macFromPath` to the `module.exports` list.

- [ ] **Step 4: Create `src/shared/rank.js`**

```javascript
'use strict';

// Bluetooth Class of Device: bits 8-12 are the major device class, and 0x02
// is Phone. See the Bluetooth assigned-numbers document.
const PHONE_MAJOR = 0x02;

// Deliberately a RANKING input, never a filter (spec §3.1). BlueZ populates
// Icon and Class asynchronously during discovery, so a device that is not yet
// identifiable as a phone must stay selectable rather than disappear.
function isPhone(d) {
  if (!d) return false;
  if (d.icon === 'phone') return true;
  if (typeof d.cls === 'number' && Number.isFinite(d.cls)) {
    return ((d.cls >> 8) & 0x1f) === PHONE_MAJOR;
  }
  return false;
}

function rankDiscovered(devices) {
  const decorated = (devices || []).map((d, i) => ({ d, i }));
  // Stable: equal RSSI keeps discovery order, so the list does not reshuffle
  // under the user's cursor on every poll tick.
  const byStrength = (a, b) => {
    const ar = typeof a.d.rssi === 'number' ? a.d.rssi : -Infinity;
    const br = typeof b.d.rssi === 'number' ? b.d.rssi : -Infinity;
    return br - ar || a.i - b.i;
  };
  const phones = decorated.filter((x) => isPhone(x.d)).sort(byStrength).map((x) => x.d);
  const others = decorated.filter((x) => !isPhone(x.d)).sort(byStrength).map((x) => x.d);
  return { phones, others };
}

// Dual export: this module is required by tests under node and loaded as a
// plain <script> by the renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) module.exports = { isPhone, rankDiscovered };
if (typeof window !== 'undefined') { window.Rank = { isPhone, rankDiscovered }; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/pairing-helpers.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/backend/linux/bus.js src/shared/rank.js test/pairing-helpers.test.js
git commit -m "feat: add macFromPath and phone ranking for discovery"
```

---

## Task 3: `adapter.js` — power state

**Files:**
- Create: `src/main/backend/linux/adapter.js`
- Test: `test/adapter.test.js`

**Interfaces:**
- Consumes: `getInterface`, `systemBus`, `isAbsentError`, `describeDBusError` from `./bus`.
- Produces:
  - `getPower(opts?) -> Promise<boolean | null>` — `null` means **no adapter present**, distinct from `false` meaning present-but-off.
  - `setPower(on, opts?) -> Promise<boolean>` — rejects with the real D-Bus reason.
  - `onPower(cb, opts?) -> Promise<() => void>` — unsubscribe function.
  - `opts` is `{ getInterfaceFn, systemBusFn }`.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { getPower, setPower } = require('../src/main/backend/linux/adapter');

function fakeBus({ powered = true, absent = false, setError = null } = {}) {
  const calls = [];
  const props = {
    async Get(iface, name) {
      calls.push(['Get', iface, name]);
      if (absent) {
        const e = new Error("No such interface 'org.bluez.Adapter1'");
        e.type = 'org.freedesktop.DBus.Error.InvalidArgs';
        throw e;
      }
      return { signature: 'b', value: powered };
    },
    async Set(iface, name, variant) {
      calls.push(['Set', iface, name, variant.value]);
      if (setError) throw new Error(setError);
      powered = variant.value;
    },
    on() {}, off() {},
  };
  return { calls, opts: { getInterfaceFn: async () => props, systemBusFn: () => ({}) } };
}

test('getPower reads Adapter1.Powered', async () => {
  const f = fakeBus({ powered: true });
  assert.strictEqual(await getPower(f.opts), true);
  assert.deepStrictEqual(f.calls[0], ['Get', 'org.bluez.Adapter1', 'Powered']);
});

test('getPower distinguishes off from absent', async () => {
  assert.strictEqual(await getPower(fakeBus({ powered: false }).opts), false);
  assert.strictEqual(await getPower(fakeBus({ absent: true }).opts), null);
});

test('setPower writes a boolean variant', async () => {
  const f = fakeBus({ powered: false });
  assert.strictEqual(await setPower(true, f.opts), true);
  assert.deepStrictEqual(f.calls[0], ['Set', 'org.bluez.Adapter1', 'Powered', true]);
});

test('setPower surfaces the real reason rather than swallowing it', async () => {
  const f = fakeBus({ setError: 'rfkill: Operation not permitted' });
  await assert.rejects(() => setPower(true, f.opts), /rfkill/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/adapter.test.js`
Expected: FAIL — cannot find module `adapter`.

- [ ] **Step 3: Write `adapter.js`**

```javascript
'use strict';
const dbus = require('dbus-next');
const {
  systemBus, unwrap, getInterface, isAbsentError, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const BLUEZ = 'org.bluez';
const PROPS = 'org.freedesktop.DBus.Properties';
const ADAPTER = 'org.bluez.Adapter1';
// Hardcoded to match bus.js's devicePathFor/modemPathFor, which already assume
// hci0. A multi-adapter machine is out of scope for this project.
const ADAPTER_PATH = '/org/bluez/hci0';

async function adapterProps({ getInterfaceFn = getInterface, systemBusFn = systemBus } = {}) {
  return getInterfaceFn(systemBusFn(), BLUEZ, ADAPTER_PATH, PROPS);
}

// null means NO ADAPTER, false means present but powered down. Collapsing the
// two would make 1a offer a "Turn on Bluetooth" button for hardware that does
// not exist.
async function getPower(opts = {}) {
  try {
    const props = await adapterProps(opts);
    const v = await props.Get(ADAPTER, 'Powered');
    return Boolean(v && typeof v === 'object' && 'value' in v ? v.value : v);
  } catch (err) {
    if (isAbsentError(err)) return null;
    throw new Error(describeDBusError(err));
  }
}

async function setPower(on, opts = {}) {
  const props = await adapterProps(opts);
  try {
    await props.Set(ADAPTER, 'Powered', new dbus.Variant('b', Boolean(on)));
  } catch (err) {
    // rfkill and polkit denials land here. The user must see the real reason:
    // "could not turn on Bluetooth" with no cause is unactionable.
    throw new Error(describeDBusError(err));
  }
  return Boolean(on);
}

async function onPower(cb, opts = {}) {
  const props = await adapterProps(opts);
  const handler = (iface, changed) => {
    if (iface !== ADAPTER) return;
    const c = unwrap(changed);
    if ('Powered' in c) cb(Boolean(c.Powered));
  };
  props.on('PropertiesChanged', handler);
  return () => props.off('PropertiesChanged', handler);
}

module.exports = { getPower, setPower, onPower, ADAPTER_PATH };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adapter.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/linux/adapter.js test/adapter.test.js
git commit -m "feat: read and write the Bluetooth adapter power state"
```

---

## Task 4: `adapter.js` — discovery

Discovery uses **one** mechanism: poll `GetManagedObjects` on a tick while scanning and emit devices whose properties changed. `InterfacesAdded` alone is not enough — BlueZ delivers a device with little more than an address and fills in `Name`, `Class` and `RSSI` through later signals, which is precisely the late-arrival case Task 2's ranking exists to handle. Polling covers additions, updates and removals with a single code path and no per-device listener to leak.

**Files:**
- Modify: `src/main/backend/linux/adapter.js`
- Test: `test/adapter.test.js` (extend)

**Interfaces:**
- Consumes: `rankDiscovered` is **not** used here — ranking is the renderer's concern; this module emits raw devices.
- Produces:
  - `startScan(opts?) -> Promise<void>`
  - `stopScan(opts?) -> Promise<void>`
  - `onDiscovered(cb, opts?) -> () => void` — `cb` receives `{ mac, name, icon, cls, paired, connected, rssi }`, or `{ mac, gone: true }` on removal.
  - `_pollOnce(state, om)` — exported for tests only.

- [ ] **Step 1: Write the failing test (append to `test/adapter.test.js`)**

```javascript
const { _pollOnce } = require('../src/main/backend/linux/adapter');

function managed(devices) {
  const out = {};
  for (const d of devices) {
    out[`/org/bluez/hci0/dev_${d.mac.replace(/:/g, '_')}`] = {
      'org.bluez.Device1': {
        Address: { value: d.mac }, Alias: { value: d.name },
        Icon: d.icon === undefined ? undefined : { value: d.icon },
        Class: d.cls === undefined ? undefined : { value: d.cls },
        Paired: { value: Boolean(d.paired) }, Connected: { value: Boolean(d.connected) },
        RSSI: d.rssi === undefined ? undefined : { value: d.rssi },
      },
    };
  }
  return out;
}

test('_pollOnce emits each newly seen device once', async () => {
  const seen = [];
  const state = { last: new Map() };
  const om = { GetManagedObjects: async () => managed([{ mac: '44:CD:0E:AD:5E:34', name: 'F120B' }]) };
  await _pollOnce(state, om, (d) => seen.push(d));
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.strictEqual(seen.length, 1, 'unchanged device must not re-emit');
  assert.strictEqual(seen[0].mac, '44:CD:0E:AD:5E:34');
  assert.strictEqual(seen[0].name, 'F120B');
});

test('_pollOnce re-emits when a late Class arrives', async () => {
  const seen = [];
  const state = { last: new Map() };
  let cls;
  const om = { GetManagedObjects: async () => managed([{ mac: '44:CD:0E:AD:5E:34', name: 'F120B', cls }]) };
  await _pollOnce(state, om, (d) => seen.push(d));
  cls = 0x5a020c;
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1].cls, 0x5a020c);
});

test('_pollOnce emits a gone marker when a device disappears', async () => {
  const seen = [];
  const state = { last: new Map() };
  let list = [{ mac: '44:CD:0E:AD:5E:34', name: 'F120B' }];
  const om = { GetManagedObjects: async () => managed(list) };
  await _pollOnce(state, om, (d) => seen.push(d));
  list = [];
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.deepStrictEqual(seen[1], { mac: '44:CD:0E:AD:5E:34', gone: true });
});

test('_pollOnce ignores non-device objects', async () => {
  const seen = [];
  const state = { last: new Map() };
  const om = { GetManagedObjects: async () => ({ '/org/bluez/hci0': { 'org.bluez.Adapter1': {} } }) };
  await _pollOnce(state, om, (d) => seen.push(d));
  assert.strictEqual(seen.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/adapter.test.js`
Expected: FAIL — `_pollOnce is not a function`.

- [ ] **Step 3: Implement discovery in `adapter.js`**

Add above `module.exports`:

```javascript
const OM_PATH = '/';
const OM = 'org.freedesktop.DBus.ObjectManager';
const SCAN_TICK_MS = 1500;

function readDevice(ifaces) {
  const d = ifaces['org.bluez.Device1'];
  if (!d) return null;
  const p = unwrap(d);
  if (!p.Address) return null;
  return {
    mac: String(p.Address).toUpperCase(),
    name: p.Alias || p.Name || String(p.Address).toUpperCase(),
    icon: p.Icon ?? null,
    cls: typeof p.Class === 'number' ? p.Class : null,
    paired: Boolean(p.Paired),
    connected: Boolean(p.Connected),
    rssi: typeof p.RSSI === 'number' ? p.RSSI : null,
  };
}

// Exported for tests. `state.last` maps mac -> the JSON we last emitted, which
// is what makes this emit on CHANGE rather than on every tick - the renderer
// would otherwise rebuild its list 40 times a minute and fight the cursor.
async function _pollOnce(state, om, emit) {
  const objects = await om.GetManagedObjects();
  const present = new Set();
  for (const ifaces of Object.values(objects)) {
    const dev = readDevice(ifaces);
    if (!dev) continue;
    present.add(dev.mac);
    const key = JSON.stringify(dev);
    if (state.last.get(dev.mac) === key) continue;
    state.last.set(dev.mac, key);
    emit(dev);
  }
  for (const mac of [...state.last.keys()]) {
    if (present.has(mac)) continue;
    state.last.delete(mac);
    emit({ mac, gone: true });
  }
}

const discovered = createEmitter();
let scanState = null;

async function startScan(opts = {}) {
  if (scanState) return;
  const { getInterfaceFn = getInterface, systemBusFn = systemBus } = opts;
  const bus = systemBusFn();
  const adapter = await getInterfaceFn(bus, BLUEZ, ADAPTER_PATH, ADAPTER);
  const om = await getInterfaceFn(bus, BLUEZ, OM_PATH, OM);
  const state = { last: new Map(), timer: null };
  scanState = state;
  try {
    await adapter.StartDiscovery();
  } catch (err) {
    scanState = null;
    throw new Error(describeDBusError(err));
  }
  const tick = async () => {
    if (scanState !== state) return;
    // A failed poll must not kill the scan loop: BlueZ briefly rejects
    // GetManagedObjects while an adapter is resetting.
    await _pollOnce(state, om, (d) => discovered.emit(d)).catch(() => {});
    if (scanState === state) state.timer = setTimeout(tick, SCAN_TICK_MS);
  };
  await tick();
}

async function stopScan(opts = {}) {
  const state = scanState;
  scanState = null;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  const { getInterfaceFn = getInterface, systemBusFn = systemBus } = opts;
  try {
    const adapter = await getInterfaceFn(systemBusFn(), BLUEZ, ADAPTER_PATH, ADAPTER);
    await adapter.StopDiscovery();
  } catch { /* adapter already gone, or never started */ }
}

function onDiscovered(cb) { return discovered.on(cb); }
```

Update exports to `{ getPower, setPower, onPower, startScan, stopScan, onDiscovered, ADAPTER_PATH, _pollOnce }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adapter.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/linux/adapter.js test/adapter.test.js
git commit -m "feat: stream discovered Bluetooth devices while scanning"
```

---

## Task 5: `pairing.js` — the agent and `Pair()`

**Files:**
- Create: `src/main/backend/linux/pairing.js`
- Test: `test/pairing.test.js`

**Interfaces:**
- Consumes: `macFromPath` (Task 2), `devicePathFor`, `getInterface`, `systemBus`, `describeDBusError` from `./bus`.
- Produces:
  - `createPairing(opts?) -> { register(), unregister(), pair(mac), confirm(ok), onRequest(cb), setTarget(mac) }`
  - `onRequest(cb)` emits `{ mac, passkey }` where `passkey` is a **6-character zero-padded string**.
  - `register()` resolves `true` on success and `false` when `RegisterAgent` fails — never throws, because spec §7.1 requires degrading rather than dead-ending.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { createPairing } = require('../src/main/backend/linux/pairing');

const F120B = '44:CD:0E:AD:5E:34';
const PATH = '/org/bluez/hci0/dev_44_CD_0E_AD_5E_34';

function harness({ registerFails = false, pairError = null } = {}) {
  const exported = {};
  const bus = {
    export(path, iface) { exported.path = path; exported.iface = iface; },
    unexport() { exported.path = null; },
  };
  const mgr = {
    async RegisterAgent(path, cap) {
      if (registerFails) throw new Error('Already Exists');
      exported.registered = [path, cap];
    },
    async UnregisterAgent() { exported.registered = null; },
  };
  const device = { async Pair() { if (pairError) throw new Error(pairError); exported.paired = true; } };
  const getInterfaceFn = async (_b, _s, path, iface) => {
    if (iface === 'org.bluez.AgentManager1') return mgr;
    if (path === PATH) return device;
    throw new Error('unexpected ' + path + ' ' + iface);
  };
  return { exported, opts: { getInterfaceFn, systemBusFn: () => bus } };
}

test('register succeeds and never requests the default agent', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  assert.strictEqual(await p.register(), true);
  assert.strictEqual(h.exported.registered[1], 'KeyboardDisplay');
});

test('register returns false rather than throwing when the name is taken', async () => {
  const h = harness({ registerFails: true });
  const p = createPairing(h.opts);
  assert.strictEqual(await p.register(), false);
});

test('RequestConfirmation emits a zero-padded 6-digit passkey', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  const seen = [];
  p.onRequest((r) => seen.push(r));
  const pending = h.exported.iface.RequestConfirmation(PATH, 1234);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, [{ mac: F120B, passkey: '001234' }]);
  p.confirm(true);
  await pending;
});

test('confirm(false) rejects the pending D-Bus reply', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.onRequest(() => {});
  const pending = h.exported.iface.RequestConfirmation(PATH, 42);
  await new Promise((r) => setImmediate(r));
  p.confirm(false);
  await assert.rejects(() => pending);
});

test('AuthorizeService accepts only the device being paired', async () => {
  const h = harness();
  const p = createPairing(h.opts);
  await p.register();
  p.setTarget(F120B);
  await h.exported.iface.AuthorizeService(PATH, '0000111e-0000-1000-8000-00805f9b34fb');
  await assert.rejects(
    () => h.exported.iface.AuthorizeService('/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF', 'x'),
    /Rejected|not the device/i);
});

test('pair() surfaces the real reason on failure', async () => {
  const h = harness({ pairError: 'AuthenticationTimeout' });
  const p = createPairing(h.opts);
  await assert.rejects(() => p.pair(F120B), /AuthenticationTimeout/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/pairing.test.js`
Expected: FAIL — cannot find module `pairing`.

- [ ] **Step 3: Write `pairing.js`**

```javascript
'use strict';
const dbus = require('dbus-next');
const {
  systemBus, getInterface, devicePathFor, macFromPath, describeDBusError,
} = require('./bus');
const { createEmitter } = require('../interface');

const BLUEZ = 'org.bluez';
const AGENT_PATH = '/konnect/pairing/agent';
// KeyboardDisplay is what makes BlueZ choose numeric comparison - the
// six-digit code shown on both sides - which is exactly the canvas's 1d.
const CAPABILITY = 'KeyboardDisplay';

function createPairing({ getInterfaceFn = getInterface, systemBusFn = systemBus } = {}) {
  const requests = createEmitter();
  let pending = null;      // { resolve, reject } for the open Agent1 reply
  let targetMac = null;    // the ONLY device we will auto-authorise
  let registered = false;
  let agent = null;

  const { Interface } = dbus.interface;

  class KonnectPairingAgent extends Interface {
    // Numeric comparison. Hold the D-Bus reply open until the user answers.
    RequestConfirmation(devicePath, passkey) {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        requests.emit({
          mac: macFromPath(devicePath),
          passkey: String(passkey).padStart(6, '0'),
        });
      });
    }

    // Legacy PIN handsets. Same shape; the renderer shows the same screen.
    RequestPinCode(devicePath) {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, wantsPin: true };
        requests.emit({ mac: macFromPath(devicePath), passkey: null });
      });
    }

    DisplayPasskey(devicePath, passkey) {
      requests.emit({
        mac: macFromPath(devicePath),
        passkey: String(passkey).padStart(6, '0'),
      });
    }

    // The ONLY method answered without asking the user, and only for the
    // device the user is actively pairing. An agent that authorises any
    // caller is a standing security hole.
    AuthorizeService(devicePath) {
      const mac = macFromPath(devicePath);
      if (!targetMac || mac !== targetMac) {
        throw new dbus.DBusError(`${BLUEZ}.Error.Rejected`, 'not the device being paired');
      }
    }

    Cancel() {
      if (pending) pending.reject(new dbus.DBusError(`${BLUEZ}.Error.Canceled`, 'cancelled'));
      pending = null;
    }

    Release() { pending = null; }
  }

  KonnectPairingAgent.configureMembers({
    methods: {
      RequestConfirmation: { inSignature: 'ou', outSignature: '' },
      RequestPinCode: { inSignature: 'o', outSignature: 's' },
      DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
      AuthorizeService: { inSignature: 'os', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
      Release: { inSignature: '', outSignature: '' },
    },
  });

  return {
    // Returns false rather than throwing: spec §7.1 requires onboarding to
    // degrade to the shipped select-and-connect flow when another agent
    // (GNOME, KDE) already holds the name.
    async register() {
      if (registered) return true;
      const bus = systemBusFn();
      agent = new KonnectPairingAgent(`${BLUEZ}.Agent1`);
      bus.export(AGENT_PATH, agent);
      try {
        const mgr = await getInterfaceFn(bus, BLUEZ, '/org/bluez', 'org.bluez.AgentManager1');
        // Deliberately NOT RequestDefaultAgent - see spec §5.2.
        await mgr.RegisterAgent(AGENT_PATH, CAPABILITY);
      } catch {
        try { bus.unexport(AGENT_PATH, agent); } catch { /* never exported */ }
        agent = null;
        return false;
      }
      registered = true;
      return true;
    },

    async unregister() {
      if (!registered) return;
      registered = false;
      const bus = systemBusFn();
      try {
        const mgr = await getInterfaceFn(bus, BLUEZ, '/org/bluez', 'org.bluez.AgentManager1');
        await mgr.UnregisterAgent(AGENT_PATH);
        bus.unexport(AGENT_PATH, agent);
      } catch { /* already gone */ }
      agent = null;
      pending = null;
    },

    setTarget(mac) { targetMac = mac ? String(mac).toUpperCase() : null; },

    async pair(mac) {
      targetMac = String(mac).toUpperCase();
      const device = await getInterfaceFn(systemBusFn(), BLUEZ, devicePathFor(mac), 'org.bluez.Device1');
      try {
        await device.Pair();
      } catch (err) {
        throw new Error(describeDBusError(err));
      }
    },

    confirm(ok) {
      if (!pending) return;
      const p = pending;
      pending = null;
      if (ok) p.resolve(p.wantsPin ? '0000' : undefined);
      else p.reject(new dbus.DBusError(`${BLUEZ}.Error.Rejected`, 'user declined'));
    },

    onRequest(cb) { return requests.on(cb); },
  };
}

module.exports = { createPairing, AGENT_PATH };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pairing.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/backend/linux/pairing.js test/pairing.test.js
git commit -m "feat: BlueZ pairing agent with numeric confirmation"
```

---

## Task 6: The onboarding state machine

A pure reducer — no DOM, no IPC, no Electron — following the `src/shared/phone.js` precedent. This is what makes the whole flow testable.

**Files:**
- Create: `src/shared/onboarding-state.js`
- Test: `test/onboarding-state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `INITIAL` — the starting state object.
  - `reduce(state, event) -> state` — pure; never mutates its input.
  - State shape: `{ name, adapter: { present, powered, reason }, devices: Device[], target, passkey, error, checks, showAll, degraded }`
  - `name` is one of `'bt-off' | 'scanning' | 'pairing' | 'connecting' | 'connected'`.
  - Event types: `adapter`, `scan-device`, `scan-gone`, `pick`, `passkey`, `pair-ok`, `pair-failed`, `connect-ok`, `connect-failed`, `agent-unavailable`, `toggle-all`, `cancel`.

- [ ] **Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { INITIAL, reduce } = require('../src/shared/onboarding-state');

const on = (s) => reduce(s, { type: 'adapter', present: true, powered: true });
const F120B = { mac: '44:CD:0E:AD:5E:34', name: 'F120B', paired: false };
const PAIRED = { mac: '30:BB:7D:21:99:DA', name: 'OnePlus 10R 5G', paired: true };

test('starts in bt-off', () => {
  assert.strictEqual(INITIAL.name, 'bt-off');
});

test('powering on moves to scanning', () => {
  assert.strictEqual(on(INITIAL).name, 'scanning');
});

test('powering off from any state returns to bt-off', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'adapter', present: true, powered: false });
  assert.strictEqual(s.name, 'bt-off');
});

test('an absent adapter records that there is nothing to turn on', () => {
  const s = reduce(INITIAL, { type: 'adapter', present: false, powered: false, reason: 'no adapter' });
  assert.strictEqual(s.name, 'bt-off');
  assert.strictEqual(s.adapter.present, false);
});

test('discovered devices accumulate and dedupe by mac', () => {
  let s = on(INITIAL);
  s = reduce(s, { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'scan-device', device: { ...F120B, name: 'F120B ' } });
  assert.strictEqual(s.devices.length, 1);
  assert.strictEqual(s.devices[0].name, 'F120B ');
});

test('a gone device is removed', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'scan-gone', mac: F120B.mac });
  assert.deepStrictEqual(s.devices, []);
});

test('picking an UNPAIRED device goes to pairing', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  assert.strictEqual(s.name, 'pairing');
  assert.strictEqual(s.target, F120B.mac);
});

test('picking an ALREADY-PAIRED device skips pairing entirely', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: PAIRED });
  s = reduce(s, { type: 'pick', mac: PAIRED.mac });
  assert.strictEqual(s.name, 'connecting');
});

test('the passkey lands on the pairing state', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'passkey', mac: F120B.mac, passkey: '001234' });
  assert.strictEqual(s.passkey, '001234');
});

test('a failed pair returns to scanning WITH the reason', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'pair-failed', reason: 'AuthenticationTimeout' });
  assert.strictEqual(s.name, 'scanning');
  assert.match(s.error, /AuthenticationTimeout/);
  assert.strictEqual(s.passkey, null, 'a stale passkey must not survive');
});

test('pair-ok then connect-ok reaches connected with checks', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'pair-ok' });
  assert.strictEqual(s.name, 'connecting');
  s = reduce(s, { type: 'connect-ok', checks: [{ label: 'HFP', ok: true }] });
  assert.strictEqual(s.name, 'connected');
  assert.strictEqual(s.checks.length, 1);
});

test('agent-unavailable marks the flow degraded without leaving the state machine', () => {
  const s = reduce(on(INITIAL), { type: 'agent-unavailable', reason: 'Already Exists' });
  assert.strictEqual(s.degraded, true);
  assert.strictEqual(s.name, 'scanning');
});

test('cancel from pairing returns to scanning and clears the passkey', () => {
  let s = reduce(on(INITIAL), { type: 'scan-device', device: F120B });
  s = reduce(s, { type: 'pick', mac: F120B.mac });
  s = reduce(s, { type: 'passkey', mac: F120B.mac, passkey: '001234' });
  s = reduce(s, { type: 'cancel' });
  assert.strictEqual(s.name, 'scanning');
  assert.strictEqual(s.passkey, null);
});

test('reduce never mutates its input', () => {
  const before = on(INITIAL);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'scan-device', device: F120B });
  assert.strictEqual(JSON.stringify(before), snapshot);
});

test('an unknown event returns the same state object', () => {
  const s = on(INITIAL);
  assert.strictEqual(reduce(s, { type: 'nonsense' }), s);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/onboarding-state.test.js`
Expected: FAIL — cannot find module `onboarding-state`.

- [ ] **Step 3: Write `src/shared/onboarding-state.js`**

```javascript
'use strict';

// Pure state machine for the 1a-1e onboarding flow (spec §6.2). No DOM, no
// IPC, no Electron - everything here is testable under `node --test`, which
// is the whole reason it lives in shared/ rather than in the renderer.

const INITIAL = Object.freeze({
  name: 'bt-off',
  adapter: { present: false, powered: false, reason: null },
  devices: [],
  target: null,
  passkey: null,
  error: null,
  checks: null,
  showAll: false,
  degraded: false,
});

function findDevice(state, mac) {
  return state.devices.find((d) => d.mac === mac) || null;
}

function reduce(state, event) {
  switch (event.type) {
    case 'adapter': {
      const adapter = {
        present: Boolean(event.present),
        powered: Boolean(event.powered),
        reason: event.reason ?? null,
      };
      if (!adapter.powered) {
        // Losing the radio invalidates everything downstream: a half-finished
        // pairing against a dead adapter is not resumable.
        return {
          ...state, adapter, name: 'bt-off', devices: [], target: null, passkey: null, checks: null,
        };
      }
      // Already past scanning - a redundant "powered on" must not throw the
      // user back to the device list mid-pair.
      if (state.name !== 'bt-off') return { ...state, adapter };
      return { ...state, adapter, name: 'scanning', error: null };
    }

    case 'scan-device': {
      const devices = state.devices.filter((d) => d.mac !== event.device.mac);
      devices.push(event.device);
      return { ...state, devices };
    }

    case 'scan-gone':
      return { ...state, devices: state.devices.filter((d) => d.mac !== event.mac) };

    case 'pick': {
      const device = findDevice(state, event.mac);
      if (!device) return state;
      // Spec §6.2: the branch is decided by Paired at the moment of choosing,
      // not by which list the row came from.
      return {
        ...state,
        target: event.mac,
        passkey: null,
        error: null,
        name: device.paired ? 'connecting' : 'pairing',
      };
    }

    case 'passkey':
      if (state.name !== 'pairing') return state;
      return { ...state, passkey: event.passkey ?? null };

    case 'pair-ok':
      return { ...state, name: 'connecting', passkey: null };

    case 'pair-failed':
      return {
        ...state, name: 'scanning', passkey: null, target: null,
        error: `Pairing failed: ${event.reason}`,
      };

    case 'connect-ok':
      return { ...state, name: 'connected', checks: event.checks || [], error: null };

    case 'connect-failed':
      return {
        ...state, name: 'scanning', target: null, passkey: null,
        error: `Could not connect: ${event.reason}`,
      };

    // Not a state: the flow continues, but without in-app pairing (spec §7.1).
    case 'agent-unavailable':
      return { ...state, degraded: true, error: null };

    case 'toggle-all':
      return { ...state, showAll: !state.showAll };

    case 'cancel':
      return { ...state, name: 'scanning', target: null, passkey: null, error: null };

    default:
      return state;
  }
}

module.exports = { INITIAL, reduce };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/onboarding-state.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/onboarding-state.js test/onboarding-state.test.js
git commit -m "feat: pure state machine for the 1a-1e onboarding flow"
```

---

## Task 7: Wire `backend.adapter` into every backend

**Files:**
- Modify: `src/main/backend/linux/index.js` (both branches)
- Modify: `src/main/backend/mock/index.js`
- Modify: `src/main/backend/windows/index.js`
- Test: `test/backend.test.js` (extend)

**Interfaces:**
- Consumes: `adapter.js` (Tasks 3–4), `createPairing` (Task 5).
- Produces: `backend.adapter` with `getPower, setPower, onPower, startScan, stopScan, onDiscovered, registerAgent, pair, confirm, onPairingRequest` on linux and mock; **absent** on windows, which callers must guard for exactly as `ipc.js` already guards `backend.audio`.

- [ ] **Step 1: Write the failing test (append to `test/backend.test.js`)**

```javascript
test('mock backend exposes an adapter namespace', () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  assert.strictEqual(typeof backend.adapter, 'object');
  for (const m of ['getPower', 'setPower', 'startScan', 'stopScan',
                   'onDiscovered', 'registerAgent', 'pair', 'confirm', 'onPairingRequest']) {
    assert.strictEqual(typeof backend.adapter[m], 'function', `missing adapter.${m}`);
  }
});

test('mock adapter reports a powered radio and discovers the JioPhone', async () => {
  const backend = createBackend({ platform: 'linux', mock: true });
  assert.strictEqual(await backend.adapter.getPower(), true);
  const seen = [];
  backend.adapter.onDiscovered((d) => seen.push(d));
  await backend.adapter.startScan();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(seen.some((d) => d.name === 'F120B'), 'mock must offer a discoverable handset');
  await backend.adapter.stopScan();
});

test('windows backend has no adapter namespace, so callers must guard', () => {
  const backend = createBackend({ platform: 'win32', mock: false });
  assert.strictEqual(backend.adapter, undefined);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/backend.test.js`
Expected: FAIL — `backend.adapter` is undefined on the mock.

- [ ] **Step 3: Build the shared namespace factory in `linux/index.js`**

Add near the top, after the existing requires:

```javascript
const adapter = require('./adapter');
const { createPairing } = require('./pairing');
```

Then, above `createUnboundBackend`:

```javascript
// One pairing instance per process: the agent is a bus-name registration, not
// a per-handset object, and registering twice would fail the second time.
const pairing = createPairing();

// Assembled from adapter.js and pairing.js, mirroring how `audio` is
// assembled. Identical in both branches BECAUSE onboarding runs in the
// unbound one - see spec §4.1.
function adapterNamespace() {
  return {
    getPower: () => adapter.getPower(),
    setPower: (on) => adapter.setPower(on),
    onPower: (cb) => adapter.onPower(cb),
    startScan: () => adapter.startScan(),
    stopScan: () => adapter.stopScan(),
    onDiscovered: (cb) => adapter.onDiscovered(cb),
    registerAgent: () => pairing.register(),
    unregisterAgent: () => pairing.unregister(),
    pair: (mac) => pairing.pair(mac),
    confirm: (ok) => pairing.confirm(ok),
    onPairingRequest: (cb) => pairing.onRequest(cb),
  };
}
```

Add `adapter: adapterNamespace(),` to the object returned by `createUnboundBackend()` **and** to the bound `api` object, beside their existing `audio:` keys.

In the bound backend's existing `dispose()`, add before the other teardown:

```javascript
      // A leaked discovery drains the handset battery and degrades every
      // other Bluetooth link on the machine.
      await adapter.stopScan().catch(() => {});
      await pairing.unregister().catch(() => {});
```

- [ ] **Step 4: Add the mock namespace to `mock/index.js`**

Inside the returned object, beside the existing methods:

```javascript
    adapter: (() => {
      const discovered = createEmitter();
      const pairingRequests = createEmitter();
      let powered = true;
      let timer = null;
      return {
        async getPower() { return powered; },
        async setPower(on) { powered = Boolean(on); return powered; },
        onPower() { return () => {}; },
        async startScan() {
          timer = setTimeout(() => {
            discovered.emit({ mac: '44:CD:0E:AD:5E:34', name: 'F120B', icon: 'phone',
              cls: 0x5a020c, paired: false, connected: false, rssi: -55 });
          }, 30);
        },
        async stopScan() { if (timer) clearTimeout(timer); timer = null; },
        onDiscovered(cb) { return discovered.on(cb); },
        async registerAgent() { return true; },
        async unregisterAgent() {},
        async pair(mac) {
          setTimeout(() => pairingRequests.emit({ mac, passkey: '001234' }), 10);
        },
        confirm() {},
        onPairingRequest(cb) { return pairingRequests.on(cb); },
      };
    })(),
```

`mock/index.js` already requires `createEmitter`; if not, add it from `../interface`.

- [ ] **Step 5: Leave `windows/index.js` alone**

It loops `BACKEND_METHODS`, which this task deliberately does not widen (spec §4.2). `backend.adapter` is therefore `undefined` on Windows, and Task 8 guards it the same way `ipc.js` already guards `backend.audio`. Add a one-line comment recording that:

```javascript
// No `adapter` namespace: Windows has no pairing implementation, so callers
// guard with `if (backend.adapter)` exactly as they do for `audio`.
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 211 existing + the 3 new = 214.

- [ ] **Step 7: Commit**

```bash
git add src/main/backend
git commit -m "feat: expose backend.adapter in both linux branches and the mock"
```

---

## Task 8: IPC and preload

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/main/preload.js`
- Test: `test/setup.test.js` (extend — it already exercises real `registerIpc` handlers)

**Interfaces:**
- Consumes: `backend.adapter` (Task 7).
- Produces, on `window.konnect`: `adapterPower()`, `setAdapterPower(on)`, `startScan()`, `stopScan()`, `pairDevice(mac)`, `confirmPairing(ok)`, `onAdapterChanged(cb)`, `onScanDevice(cb)`, `onPairingRequest(cb)`.

- [ ] **Step 1: Write the failing test (append to `test/setup.test.js`)**

Follow the existing `require.cache` swap pattern already used in that file to capture `ipcMain.handle` registrations.

```javascript
test('adapter channels route to backend.adapter', async () => {
  const calls = [];
  const backend = {
    adapter: {
      getPower: async () => { calls.push('getPower'); return true; },
      setPower: async (on) => { calls.push(['setPower', on]); return on; },
      startScan: async () => { calls.push('startScan'); },
      stopScan: async () => { calls.push('stopScan'); },
      pair: async (mac) => { calls.push(['pair', mac]); },
      confirm: (ok) => { calls.push(['confirm', ok]); },
      registerAgent: async () => { calls.push('registerAgent'); return true; },
      onDiscovered: () => () => {}, onPairingRequest: () => () => {}, onPower: () => () => {},
    },
  };
  const handlers = captureHandlers(backend); // helper already in this file
  assert.strictEqual(await handlers['pair:register'](), true);
  assert.strictEqual(await handlers['adapter:power-get'](), true);
  await handlers['adapter:power-set']({}, true);
  await handlers['scan:start']();
  await handlers['pair:start']({}, '44:CD:0E:AD:5E:34');
  await handlers['pair:confirm']({}, true);
  assert.deepStrictEqual(calls, [
    'registerAgent', 'getPower', ['setPower', true], 'startScan',
    ['pair', '44:CD:0E:AD:5E:34'], ['confirm', true],
  ]);
});

test('adapter channels reject cleanly when the platform has no adapter namespace', async () => {
  const handlers = captureHandlers({});           // windows-shaped backend
  await assert.rejects(() => handlers['adapter:power-get'](), /not available/i);
});
```

If `captureHandlers` does not already exist in `setup.test.js`, extract it from the existing test that swaps `electron` in `require.cache`, so both tests share one helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/setup.test.js`
Expected: FAIL — no `adapter:power-get` handler.

- [ ] **Step 3: Add the channels to `ipc.js`**

Inside the `handlers` object, beside the `window:*` entries:

```javascript
    // Bluetooth adapter and pairing. Guarded because Windows has no adapter
    // namespace, exactly as `backend.audio` is guarded below.
    'adapter:power-get': () => requireAdapter().getPower(),
    'adapter:power-set': (_e, on) => requireAdapter().setPower(Boolean(on)),
    'scan:start': () => requireAdapter().startScan(),
    'scan:stop': () => requireAdapter().stopScan(),
    'pair:start': (_e, mac) => {
      if (!isValidMac(mac)) throw new Error(`invalid MAC address: ${mac}`);
      return requireAdapter().pair(mac);
    },
    'pair:confirm': (_e, ok) => requireAdapter().confirm(Boolean(ok)),
    // Returns false (never throws) when another agent holds the name, which is
    // what lets the renderer degrade per spec §7.1 instead of dead-ending.
    'pair:register': () => requireAdapter().registerAgent(),
```

Add the guard helper above the `handlers` object:

```javascript
  const requireAdapter = () => {
    if (!backend.adapter) throw new Error('Bluetooth pairing is not available on this platform');
    return backend.adapter;
  };
```

`isValidMac` must be imported from `./backend/linux/bus` — `ipc.js` may already import it; if not, add it. **The MAC comes from the renderer and is interpolated into a D-Bus object path, so validating it here is a trust-boundary check, not a nicety.**

Then, beside the existing `backend.audio` subscription at the bottom of `registerIpc`:

```javascript
  if (backend.adapter) {
    backend.adapter.onDiscovered((d) => broadcast('scan:device', d));
    backend.adapter.onPairingRequest((r) => broadcast('pair:request', r));
    backend.adapter.onPower((powered) => broadcast('adapter:changed', { powered, present: true }));
  }
```

- [ ] **Step 4: Mirror them in `preload.js`**

```javascript
  adapterPower: () => ipcRenderer.invoke('adapter:power-get'),
  setAdapterPower: (on) => ipcRenderer.invoke('adapter:power-set', on),
  startScan: () => ipcRenderer.invoke('scan:start'),
  stopScan: () => ipcRenderer.invoke('scan:stop'),
  pairDevice: (mac) => ipcRenderer.invoke('pair:start', mac),
  confirmPairing: (ok) => ipcRenderer.invoke('pair:confirm', ok),
  registerPairingAgent: () => ipcRenderer.invoke('pair:register'),
  onAdapterChanged: (cb) => ipcRenderer.on('adapter:changed', (_e, s) => cb(s)),
  onScanDevice: (cb) => ipcRenderer.on('scan:device', (_e, d) => cb(d)),
  onPairingRequest: (cb) => ipcRenderer.on('pair:request', (_e, r) => cb(r)),
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 216.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.js src/main/preload.js test/setup.test.js
git commit -m "feat: adapter and pairing IPC channels"
```

---

## Task 9: The onboarding renderer

Replaces `wizard.js`. Carries over its two hard-won rules: the `renderToken` guard against out-of-order async tails, and never dead-ending on a failed `Fix`.

**Files:**
- Create: `src/renderer/onboarding.js`
- Delete: `src/renderer/wizard.js`
- Modify: `src/renderer/index.html` (swap the script tag; add the onboarding art/body containers)
- Modify: `src/renderer/styles.css` (full-window mode, passkey, spinner, device rows)
- Modify: `src/renderer/settings.js:55` — `$('#set-change-device')` currently calls `openWizard({ startStep: 2 })`; change to `openOnboarding({ blocking: false })`

**Interfaces:**
- Consumes: `INITIAL`/`reduce` (Task 6) via a plain `<script>` tag — `src/shared/onboarding-state.js` is CommonJS, so the renderer copy must be loaded the same way `phone.js` is today. Check how `index.html` includes `src/shared/phone.js`; if it is not currently loaded in the renderer, add a `<script src="../shared/onboarding-state.js">` **and** a `module.exports` guard so the file works in both contexts:

```javascript
if (typeof module !== 'undefined' && module.exports) module.exports = { INITIAL, reduce };
if (typeof window !== 'undefined') { window.OnboardingState = { INITIAL, reduce }; }
```

- Produces: `openOnboarding({ blocking })`, `closeOnboarding()` — the names `settings.js` and the bootstrap IIFE call.

- [ ] **Step 1: Swap the script tags**

The `#wizard` markup is **unchanged** — `#wizard`, `.onboard-card`, `.onboard-art` and
`#wizard-box` keep their ids and classes so the styles from the design work apply as-is:

```html
  <div id="wizard" class="modal" hidden>
    <div class="onboard-card">
      <div class="onboard-art"><img src="../../assets/jiophone-colored.svg" alt="JioPhone"></div>
      <div class="onboard-body" id="wizard-box"></div>
    </div>
  </div>
```

Only the script tags change:

```html
  <script src="../shared/rank.js"></script>
  <script src="../shared/onboarding-state.js"></script>
  <script src="app.js"></script>
  <script src="settings.js"></script>
  <script src="onboarding.js"></script>
```

- [ ] **Step 2: Write `onboarding.js`**

```javascript
'use strict';
/* global OnboardingState */

const { INITIAL, reduce } = OnboardingState;

let state = INITIAL;
let blocking = false;
// Same guard as wizard.js's renderToken: an async tail that resolves after a
// newer render started must not append to the superseded DOM.
let renderToken = 0;
let unsubscribes = [];

function dispatch(event) {
  const next = reduce(state, event);
  if (next === state) return;
  state = next;
  render();
}

function openOnboarding({ blocking: isBlocking = false } = {}) {
  blocking = isBlocking;
  $('#wizard').hidden = false;
  // Spec §6.1: full-window only when the app is genuinely unusable. When a
  // handset was resolved at bootstrap the app works and this is a suggestion,
  // so hiding the shell behind it would be a lie.
  document.body.classList.toggle('onboarding-blocking', blocking);
  start().catch((err) => dispatch({ type: 'adapter', present: false, powered: false, reason: err.message }));
}

function closeOnboarding() {
  if (blocking) return;
  $('#wizard').hidden = true;
  document.body.classList.remove('onboarding-blocking');
  teardown();
}

function teardown() {
  for (const off of unsubscribes) { try { off(); } catch { /* already gone */ } }
  unsubscribes = [];
  window.konnect.stopScan().catch(() => {});
}

async function start() {
  const powered = await window.konnect.adapterPower();
  dispatch({
    type: 'adapter',
    present: powered !== null,
    powered: powered === true,
    reason: powered === null ? 'No Bluetooth adapter found' : null,
  });

  window.konnect.onAdapterChanged((s) => dispatch({ type: 'adapter', present: true, powered: s.powered }));
  window.konnect.onScanDevice((d) => dispatch(d.gone
    ? { type: 'scan-gone', mac: d.mac }
    : { type: 'scan-device', device: d }));
  window.konnect.onPairingRequest((r) => dispatch({ type: 'passkey', ...r }));

  if (powered === true) await beginScan();
}

let slowScan = false;
let slowTimer = null;

async function beginScan() {
  // Register the agent BEFORE scanning: a user who picks a device the instant
  // it appears must not race an unregistered agent. A false return is not an
  // error - it is spec §7.1's degraded mode.
  const ok = await window.konnect.registerPairingAgent().catch(() => false);
  if (!ok) dispatch({ type: 'agent-unavailable', reason: 'another application owns the pairing agent' });

  slowScan = false;
  if (slowTimer) clearTimeout(slowTimer);
  // Spec §7: after 30s with nothing found, say so rather than spinning forever.
  slowTimer = setTimeout(() => { slowScan = true; render(); }, 30000);

  await window.konnect.startScan().catch((err) => {
    dispatch({ type: 'connect-failed', reason: err.message });
  });
}

function render() {
  const token = ++renderToken;
  const box = $('#wizard-box');
  box.replaceChildren();
  const views = {
    'bt-off': renderBtOff, scanning: renderScanning, pairing: renderPairing,
    connecting: renderConnecting, connected: renderConnected,
  };
  (views[state.name] || renderScanning)(box, token);
}
```

Then the five view functions. Each builds DOM with `createElement`/`textContent` only. The full bodies are long; write them to match these signatures and the canvas copy:

```javascript
function renderBtOff(box) {
  const h = document.createElement('h2');
  h.textContent = state.adapter.present ? 'Bluetooth is turned off' : 'No Bluetooth adapter found';
  const p = document.createElement('p');
  p.textContent = state.adapter.present
    ? 'Konnect uses Bluetooth to reach your JioPhone. Turn it on to start looking for nearby devices.'
    : 'Konnect could not find a Bluetooth adapter on this computer.';
  box.append(h, p);
  if (state.adapter.reason) {
    const why = document.createElement('p');
    why.className = 'muted';
    why.textContent = state.adapter.reason;
    box.append(why);
  }
  const row = document.createElement('div');
  row.className = 'dial-actions';
  // No "Turn on" button when there is no adapter - there is nothing to turn on.
  if (state.adapter.present) {
    const on = document.createElement('button');
    on.className = 'primary';
    on.textContent = 'Turn on Bluetooth';
    on.addEventListener('click', async () => {
      on.disabled = true;
      try {
        await window.konnect.setAdapterPower(true);
        dispatch({ type: 'adapter', present: true, powered: true });
        await beginScan();
      } catch (err) {
        on.disabled = false;
        dispatch({ type: 'adapter', present: true, powered: false, reason: err.message });
      }
    });
    row.append(on);
  }
  box.append(row);
}
```

```javascript
function banner(box) {
  if (!state.error) return;
  const b = document.createElement('div');
  b.className = 'banner';
  b.textContent = state.error;      // device names are untrusted; never innerHTML
  box.append(b);
}

function deviceButton(d) {
  const btn = document.createElement('button');
  btn.className = 'device-row';
  const name = document.createElement('span');
  name.textContent = d.name;
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = `${d.mac}${d.paired ? ' · paired' : ''}`;
  btn.append(name, meta);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    dispatch({ type: 'pick', mac: d.mac });
    try {
      if (d.paired) {
        await window.konnect.connectDevice(d.mac);
        dispatch({ type: 'pair-ok' });
      } else {
        await window.konnect.pairDevice(d.mac);   // resolves once Paired=true
        dispatch({ type: 'pair-ok' });
      }
    } catch (err) {
      dispatch({ type: 'pair-failed', reason: err.message });
    }
  });
  return btn;
}

function renderScanning(box) {
  banner(box);
  const { phones, others } = rankDiscovered(state.devices);
  const h = document.createElement('h2');
  h.textContent = phones.length
    ? `Found ${phones.length} phone${phones.length === 1 ? '' : 's'}`
    : 'Looking for your JioPhone\u2026';
  box.append(h);

  if (state.degraded) {
    const d = document.createElement('p');
    d.className = 'muted';
    d.textContent = 'In-app pairing is unavailable because another application '
      + 'owns the Bluetooth pairing agent. Pair the phone in your system '
      + 'Bluetooth settings, then pick it below.';
    box.append(d);
  }

  if (!phones.length) {
    const row = document.createElement('div');
    row.className = 'dial-actions';
    const spin = document.createElement('div');
    spin.className = 'scan-spinner';
    const p = document.createElement('p');
    p.textContent = slowScan
      ? 'Still looking \u2014 make sure the phone is discoverable.'
      : 'On the phone, open Settings then Bluetooth, and make it visible to nearby devices.';
    row.append(spin, p);
    box.append(row);
  }

  for (const d of phones) box.append(deviceButton(d));

  if (others.length) {
    const toggle = document.createElement('button');
    toggle.className = 'link';
    toggle.textContent = state.showAll
      ? 'Hide other devices'
      : `Show all devices (${others.length} more)`;
    toggle.addEventListener('click', () => dispatch({ type: 'toggle-all' }));
    box.append(toggle);
    if (state.showAll) for (const d of others) box.append(deviceButton(d));
  }
}

function renderPairing(box) {
  const target = state.devices.find((d) => d.mac === state.target);
  const h = document.createElement('h2');
  h.textContent = `Pair with ${target ? target.name : 'this phone'}`;
  box.append(h);

  if (state.passkey) {
    const code = document.createElement('div');
    code.className = 'passkey';
    code.textContent = state.passkey;
    const p = document.createElement('p');
    p.textContent = 'Check that the phone shows the same code, then press Pair.';
    box.append(code, p);
  } else {
    const p = document.createElement('p');
    p.textContent = 'Waiting for the phone to respond\u2026';
    box.append(p);
  }

  const row = document.createElement('div');
  row.className = 'dial-actions';
  const pair = document.createElement('button');
  pair.className = 'primary';
  pair.textContent = 'Pair';
  pair.disabled = !state.passkey;
  pair.addEventListener('click', () => {
    pair.disabled = true;
    window.konnect.confirmPairing(true);
  });
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    window.konnect.confirmPairing(false);
    dispatch({ type: 'cancel' });
  });
  row.append(pair, cancel);
  box.append(row);
}

function renderConnecting(box) {
  const target = state.devices.find((d) => d.mac === state.target);
  const h = document.createElement('h2');
  h.textContent = `Connecting to ${target ? target.name : 'your phone'}\u2026`;
  const spin = document.createElement('div');
  spin.className = 'scan-spinner';
  box.append(h, spin);

  // Fired once per entry into this state; the token guard stops a superseded
  // run from writing into a newer render.
  const token = renderToken;
  (async () => {
    try {
      const result = await window.konnect.verifyLink(state.target);
      const checks = await window.konnect.runSetupChecks(state.target).catch(() => []);
      if (token !== renderToken) return;
      dispatch({ type: 'connect-ok', checks: [...(result.checks || []), ...checks.filter((c) => !c.ok)] });
    } catch (err) {
      if (token !== renderToken) return;
      dispatch({ type: 'connect-failed', reason: err.message });
    }
  })();
}

function renderConnected(box) {
  const target = state.devices.find((d) => d.mac === state.target);
  const h = document.createElement('h2');
  h.textContent = `${target ? target.name : 'Your phone'} is connected`;
  const p = document.createElement('p');
  p.textContent = 'Calls, contacts and call history will now flow through this desktop.';
  box.append(h, p);

  const ul = document.createElement('ul');
  for (const c of state.checks || []) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${c.ok ? 'ok' : 'bad'}`;
    const label = document.createElement('span');
    label.textContent = c.detail ? `${c.label} \u2014 ${c.detail}` : c.label;
    li.append(dot, label);
    if (!c.ok && c.id) {
      const fix = document.createElement('button');
      fix.className = 'primary';
      fix.textContent = 'Fix';
      fix.addEventListener('click', async () => {
        fix.disabled = true;
        const res = await window.konnect.remediate(c.id, state.target).catch(
          (e) => ({ ok: false, reason: 'failed', detail: e.message, command: null }));
        if (res.ok) { dispatch({ type: 'cancel' }); return; }
        // Deliberately NOT a re-render: render() calls replaceChildren(), which
        // would wipe the manual command the user still needs. Same rule as the
        // wizard this replaces.
        showManualStep(li, res);
        fix.disabled = false;
      });
      li.append(fix);
    }
    ul.append(li);
  }
  box.append(ul);

  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = 'Open dialer';
  open.addEventListener('click', async () => {
    open.disabled = true;
    let res;
    try {
      res = await window.konnect.selectDevice(state.target);
    } catch (err) {
      open.disabled = false;
      const e = document.createElement('p');
      e.className = 'muted finish-error';
      e.textContent = `Could not select this handset: ${err.message}`;
      box.append(e);
      return;
    }
    if (res.relaunching) {
      box.replaceChildren();
      const msg = document.createElement('p');
      msg.textContent = 'Starting Konnect with your JioPhone\u2026';
      box.append(msg);
      return;
    }
    blocking = false;
    closeOnboarding();
    renderSettings();
  });
  box.append(open);
}
```

`rankDiscovered` is used by the renderer, so `src/shared/rank.js` (Task 2) needs the same
dual-export guard as `onboarding-state.js`:

```javascript
if (typeof module !== 'undefined' && module.exports) module.exports = { isPhone, rankDiscovered };
if (typeof window !== 'undefined') { window.Rank = { isPhone, rankDiscovered }; }
```

and `index.html` loads it before `onboarding.js`, which opens with
`const { rankDiscovered } = window.Rank;`.

- [ ] **Step 3: Port the bootstrap IIFE from `wizard.js`**

```javascript
// Unchanged rule from spec 2026-09-01 §4.2: blocking only when there is
// genuinely no handset to bind to.
(async () => {
  if (await window.konnect.getSetting('device_mac')) return;
  const status = await window.konnect.getStatus().catch(() => ({}));
  openOnboarding({ blocking: status.error === 'No handset selected' });
})();
```

- [ ] **Step 4: Add the styles**

In `styles.css`:

```css
/* Spec §6.1: the shell is hidden only while onboarding is blocking. */
body.onboarding-blocking #shell,
body.onboarding-blocking #banners { display: none; }
body.onboarding-blocking .modal { background: none; backdrop-filter: none; }

.passkey {
  font: 500 40px/1 var(--mono); letter-spacing: .16em;
  padding: 14px 20px; border-radius: 14px;
  background: var(--glass2); border: 1px solid var(--gb); align-self: flex-start;
}
.scan-spinner {
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid var(--gb); border-top-color: var(--acc);
  animation: jkSpin .9s linear infinite;
}
@keyframes jkSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .scan-spinner { animation: none; } }
button.device-row { width: 100%; text-align: left; cursor: pointer; }
```

- [ ] **Step 5: Delete `wizard.js` and update `settings.js`**

```bash
git rm src/renderer/wizard.js
```

In `settings.js`, change the `#set-change-device` listener from `openWizard({ startStep: 2 })` to `openOnboarding({ blocking: false })`.

- [ ] **Step 6: Verify the renderer loads and drives**

Run the app and drive it with the CDP harness from the run session:

```bash
npx electron . --remote-debugging-port=9222
```

Check: no console exceptions; `openOnboarding({blocking:true})` hides `#shell`; powering the adapter off in system settings moves the card to `bt-off`.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add -A src/renderer docs
git commit -m "feat: 1a-1e onboarding renderer, retiring the four-step wizard"
```

---

## Task 10: Amend the superseded spec

`2026-09-01-konnect-settings-wizard-design.md` still says in two places that in-app pairing will never exist. Leaving it is how a codebase acquires documentation that lies.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-konnect-settings-wizard-design.md` (§3 table row, §17 list item)

**Interfaces:**
- Consumes: nothing. Produces: nothing. Documentation only.

- [ ] **Step 1: Amend the §3 decisions table**

Replace the `Wizard scope` row with:

```markdown
| Wizard scope | ~~Select + connect only; no in-app pairing.~~ **Superseded 2026-09-02** by `2026-09-02-konnect-onboarding-pairing-design.md`, which adds `StartDiscovery` and `org.bluez.Agent1`. |
```

- [ ] **Step 2: Amend the §17 non-goals list**

Replace the first bullet with:

```markdown
- ~~In-app Bluetooth pairing (`StartDiscovery`, `org.bluez.Agent1`)~~ — **superseded 2026-09-02**, see `2026-09-02-konnect-onboarding-pairing-design.md`
```

- [ ] **Step 3: Verify no other contradiction survives**

Run: `grep -rn "no in-app pairing\|No in-app pairing\|Never register a BlueZ" docs/ | grep -v 2026-09-02`
Expected: only the two struck-through lines above, plus the constraint line in `plans/2026-09-01-konnect-settings-wizard.md`, which is historical and stays as written.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-konnect-settings-wizard-design.md
git commit -m "docs: mark in-app pairing superseded in the prior spec"
```

---

## Self-Review

**Spec coverage.** Every numbered spec section maps to a task: §2 verified facts → Task 2's fixtures; §3.1 ranking → Task 2; §4.2/4.3 namespace → Task 7; §5.1/5.2 agent → Tasks 1 and 5; §6.1 shell → Task 9 Step 4; §6.2 reducer → Task 6; §6.3/6.4 screens → Task 9; §7 error table → Tasks 3 (absent adapter, rejected write), 5 (register returns false), 6 (pair-failed, connect-failed), 9 (rendering); §8 IPC → Task 8; §9 testing → Tasks 2–6; §10 build order → task order; §11 non-goals → nothing built.

**Spec §7 row-by-row:** absent adapter and rejected `Powered` write → Task 3; adapter disappears mid-flow → Task 6's `adapter` case clearing downstream state; 30s with nothing found → Task 9's `slowScan` timer in `beginScan`/`renderScanning`; device vanishes → Task 6 `scan-gone`; `Pair()` rejected → Task 6 `pair-failed` and Task 9's `deviceButton` catch; already paired → Task 6's `pick` branch; `RegisterAgent` fails → Task 5's `false` return, Task 8's `pair:register`, Task 9's `agent-unavailable` dispatch and degraded copy.

**Type consistency.** `Device` is `{mac, name, icon, cls, paired, connected, rssi}` in Tasks 2, 4, 6 and 7. `passkey` is a zero-padded **string** everywhere (Task 5 pads it, Task 6 stores it, Task 9 renders it). `getPower` returns `boolean | null` in Tasks 3, 7, 8 and 9, with `null` always meaning absent. `register()` returns `boolean` in Task 5 and is consumed as such in Task 7.
