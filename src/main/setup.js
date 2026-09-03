'use strict';
const os = require('node:os');
const path = require('node:path');
const { modemPathFor } = require('./backend/linux/bus');

const WIREPLUMBER_CONFIG_PATH = path.join(
  os.homedir(), '.config', 'wireplumber', 'bluetooth.lua.d', '51-konnect-hfp.lua');

const WIREPLUMBER_CONFIG_BODY = `-- Konnect: hand HFP signalling to oFono so the app gets a telephony D-Bus
-- API (dial/answer/hangup/call state) while PipeWire consumes the SCO fd for
-- audio. Without this, PipeWire's native backend owns RFCOMM channel 3 and
-- outside connections get EBUSY.
bluez_monitor.properties["bluez5.hfphsp-backend"] = "ofono"
bluez_monitor.properties["bluez5.roles"] =
  "[ hfp_hf hsp_hs a2dp_sink a2dp_source ]"
`;

// What the "Copy" button in the wizard hands the user. These must be real,
// runnable shell - spec 4.4 asks for "the exact command", and prose in a copy
// buffer is a dead end wearing a fallback's clothes. The WirePlumber one is
// derived from the config constants above so it cannot drift out of sync, and
// it preserves the load-bearing restart order from spec 4.2.
const WIREPLUMBER_MANUAL_COMMAND = [
  `mkdir -p "$(dirname ${WIREPLUMBER_CONFIG_PATH})"`,
  `cat > ${WIREPLUMBER_CONFIG_PATH} <<'KONNECT_EOF'`,
  WIREPLUMBER_CONFIG_BODY.trimEnd(),
  'KONNECT_EOF',
  'systemctl --user restart wireplumber',
  // pkexec, not sudo: the automated remedy uses pkexec, so a system with a
  // polkit rule for it but no sudoers entry - exactly the locked-down setup
  // this recovery flow targets - would fail this step by hand while the
  // automated path's mechanism would have worked.
  'pkexec systemctl restart ofono',
  'systemctl --user restart wireplumber',
].join('\n');

const modemManualCommand = (mac) =>
  `pkexec hciconfig hci0 class 0x240404 && \\\n  busctl --system call org.ofono ${modemPathFor(mac)} `
  + 'org.ofono.Modem SetProperty sv Powered b true';

async function ok(exec, cmd) {
  try {
    const { stdout } = await exec(cmd);
    return { ok: true, detail: (stdout || '').trim() };
  } catch (err) {
    return { ok: false, detail: (err && err.message) || 'command failed' };
  }
}

const CHECKS = [
  {
    id: 'ofono-installed',
    label: 'oFono is installed',
    remedy: 'pkexec apt install -y ofono',
    manualCommand: () => 'pkexec apt install -y ofono',
    async detect(exec) { return ok(exec, 'which ofonod'); },
  },
  {
    id: 'ofono-running',
    label: 'oFono service is running',
    remedy: 'pkexec systemctl enable --now ofono',
    manualCommand: () => 'pkexec systemctl enable --now ofono',
    async detect(exec) {
      const r = await ok(exec, 'systemctl is-active ofono');
      return { ok: r.ok && r.detail === 'active', detail: r.detail };
    },
  },
  {
    id: 'wireplumber-backend',
    label: 'PipeWire uses the oFono HFP backend',
    remedy: 'write ~/.config/wireplumber/bluetooth.lua.d/51-konnect-hfp.lua and restart',
    manualCommand: () => WIREPLUMBER_MANUAL_COMMAND,
    async detect(exec) {
      const r = await ok(exec, `grep -h hfphsp-backend ${WIREPLUMBER_CONFIG_PATH}`);
      return { ok: r.ok && r.detail.includes('ofono'), detail: r.detail };
    },
  },
  {
    id: 'modem-online',
    label: 'Handset HFP modem is online',
    remedy: 'connect the handset, then run the class bootstrap if it refuses',
    manualCommand: modemManualCommand,
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
  },
];

async function runChecks({ exec, mac }) {
  const out = [];
  for (const check of CHECKS) {
    const result = await check.detect(exec, mac);
    out.push({ id: check.id, label: check.label, ok: result.ok, detail: result.detail, remedy: check.remedy });
  }
  return out;
}

const REMEDIES = {
  async 'ofono-installed'({ exec }) {
    await exec('pkexec apt install -y ofono');
    return { ok: true, detail: 'installed' };
  },
  async 'ofono-running'({ exec }) {
    await exec('pkexec systemctl enable --now ofono');
    return { ok: true, detail: 'started' };
  },
  async 'wireplumber-backend'({ exec, writeFile }) {
    await writeFile(WIREPLUMBER_CONFIG_PATH, WIREPLUMBER_CONFIG_BODY);
    // Order is load-bearing (spec 4.2): wireplumber must release the HFP UUID
    // before ofono can claim it, and must restart again afterwards to attach
    // to the ofono backend. Wrong order leaves a modem that never powers on.
    await exec('systemctl --user restart wireplumber');
    await exec('pkexec systemctl restart ofono');
    await exec('systemctl --user restart wireplumber');
    return { ok: true, detail: 'configured and restarted' };
  },
  async 'modem-online'({ exec, mac }) {
    if (!mac) throw new Error('no handset selected');
    // One-time class bootstrap. The handset caches our hands-free role, so
    // bluetoothd reverting the class afterwards is harmless (spec 4.1).
    await exec('pkexec hciconfig hci0 class 0x240404');
    await exec(
      `busctl --system call org.ofono ${modemPathFor(mac)} org.ofono.Modem SetProperty sv Powered b true`);
    return { ok: true, detail: 'class bootstrapped and modem powered' };
  },
};

// pkexec's own exit codes (man pkexec): 126 when the user dismissed the
// authentication dialog, 127 when authorisation could not be obtained or
// pkexec itself is absent. Anything else is the wrapped command's own exit
// code. All three must surface the command so it can be run by hand - spec
// 4.4: setup must never be a dead end because a prompt was dismissed.
const ELEVATION_CANCELLED = 126;
const ELEVATION_UNAVAILABLE = 127;

function classifyFailure(err) {
  const code = err && typeof err.code === 'number' ? err.code : null;
  if (code === ELEVATION_CANCELLED) return 'cancelled';
  if (code === ELEVATION_UNAVAILABLE) return 'unavailable';
  return 'failed';
}

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

// Resolves {ok: true, detail} on success, or {ok: false, reason, detail,
// command} on failure - never rejects for a command failure, because the
// caller needs the command string to offer a manual fallback. An unknown id
// still throws: that is a programming error, not a user-recoverable state.
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
      // manualCommand, not remedy: remedy is the human-readable description
      // shown in the checks list; only manualCommand is runnable.
      command: safeManualCommand(check, deps.mac),
    };
  }
}

module.exports = {
  CHECKS, runChecks, remediate, WIREPLUMBER_CONFIG_PATH, WIREPLUMBER_CONFIG_BODY, classifyFailure,
};
