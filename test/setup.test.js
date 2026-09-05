const test = require('node:test');
const assert = require('node:assert');
const { runChecks, remediate, WIREPLUMBER_CONFIG_BODY, classifyFailure, CHECKS } = require('../src/main/setup');
const { modemPathFor } = require('../src/main/backend/linux/bus');

const OTHER_MAC = '30:BB:7D:21:99:DA';

// Swaps 'electron' in the module cache for a fake that just records
// ipcMain.handle() registrations, forces a fresh require of ipc.js (so it
// picks up that fake plus whatever else the caller has already swapped into
// the cache, e.g. './setup'), calls registerIpc() with `backend` merged onto
// harmless no-op defaults, and returns the captured { channel: handler }
// map. registerIpc() registers handlers synchronously at require time, so
// this module-cache swap is the only way to get at them. The electron/ipc
// cache entries are restored before returning - callers that also swap
// other modules (e.g. './setup') are responsible for restoring those
// themselves, after they're done using the returned handlers.
function captureHandlers(backend, opts = {}, dialog = {}) {
  const electronPath = require.resolve('electron');
  const handlers = {};
  const savedElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
      dialog, shell: {}, app: {}, BrowserWindow: {},
    },
  };

  const ipcPath = require.resolve('../src/main/ipc');
  const savedIpc = require.cache[ipcPath];
  delete require.cache[ipcPath];

  try {
    const { registerIpc } = require('../src/main/ipc');
    const fullBackend = {
      onDeviceStatus: () => () => {},
      onCall: () => () => {},
      onContacts: () => () => {},
      onCallVolume: () => () => {},
      ...backend,
    };
    registerIpc({ backend: fullBackend, store: {}, broadcast: () => {}, ...opts });
  } finally {
    if (savedElectron) require.cache[electronPath] = savedElectron; else delete require.cache[electronPath];
    if (savedIpc) require.cache[ipcPath] = savedIpc; else delete require.cache[ipcPath];
  }

  return handlers;
}

// exec stub: maps a substring of the command to { stdout, code }
function fakeExec(routes) {
  return async (cmd) => {
    for (const [needle, result] of Object.entries(routes)) {
      if (cmd.includes(needle)) {
        if (result.code && result.code !== 0) {
          const err = new Error('command failed');
          err.code = result.code;
          err.stdout = result.stdout || '';
          throw err;
        }
        return { stdout: result.stdout || '', stderr: '' };
      }
    }
    const err = new Error(`unstubbed command: ${cmd}`);
    err.code = 127;
    throw err;
  };
}

test('all checks pass on a fully configured system', async () => {
  const exec = fakeExec({
    'which ofonod': { stdout: '/usr/sbin/ofonod' },
    'is-active ofono': { stdout: 'active' },
    'hfphsp-backend': { stdout: 'bluez5.hfphsp-backend = "ofono"' },
    'org.ofono.Modem': { stdout: '"Powered" b true "Online" b true' },
  });
  const results = await runChecks({ exec, mac: OTHER_MAC });
  assert.ok(results.length >= 4);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results, null, 2));
});

test('missing ofono is reported with a remedy, not a crash', async () => {
  const exec = fakeExec({
    'which ofonod': { code: 1 },
    'is-active ofono': { stdout: 'inactive' },
    'hfphsp-backend': { code: 1 },
    'org.ofono.Modem': { code: 1 },
  });
  const results = await runChecks({ exec });
  const ofono = results.find((r) => r.id === 'ofono-installed');
  assert.strictEqual(ofono.ok, false);
  assert.match(ofono.remedy, /apt install/);
});

test('modem offline is detected separately from ofono being absent', async () => {
  const exec = fakeExec({
    'which ofonod': { stdout: '/usr/sbin/ofonod' },
    'is-active ofono': { stdout: 'active' },
    'hfphsp-backend': { stdout: 'bluez5.hfphsp-backend = "ofono"' },
    'org.ofono.Modem': { stdout: '"Powered" b false "Online" b false' },
  });
  const results = await runChecks({ exec, mac: OTHER_MAC });
  assert.strictEqual(results.find((r) => r.id === 'ofono-installed').ok, true);
  assert.strictEqual(results.find((r) => r.id === 'modem-online').ok, false);
});

test('wireplumber config body sets the ofono backend', () => {
  assert.match(WIREPLUMBER_CONFIG_BODY, /bluez5\.hfphsp-backend/);
  assert.match(WIREPLUMBER_CONFIG_BODY, /ofono/);
});

test('remediate writes the wireplumber config and restarts in the required order', async () => {
  const calls = [];
  const exec = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
  const written = [];
  const writeFile = async (p, body) => { written.push([p, body]); };

  const r = await remediate('wireplumber-backend', { exec, writeFile });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(written.length, 1);

  // Order matters: wireplumber releases the HFP UUID, ofono claims it, then
  // wireplumber reattaches to the ofono backend. See spec section 4.2.
  const order = calls.join(' | ');
  const wp1 = order.indexOf('wireplumber');
  const of1 = order.indexOf('ofono');
  const wp2 = order.lastIndexOf('wireplumber');
  assert.ok(wp1 < of1 && of1 < wp2, `wrong restart order: ${order}`);
});

test('remediate on an unknown id rejects rather than silently succeeding', async () => {
  await assert.rejects(
    () => remediate('nope', { exec: async () => ({ stdout: '' }), writeFile: async () => {} }),
    /unknown remediation/i);
});

test('a dismissed authentication prompt surfaces the command to run by hand', async () => {
  const exec = async () => { const e = new Error('Command failed'); e.code = 126; throw e; };
  const r = await remediate('ofono-installed', { exec, writeFile: async () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
  assert.match(r.command, /apt install/);
});

test('an unavailable pkexec is distinguished from a dismissed prompt', async () => {
  const exec = async () => { const e = new Error('not found'); e.code = 127; throw e; };
  const r = await remediate('ofono-installed', { exec, writeFile: async () => {} });
  assert.strictEqual(r.reason, 'unavailable');
  assert.ok(r.command, 'the command must still be offered');
});

test('a genuine command failure still offers the command, not a dead end', async () => {
  const exec = async () => { const e = new Error('apt exploded'); e.code = 100; throw e; };
  const r = await remediate('ofono-installed', { exec, writeFile: async () => {} });
  assert.strictEqual(r.reason, 'failed');
  assert.ok(r.command);
  assert.match(r.detail, /exploded/);
});

test('classifyFailure handles a non-numeric or missing code', () => {
  assert.strictEqual(classifyFailure(new Error('no code')), 'failed');
  assert.strictEqual(classifyFailure(null), 'failed');
});

test('every check offers a runnable manual command, not prose', () => {
  for (const check of CHECKS) {
    assert.ok(check.manualCommand, `${check.id} has no manualCommand`);
    // A runnable command starts with a program name, not an English verb
    // phrase. This is the guard against regressing to prose.
    assert.match(
      check.manualCommand(OTHER_MAC),
      /^(pkexec|sudo|systemctl|mkdir|cat|busctl|hciconfig)\b/,
      `${check.id}'s manualCommand does not start with a command`);
  }
});

test('the wireplumber manual command carries the config and the restart order', () => {
  const cmd = CHECKS.find((c) => c.id === 'wireplumber-backend').manualCommand(OTHER_MAC);
  assert.match(cmd, /hfphsp-backend/);            // the config content is inlined
  const wp1 = cmd.indexOf('systemctl --user restart wireplumber');
  const of1 = cmd.indexOf('systemctl restart ofono');
  const wp2 = cmd.lastIndexOf('systemctl --user restart wireplumber');
  assert.ok(wp1 !== -1 && of1 !== -1 && wp2 > of1 && wp1 < of1,
    'manual command must preserve wireplumber -> ofono -> wireplumber');
});

test('manual commands elevate the same way the automated remedies do', () => {
  // The automated path uses pkexec throughout. A manual command that reaches
  // for sudo fails on a system with a polkit rule but no sudoers entry -
  // precisely the locked-down setup this fallback exists for.
  for (const check of CHECKS) {
    assert.doesNotMatch(
      check.manualCommand(OTHER_MAC), /\bsudo\b/,
      `${check.id}'s manualCommand uses sudo; the automated path uses pkexec`);
  }
});

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

// The critical wizard bug: setup:check/setup:remediate/device:verify resolved
// with `mac: getMac()` (the BOUND handset) even when the wizard was checking
// a handset the user had just selected but not bound to. Exercises the real
// ipc.js channel handlers (not just runChecks/remediate directly), via
// captureHandlers(); also swaps in a fake './setup' via the module cache so
// runChecks/remediate report the mac they were actually called with.
test('the setup:check, setup:remediate and device:verify channels honour an explicit mac over the bound one', async () => {
  const setupPath = require.resolve('../src/main/setup');
  const savedSetup = require.cache[setupPath];
  const seenChecksMac = [];
  const seenRemediateMac = [];
  require.cache[setupPath] = {
    id: setupPath, filename: setupPath, loaded: true,
    exports: {
      runChecks: async (opts) => { seenChecksMac.push(opts.mac); return []; },
      remediate: async (_id, opts) => { seenRemediateMac.push(opts.mac); return { ok: true }; },
    },
  };

  try {
    const seenVerifyMac = [];
    const backend = {
      verifyLink: async (mac) => { seenVerifyMac.push(mac); return { ok: true, reason: null, checks: [] }; },
    };
    const handlers = captureHandlers(backend, { getMac: () => 'BOUND:MAC' });

    await handlers['setup:check'](null, 'SELECTED:MAC');
    await handlers['setup:check'](null, undefined);
    await handlers['setup:remediate'](null, 'ofono-installed', 'SELECTED:MAC');
    await handlers['device:verify'](null, 'SELECTED:MAC');
    await handlers['device:verify'](null, undefined);

    assert.deepStrictEqual(seenChecksMac, ['SELECTED:MAC', 'BOUND:MAC'],
      'setup:check must pass the explicit mac through, and fall back to the bound one only when none is given');
    assert.deepStrictEqual(seenRemediateMac, ['SELECTED:MAC']);
    assert.deepStrictEqual(seenVerifyMac, ['SELECTED:MAC', 'BOUND:MAC']);
  } finally {
    // Restore the module cache so later tests in this process see the real
    // ./setup module again.
    if (savedSetup) require.cache[setupPath] = savedSetup; else delete require.cache[setupPath];
  }
});

// backend.adapter is undefined on Windows by design; every adapter channel
// must guard for that rather than assume the namespace exists.
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
      unregisterAgent: async () => { calls.push('unregisterAgent'); },
      onDiscovered: () => () => {}, onPairingRequest: () => () => {}, onPower: async () => () => {},
    },
  };
  const handlers = captureHandlers(backend);
  assert.strictEqual(await handlers['pair:register'](), true);
  await handlers['pair:unregister']();
  assert.strictEqual(await handlers['adapter:power-get'](), true);
  await handlers['adapter:power-set']({}, true);
  await handlers['scan:start']();
  await handlers['pair:start']({}, '44:CD:0E:AD:5E:34');
  await handlers['pair:confirm']({}, true);
  assert.deepStrictEqual(calls, [
    'registerAgent', 'unregisterAgent', 'getPower', ['setPower', true], 'startScan',
    ['pair', '44:CD:0E:AD:5E:34'], ['confirm', true],
  ]);
});

test('pair:start rejects an invalid mac instead of reaching the backend', async () => {
  const calls = [];
  const backend = {
    adapter: {
      pair: async (mac) => { calls.push(mac); },
      onDiscovered: () => () => {}, onPairingRequest: () => () => {}, onPower: async () => () => {},
    },
  };
  const handlers = captureHandlers(backend);
  await assert.rejects(async () => handlers['pair:start']({}, 'not-a-mac; DROP TABLE'), /invalid MAC/i);
  assert.deepStrictEqual(calls, [], 'the backend must never see an unvalidated mac');
});

test('adapter channels reject cleanly when the platform has no adapter namespace', async () => {
  const handlers = captureHandlers({});           // windows-shaped backend
  await assert.rejects(async () => handlers['adapter:power-get'](), /not available/i);
  await assert.rejects(async () => handlers['adapter:power-set']({}, true), /not available/i);
  await assert.rejects(async () => handlers['scan:start'](), /not available/i);
  await assert.rejects(async () => handlers['scan:stop'](), /not available/i);
  await assert.rejects(async () => handlers['pair:start']({}, '44:CD:0E:AD:5E:34'), /not available/i);
  await assert.rejects(async () => handlers['pair:confirm']({}, true), /not available/i);
  await assert.rejects(async () => handlers['pair:register'](), /not available/i);
  await assert.rejects(async () => handlers['pair:unregister'](), /not available/i);
});

// The startup crash: adapter.onPower is async and subscribed fire-and-forget,
// so before the .catch() at the call site a rejection here was an unhandled
// rejection - fatal to the main process on Node >= 15, on exactly the machine
// with no Bluetooth adapter. registerIpc must survive it, and the rejection
// must not escape to the process.
test('registerIpc survives an adapter whose onPower rejects', async () => {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const backend = {
      adapter: {
        onPower: async () => { throw new Error('interface not found in proxy object'); },
        onDiscovered: () => () => {}, onPairingRequest: () => () => {},
      },
    };
    assert.doesNotThrow(() => captureHandlers(backend));
    // Two turns: enough for the rejection to be reported if nothing caught it.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('remediate resolves rather than rejecting when no handset is selected', async () => {
  const exec = async () => ({ stdout: '', stderr: '' });
  const r = await remediate('modem-online', { exec, mac: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /no handset selected/i);
  // null, not a thrown error: the caller still gets a well-formed failure
  // object, it just has no runnable command to offer.
  assert.strictEqual(r.command, null);
});

// --- device:forget --------------------------------------------------------
// Unpairs the handset from BlueZ AND clears Konnect's binding, then restarts
// into onboarding. It used to be binding-only; it now changes state outside
// Konnect, which is why a confirmation guards it.
test('device:forget confirms first, then routes to the forgetDevice callback', async () => {
  const calls = [];
  const shown = [];
  const handlers = captureHandlers({}, {
    forgetDevice: async () => { calls.push('forget'); return { relaunching: true }; },
  }, { showMessageBox: async (o) => { shown.push(o); return { response: 0 }; } });
  assert.deepStrictEqual(await handlers['device:forget'](), { relaunching: true });
  assert.deepStrictEqual(calls, ['forget']);
  // Cancel must be the default, so Return on a dialog nobody read does not
  // cost a passkey round trip on the handset.
  assert.strictEqual(shown[0].defaultId, 1);
  assert.strictEqual(shown[0].cancelId, 1);
  assert.match(shown[0].detail, /pair it again/i);
});

test('cancelling the confirmation forgets nothing', async () => {
  const calls = [];
  const handlers = captureHandlers({}, {
    forgetDevice: async () => { calls.push('forget'); return { relaunching: true }; },
  }, { showMessageBox: async () => ({ response: 1 }) });
  // relaunching:false is the shape Settings already reads as "re-enable the
  // button", so a cancel needs no new branch in the renderer.
  assert.deepStrictEqual(await handlers['device:forget'](), { relaunching: false });
  assert.deepStrictEqual(calls, [], 'a cancelled confirmation must not unpair anything');
});

test('device:forget refuses while a call is live, before it even asks', async () => {
  // The relaunch would drop the call and orphan its recording, so the guard
  // must fire BEFORE forgetDevice runs - and before the dialog, or the user
  // is asked a question whose answer is going to be ignored.
  const calls = [];
  const shown = [];
  const handlers = captureHandlers({}, {
    hasLiveCall: () => true,
    forgetDevice: async () => { calls.push('forget'); return { relaunching: true }; },
  }, { showMessageBox: async (o) => { shown.push(o); return { response: 0 }; } });
  // async wrapper is load-bearing: the handler throws SYNCHRONOUSLY (matching
  // the existing call:dial style), and assert.rejects propagates a sync throw
  // instead of treating it as the rejection under test.
  await assert.rejects(async () => handlers['device:forget'](), /call/i);
  assert.deepStrictEqual(calls, [], 'forgetDevice must not run while a call is live');
  assert.deepStrictEqual(shown, [], 'no dialog for a request that is already refused');
});

test('call:dial refuses a number that is not one, before reaching the backend', async () => {
  // The renderer filters the field as you type, but that is a convenience,
  // not a guarantee: this channel survives a renderer reload and is the point
  // every dial path in the app converges on. Letters must not reach oFono.
  const dialled = [];
  // Guard wired open on purpose: this test is about number validation, not the dial guard.
  const handlers = captureHandlers({ dial: async (n) => { dialled.push(n); } }, { canDial: () => true });
  await assert.rejects(async () => handlers['call:dial'](null, 'abcdef'), /dial/i);
  await assert.rejects(async () => handlers['call:dial'](null, '+91 98765 43210'), /dial/i);
  assert.deepStrictEqual(dialled, []);
  // The ordinary case still goes straight through, * and # included.
  await handlers['call:dial'](null, '+919876543210');
  await handlers['call:dial'](null, '*123#');
  assert.deepStrictEqual(dialled, ['+919876543210', '*123#']);
});
