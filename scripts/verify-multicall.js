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
