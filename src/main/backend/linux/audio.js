'use strict';
const { execFile, spawn } = require('node:child_process');
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

// Mic mute for a call lives HERE, not on the handset. In HFP the phone is the
// audio gateway and this PC is the headset, so the voice the caller hears is
// captured by the PC's source - and org.ofono.CallVolume.Muted, which would
// mute the gateway side, answers "Implementation not provided" on the JioPhone
// (verified against F120B: SpeakerVolume and MicrophoneVolume writes succeed,
// Muted does not). Muting the capture node is both the working control and the
// correct one.
//
// A falsy nodeName means Settings has pinned no source, so the call is going
// through whatever PipeWire calls default - wpctl names that directly.
// execFn/nodeIdFn are injection seams with real defaults, the same shape
// applyRouting and readPorts use in this file.
const DEFAULT_SOURCE = '@DEFAULT_AUDIO_SOURCE@';
async function micTarget(nodeName, nodeIdFn) {
  return nodeName ? String(await nodeIdFn(nodeName)) : DEFAULT_SOURCE;
}

// null, never false, when the level cannot be read: parseWpctlVolume's rule -
// a control that failed to read must not look like one reading "not muted".
async function getMicMute(nodeName, { execFn = execFileAsync, nodeIdFn = nodeIdFor } = {}) {
  const { stdout } = await execFn('wpctl', ['get-volume', await micTarget(nodeName, nodeIdFn)]);
  const v = parseWpctlVolume(stdout);
  return v ? v.muted : null;
}

async function setMicMute(nodeName, on, { execFn = execFileAsync, nodeIdFn = nodeIdFor } = {}) {
  await execFn('wpctl', ['set-mute', await micTarget(nodeName, nodeIdFn), on ? '1' : '0']);
}

let ringProc = null;
let ringWanted = false;

// A legitimate playthrough of the bundled tone lasts about five seconds; a
// missing or undecodable file exits in milliseconds. Anything that fails
// faster than this is treated as a failure rather than a loop iteration.
const MIN_RING_MS = 1000;

// pw-play exits at the end of the file, so looping means respawning. The
// ringWanted latch is what stops the exit handler from restarting a ring
// that stopRing() has already cancelled - without it, a hangup that lands
// between exit and respawn leaves the ringtone playing forever.
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
      // stopRing() already cancelled us - do not log a failure for a kill we
      // asked for, and do not respawn.
      if (!ringWanted) return;
      // A missing or undecodable tone makes pw-play exit almost immediately
      // with a non-zero code, and ONLY 'exit' fires - 'error' never does, so
      // the error handler below cannot catch this. Respawning regardless
      // spins a silent process storm for the whole ring duration: no sound,
      // no log, nothing the user can see. Verified against both a missing
      // path and a corrupt .ogg.
      if (code !== 0 && Date.now() - startedAt < MIN_RING_MS) {
        console.error(
          `[konnect] ringtone failed (pw-play exit ${code}); not ringing: ${tone}`);
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

// A source's output ports link straight to a sink's input ports. pw-loopback
// is deliberately not used - a loopback node is a second graph element to
// keep in sync, and it was what tangled the earlier routing attempt.
function fanOut(fromPorts, toPorts) {
  // Mono SCO into a stereo sink means one source port feeding both channels;
  // a stereo mic into mono SCO means only the first port is used. Indexing
  // the source modulo its length expresses both without a special case.
  return toPorts.map((to, i) => [fromPorts[i % fromPorts.length], to]);
}

// pw-link -l lists every link twice, once per endpoint block, so a stray pair
// reaches us twice. Unlinking it twice makes the second `pw-link -d` fail
// against an already-removed link, which the unlink tracking then reports as
// a route that could not be torn down - on a call that routed perfectly.
function dedupePairs(pairs) {
  const seen = new Set();
  return pairs.filter(([out, inp]) => {
    const key = `${out}|${inp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function planLinks({ sink, source, ports, links }) {
  const names = Object.keys(ports || {});
  const btIn = names.find((n) => n.startsWith('bluez_input.'));
  const btOut = names.find((n) => n.startsWith('bluez_output.'));

  // No SCO nodes means the call audio link is not up. Returning an empty plan
  // with fallback:false would read as "routed successfully" to every caller.
  if (!btIn && !btOut) {
    return {
      unlink: [], link: [], fallback: true, reason: 'call audio nodes are not present',
      remoteWanted: [], micWanted: [],
    };
  }

  const unlink = [];
  const link = [];
  const reasons = [];
  const existing = links || [];
  // The FULL desired pair set per leg, including pairs already present.
  // applyRouting uses this - not `link`, which deliberately omits anything
  // already correct - to decide whether a leg is actually routed. Without
  // it, a call routed to the already-default device reports as unrouted.
  let remoteWanted = [];
  let micWanted = [];

  const remoteOut = btIn ? (ports[btIn].out || []) : [];
  const sinkIn = ports[sink] ? (ports[sink].in || []) : [];
  if (remoteOut.length && sinkIn.length) {
    const wanted = fanOut(remoteOut, sinkIn);
    remoteWanted = wanted;
    const wantedSet = new Set(wanted.map(([o, i]) => `${o}|${i}`));
    for (const l of existing) {
      if (!remoteOut.includes(l.output)) continue;
      // recorder.js links this same bluez_input port into its own capture
      // node. That link is not part of our plan but it is not wrong either:
      // tearing it down silently kills the recording of a call already in
      // progress. With two calls up, call B's routing would otherwise
      // destroy call A's recording, leaving a file of the right length and
      // total silence.
      if (l.input.startsWith('konnect_rec_')) continue;
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
  } else {
    // btIn is either missing entirely or exists with no ports yet (the
    // instant applyRouting runs at call start, before SCO ports appear) -
    // both leave this leg unplannable, and both used to fall through here
    // silently, reporting fallback:false for a call the far end can't be
    // heard on.
    reasons.push('remote audio not ready');
  }

  const micOut = ports[source] ? (ports[source].out || []) : [];
  const btInPorts = btOut ? (ports[btOut].in || []) : [];
  if (micOut.length && btInPorts.length) {
    const wanted = fanOut(micOut, btInPorts);
    micWanted = wanted;
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
  } else {
    reasons.push('microphone link not ready');
  }

  return {
    unlink: dedupePairs(unlink), link: dedupePairs(link),
    fallback: reasons.length > 0,
    reason: reasons.length ? reasons.join('; ') : null,
    remoteWanted, micWanted,
  };
}

const { parsePwLink, isBenignLinkError } = require('./recorder');
const { createEmitter } = require('../interface');

const routingEmitter = createEmitter();

// `pw-link -i` and `-o` list input and output ports, one per line, as
// "<node.name>:<port>". Grouping them by node is what planLinks consumes.
// execFn is injectable so applyRouting's own derivation - not just planLinks
// - can be driven end to end in tests without spawning pw-link.
async function readPorts(execFn) {
  const ports = {};
  for (const [flag, side] of [['-i', 'in'], ['-o', 'out']]) {
    const { stdout } = await execFn('pw-link', [flag]).catch(() => ({ stdout: '' }));
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

async function applyRouting({ sink, source, execFn = execFileAsync }) {
  const [ports, linkText] = await Promise.all([
    readPorts(execFn),
    execFn('pw-link', ['-l']).then((r) => r.stdout).catch(() => ''),
  ]);
  const existingLinks = parsePwLink(linkText);
  const plan = planLinks({ sink, source, ports, links: existingLinks });

  // What is actually present on the graph, updated as unlinks/links succeed
  // or fail below. remoteLinked/micLinked are read off THIS, not off what we
  // executed - plan.link deliberately omits pairs WirePlumber already had
  // right, so a call already routed to the chosen device would otherwise
  // report as unrouted.
  const present = new Set(existingLinks.map((l) => `${l.output}|${l.input}`));

  // A failed unlink is not merely unlogged: the old route stays attached
  // alongside whatever we link next, so the call plays out of two devices at
  // once while the result still claims success.
  let unlinkFailed = false;
  for (const [out, inp] of plan.unlink) {
    try {
      await execFn('pw-link', ['-d', out, inp]);
      present.delete(`${out}|${inp}`);
    } catch (err) {
      unlinkFailed = true;
      console.error(`[konnect] failed to unlink ${out} -> ${inp}: ${err.message}`);
    }
  }

  for (const [out, inp] of plan.link) {
    try {
      await execFn('pw-link', [out, inp]);
      present.add(`${out}|${inp}`);
    } catch (err) {
      if (isBenignLinkError(err)) { present.add(`${out}|${inp}`); continue; }
      console.error(`[konnect] failed to link ${out} -> ${inp}: ${err.message}`);
    }
  }

  // A leg is satisfied when every pair it wants is present - whether we made
  // it or WirePlumber already had it right.
  const satisfied = (wanted) => wanted.length > 0 && wanted.every(([o, i]) => present.has(`${o}|${i}`));
  const remoteLinked = satisfied(plan.remoteWanted);
  const micLinked = satisfied(plan.micWanted);

  const reasons = plan.reason ? [plan.reason] : [];
  if (unlinkFailed) reasons.push('a previous route could not be removed and may still be active');

  const result = {
    remoteLinked, micLinked,
    fellBack: plan.fallback || unlinkFailed,
    reason: reasons.length ? reasons.join('; ') : null,
  };
  if (result.fellBack) console.warn(`[konnect] routing degraded: ${result.reason}`);
  routingEmitter.emit(result);
  return result;
}

function onRouting(cb) { return routingEmitter.on(cb); }

module.exports = {
  parseNodes, listAudioDevices, parseWpctlVolume, nodeIdFor, getPcVolume, setPcVolume,
  getMicMute, setMicMute,
  startRing, stopRing, planLinks, applyRouting, onRouting,
};
