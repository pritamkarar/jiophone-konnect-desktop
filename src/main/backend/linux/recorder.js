'use strict';
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const execFileAsync = promisify(execFile);

// Opus encoding of a phone call is fast; this only exists so a wedged ffmpeg
// cannot hold the app open at shutdown.
const ENCODE_TIMEOUT_MS = 15000;

// `pw-link -l` prints a node port, then indented links with |-> or |<- arrows.
// |-> means "this port feeds that one"; |<- means the reverse.
function parsePwLink(text) {
  const links = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const arrow = line.match(/^\s+\|(->|<-)\s+(\S+)/);
    if (arrow) {
      if (!current) continue;
      if (arrow[1] === '->') links.push({ output: current, input: arrow[2] });
      else links.push({ output: arrow[2], input: current });
    } else if (/^\S/.test(line)) {
      current = line.trim();
    }
  }
  return links;
}

// The microphone the user is actually being heard through is whichever source
// WirePlumber linked into bluez_output. Guessing the default source instead
// records the wrong microphone whenever the default differs.
function findMicFeedingPhone(links) {
  const link = links.find((l) => l.input.startsWith('bluez_output.'));
  return link ? link.output : null;
}

// pw-link's own wording for "this link already exists" (observed verbatim:
// "failed to link ports: File exists") is the one link() failure that is not
// a real problem. Pure and exported so the discrimination is testable
// without spawning pw-link.
function isBenignLinkError(err) {
  return /exists|already/i.test(String(err?.stderr || err?.message || ''));
}

async function pwLinkList() {
  const { stdout } = await execFileAsync('pw-link', ['-l']);
  return parsePwLink(stdout);
}

async function findRemotePorts(links) {
  const ports = new Set();
  for (const l of links) {
    if (l.output.startsWith('bluez_input.')) ports.add(l.output);
  }
  return [...ports].sort();   // output_FL before output_FR
}

function sanitiseCallId(callId) {
  return String(callId).replace(/[^A-Za-z0-9]/g, '_').slice(-40);
}

// callId alone is NOT unique across calls: it is the oFono object path, and
// oFono allocates the call index with a lowest-free-id scheme, so one call at
// a time yields voicecall01 every single time. A callId-only filename meant
// each recording truncated the previous one while the older call's log row
// still pointed at that path, so it played the wrong call. The timestamp is
// what makes a recording name unique.
function recordingBasename(callId, now = Date.now()) {
  return `${now}-${sanitiseCallId(callId)}`;
}

function createRecorder({ outputDir = path.join(os.homedir(), 'Konnect', 'recordings') } = {}) {
  const active = new Map();   // callId -> { proc, wavPath, nodeName }
  // ffmpeg children belonging to a stop() still in flight. app.exit() halts the
  // event loop, so execFile's own timeout cannot fire once shutdown wins the
  // race - dispose() has to be able to reach these directly or they orphan.
  const encoding = new Set();

  // Reports whether the link actually attached. Swallowing failures here is
  // what makes an unlinked recorder indistinguishable from a working one: the
  // file is written, it is the right length, and it is silent. "Already
  // linked" is the one benign failure, and pw-link says so.
  async function link(a, b) {
    try {
      await execFileAsync('pw-link', [a, b]);
      return true;
    } catch (err) {
      return isBenignLinkError(err);
    }
  }

  // Poll for the recorder's ports instead of sleeping a fixed interval. Under
  // load the node may not exist yet, and linking to a port that is not there
  // fails silently, yielding a recording of nothing.
  async function waitForPorts(nodeName, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync('pw-link', ['-i']).catch(() => ({ stdout: '' }));
      if (stdout.includes(`${nodeName}:input_FL`)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  return {
    async start(callId) {
      if (active.has(callId)) return active.get(callId).wavPath;
      await fs.mkdir(outputDir, { recursive: true });

      const safe = sanitiseCallId(callId);
      const nodeName = `konnect_rec_${safe}`;
      // callId is the oFono object path, and oFono allocates the call index
      // with a lowest-free-id scheme (`%s/voicecall%02d`). One call at a time
      // means EVERY call is voicecall01, so a callId-only filename is the same
      // string every time: pw-record truncates the previous WAV and ffmpeg
      // runs with -y, so recording N destroyed recording N-1 while that older
      // call's log row still pointed at the path - it would play the wrong
      // call. The timestamp is what makes the name unique per recording.
      // nodeName needs to be unique only among CONCURRENT recorders, and
      // concurrent calls have distinct oFono indices, so it stays as is.
      const wavPath = path.join(outputDir, `${recordingBasename(callId)}.wav`);

      // --target 0 means "do not auto-link". Anything else silently attaches
      // to the default source and records the wrong audio (spec 7.2).
      const proc = spawn('pw-record', [
        '-P', `{ node.name = ${nodeName} }`,
        '--target', '0', '--channels', '2', wavPath,
      ], { stdio: 'ignore' });
      active.set(callId, { proc, wavPath, nodeName });

      if (!await waitForPorts(nodeName)) {
        proc.kill('SIGTERM');
        active.delete(callId);
        // pw-record writes the WAV header the moment it spawns, so a timeout
        // always leaves a file behind. Nothing will ever reference it - start()
        // returns null - and stop() cannot reach it once the active entry is
        // gone, so remove it here as the remote-link-failure path does.
        await fs.unlink(wavPath).catch(() => {});
        console.error(`[konnect] recorder ports never appeared for ${callId}; not recording`);
        return null;
      }

      const links = await pwLinkList();
      const remote = await findRemotePorts(links);
      const mic = findMicFeedingPhone(links);

      // Remote voice on the left, local voice on the right.
      const remoteLinked = remote[0] ? await link(remote[0], `${nodeName}:input_FL`) : false;
      const micLinked = mic ? await link(mic, `${nodeName}:input_FR`) : false;

      if (!remoteLinked) {
        // Without the far end there is nothing worth keeping - the file would
        // hold only the local mic, or silence, and would be indistinguishable
        // from a real recording. Fail loudly and claim nothing.
        proc.kill('SIGTERM');
        active.delete(callId);
        await fs.unlink(wavPath).catch(() => {});
        console.error(`[konnect] could not link remote audio for ${callId}; not recording`);
        return null;
      }
      if (!micLinked) {
        console.warn(`[konnect] no local microphone linked for ${callId}; recording the remote side only`);
      }

      return wavPath;
    },

    // Terminate any recorder still running. Without this a pw-record child
    // survives the parent's exit and keeps writing to a file nothing points at.
    dispose() {
      for (const [callId, entry] of active) {
        entry.proc.kill('SIGTERM');
        active.delete(callId);
      }
      for (const child of encoding) child.kill('SIGTERM');
      encoding.clear();
    },

    async stop(callId) {
      const entry = active.get(callId);
      if (!entry) return null;
      active.delete(callId);

      entry.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));

      const opusPath = entry.wavPath.replace(/\.wav$/, '.opus');
      // Bounded: this runs on the shutdown path, where an encode that never
      // returns would stall app.exit() and strand the very dispose() call
      // that could kill it. A timeout turns a hang into a kept WAV.
      const encode = execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', entry.wavPath, '-c:a', 'libopus', '-b:a', '24k', opusPath,
      ], { timeout: ENCODE_TIMEOUT_MS });
      if (encode.child) encoding.add(encode.child);
      try {
        await encode;
        await fs.unlink(entry.wavPath).catch(() => {});
        return opusPath;
      } catch {
        // Encoding failed: keep the raw capture rather than losing the call.
        return entry.wavPath;
      } finally {
        if (encode.child) encoding.delete(encode.child);
      }
    },
  };
}

module.exports = {
  parsePwLink, findMicFeedingPhone, isBenignLinkError, recordingBasename, createRecorder,
};
