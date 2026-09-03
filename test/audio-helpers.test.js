const test = require('node:test');
const assert = require('node:assert');
const { parseNodes, parseWpctlVolume, getMicMute, setMicMute } = require('../src/main/backend/linux/audio');
const dump = require('./fixtures/pw-dump.json');

test('parseNodes finds sinks and sources in a real pw-dump', () => {
  const nodes = parseNodes(dump);
  assert.ok(nodes.length > 0, 'expected at least one audio node');
  assert.ok(nodes.some((n) => n.mediaClass === 'Audio/Sink'), 'expected a sink');
  assert.ok(nodes.some((n) => n.mediaClass === 'Audio/Source'), 'expected a source');
  for (const n of nodes) {
    assert.strictEqual(typeof n.id, 'number');
    assert.strictEqual(typeof n.name, 'string');
    assert.ok(n.name.length > 0);
    assert.strictEqual(typeof n.description, 'string');
  }
});

test('parseNodes ignores non-node objects and non-audio nodes', () => {
  const nodes = parseNodes([
    { id: 1, type: 'PipeWire:Interface:Port', info: { props: {} } },
    { id: 2, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Video/Source', 'node.name': 'cam' } } },
    { id: 3, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'ok' } } },
  ]);
  assert.deepStrictEqual(nodes.map((n) => n.id), [3]);
});

test('parseNodes falls back to node.name when there is no description', () => {
  const [n] = parseNodes([
    { id: 7, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Source', 'node.name': 'bare' } } },
  ]);
  assert.strictEqual(n.description, 'bare');
});

test('parseNodes survives malformed entries without throwing', () => {
  assert.deepStrictEqual(parseNodes([null, {}, { info: null }, 'nonsense']), []);
  assert.deepStrictEqual(parseNodes(null), []);
});

test('parseWpctlVolume reads a plain volume line as a percentage', () => {
  assert.deepStrictEqual(parseWpctlVolume('Volume: 0.46\n'), { pct: 46, muted: false });
});

test('parseWpctlVolume detects the muted marker', () => {
  assert.deepStrictEqual(parseWpctlVolume('Volume: 0.62 [MUTED]\n'), { pct: 62, muted: true });
});

test('parseWpctlVolume handles a volume above 1.0 without clamping the reading', () => {
  assert.strictEqual(parseWpctlVolume('Volume: 1.40').pct, 140);
});

test('parseWpctlVolume returns null on unexpected output rather than guessing', () => {
  assert.strictEqual(parseWpctlVolume(''), null);
  assert.strictEqual(parseWpctlVolume('Node 51 not found'), null);
  assert.strictEqual(parseWpctlVolume(null), null);
});

const { planLinks, applyRouting } = require('../src/main/backend/linux/audio');

const BT_IN = 'bluez_input.44_CD_0E_AD_5E_34';    // remote voice (a source)
const BT_OUT = 'bluez_output.44_CD_0E_AD_5E_34';  // what the caller hears (a sink)
const SINK = 'alsa_output.usb-HyperX.analog-stereo';
const SRC = 'alsa_input.usb-HyperX.mono-fallback';

const PORTS = {
  [BT_IN]: { out: [`${BT_IN}:output_MONO`], in: [] },
  [BT_OUT]: { out: [], in: [`${BT_OUT}:playback_MONO`] },
  [SINK]: { out: [], in: [`${SINK}:playback_FL`, `${SINK}:playback_FR`] },
  [SRC]: { out: [`${SRC}:capture_MONO`], in: [] },
};

test('a mono SCO stream fans out to both channels of a stereo sink', () => {
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links: [] });
  assert.deepStrictEqual(plan.link, [
    [`${BT_IN}:output_MONO`, `${SINK}:playback_FL`],
    [`${BT_IN}:output_MONO`, `${SINK}:playback_FR`],
    [`${SRC}:capture_MONO`, `${BT_OUT}:playback_MONO`],
  ]);
  assert.strictEqual(plan.fallback, false);
});

test('WirePlumber links to a different device are torn down first', () => {
  const OTHER = 'alsa_output.pci-0000_2d_00.4.analog-stereo';
  const links = [
    { output: `${BT_IN}:output_MONO`, input: `${OTHER}:playback_FL` },
    { output: `${OTHER}_mic:capture_MONO`, input: `${BT_OUT}:playback_MONO` },
  ];
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.deepStrictEqual(plan.unlink, [
    [`${BT_IN}:output_MONO`, `${OTHER}:playback_FL`],
    [`${OTHER}_mic:capture_MONO`, `${BT_OUT}:playback_MONO`],
  ]);
});

test('a link that is already correct is neither unlinked nor relinked', () => {
  const links = [{ output: `${BT_IN}:output_MONO`, input: `${SINK}:playback_FL` }];
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.ok(!plan.unlink.some(([, i]) => i === `${SINK}:playback_FL`));
  assert.ok(!plan.link.some(([, i]) => i === `${SINK}:playback_FL`));
});

test('a missing output device falls back without unlinking anything on that leg', () => {
  const links = [{ output: `${BT_IN}:output_MONO`, input: 'alsa_output.other:playback_FL' }];
  const plan = planLinks({ sink: 'alsa_output.unplugged', source: SRC, ports: PORTS, links });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /output device/i);
  assert.deepStrictEqual(plan.unlink, []);
  // The microphone leg is independent and still routed.
  assert.deepStrictEqual(plan.link, [[`${SRC}:capture_MONO`, `${BT_OUT}:playback_MONO`]]);
});

test('a missing microphone falls back on that leg only', () => {
  const plan = planLinks({ sink: SINK, source: 'alsa_input.gone', ports: PORTS, links: [] });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /microphone/i);
  assert.strictEqual(plan.link.length, 2);
});

test('no SCO nodes means no plan at all - never an empty success', () => {
  const plan = planLinks({ sink: SINK, source: SRC, ports: { [SINK]: PORTS[SINK] }, links: [] });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /call audio/i);
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.unlink, []);
});

// applyRouting derives remoteLinked/micLinked from `present`, which starts as
// the existing links and is updated by what actually succeeds below - never
// from plan.link alone, which omits pairs already correct. These tests pin
// plan.remoteWanted/micWanted against that exact derivation so a regression
// here is caught without spawning pw-link.
function satisfied(wanted, presentPairs) {
  const present = new Set(presentPairs.map(([o, i]) => `${o}|${i}`));
  return wanted.length > 0 && wanted.every(([o, i]) => present.has(`${o}|${i}`));
}

test('a call already routed to the chosen devices reports both legs linked, not unrouted', () => {
  const links = [
    { output: `${BT_IN}:output_MONO`, input: `${SINK}:playback_FL` },
    { output: `${BT_IN}:output_MONO`, input: `${SINK}:playback_FR` },
    { output: `${SRC}:capture_MONO`, input: `${BT_OUT}:playback_MONO` },
  ];
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.unlink, []);
  assert.strictEqual(plan.fallback, false);
  // Nothing was executed (plan.link is empty), so `present` here is just the
  // existing links - exactly what applyRouting would see with an empty exec
  // loop. This is the assertion that would have caught reading remoteLinked/
  // micLinked off plan.link alone.
  const executed = links.map((l) => [l.output, l.input]);
  assert.strictEqual(satisfied(plan.remoteWanted, executed), true);
  assert.strictEqual(satisfied(plan.micWanted, executed), true);
});

test('a link into the recorder is left alone, not torn down as if it were stray WirePlumber routing', () => {
  const links = [{ output: `${BT_IN}:output_MONO`, input: 'konnect_rec_1700000000_voicecall01:input_FL' }];
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.ok(!plan.unlink.some(([, i]) => i === 'konnect_rec_1700000000_voicecall01:input_FL'));
  // The recorder's link does not satisfy our own plan either, so the real
  // routing to the chosen sink still gets planned alongside it.
  assert.deepStrictEqual(plan.link, [
    [`${BT_IN}:output_MONO`, `${SINK}:playback_FL`],
    [`${BT_IN}:output_MONO`, `${SINK}:playback_FR`],
    [`${SRC}:capture_MONO`, `${BT_OUT}:playback_MONO`],
  ]);
});

test('both bluez nodes present with zero ports falls back rather than reporting an empty success', () => {
  const ports = {
    [BT_IN]: { out: [], in: [] },
    [BT_OUT]: { out: [], in: [] },
    [SINK]: PORTS[SINK],
    [SRC]: PORTS[SRC],
  };
  const plan = planLinks({ sink: SINK, source: SRC, ports, links: [] });
  assert.strictEqual(plan.fallback, true);
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.unlink, []);
  assert.deepStrictEqual(plan.remoteWanted, []);
  assert.deepStrictEqual(plan.micWanted, []);
});

test('only one bluez node present falls back naming the missing leg, and still plans the routable one', () => {
  const ports = { [BT_OUT]: PORTS[BT_OUT], [SINK]: PORTS[SINK], [SRC]: PORTS[SRC] };
  const plan = planLinks({ sink: SINK, source: SRC, ports, links: [] });
  assert.strictEqual(plan.fallback, true);
  assert.match(plan.reason, /remote/i);
  assert.deepStrictEqual(plan.link, [[`${SRC}:capture_MONO`, `${BT_OUT}:playback_MONO`]]);
});

test('planLinks handles the real duplicate-listing shape of pw-link -l without double-acting', () => {
  const { parsePwLink } = require('../src/main/backend/linux/recorder');
  // Real `pw-link -l` lists every link twice, once from each endpoint's own
  // block - not once, the way a hand-built fixture would be tempted to write it.
  const text = [
    `${BT_IN}:output_MONO`,
    `  |-> ${SINK}:playback_FL`,
    `  |-> ${SINK}:playback_FR`,
    `${SINK}:playback_FL`,
    `  |<- ${BT_IN}:output_MONO`,
    `${SINK}:playback_FR`,
    `  |<- ${BT_IN}:output_MONO`,
    `${SRC}:capture_MONO`,
    `  |-> ${BT_OUT}:playback_MONO`,
    `${BT_OUT}:playback_MONO`,
    `  |<- ${SRC}:capture_MONO`,
  ].join('\n');
  const links = parsePwLink(text);
  assert.strictEqual(links.length, 6);   // 3 logical links, each listed from both ends
  const plan = planLinks({ sink: SINK, source: SRC, ports: PORTS, links });
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.unlink, []);
  assert.strictEqual(plan.fallback, false);
});

// applyRouting end to end, against a fake execFn - covers its OWN derivation
// (present-set tracking, dedup at exec time, failure handling), not just
// planLinks's pure output. Both regressions in the previous round lived here,
// not in planLinks, which is exactly why a planLinks-only test missed them.
const INPUT_PORTS_TEXT = [`${SINK}:playback_FL`, `${SINK}:playback_FR`, `${BT_OUT}:playback_MONO`].join('\n');
const OUTPUT_PORTS_TEXT = [`${BT_IN}:output_MONO`, `${SRC}:capture_MONO`].join('\n');

// Mimics execFileAsync('pw-link', args): resolves {stdout} or rejects with an
// Error carrying .message, same shape isBenignLinkError/callers expect.
function fakeExec({ linkText = '', failLink, failUnlink }) {
  const calls = [];
  const execFn = async (cmd, args) => {
    calls.push(args);
    if (args[0] === '-i') return { stdout: INPUT_PORTS_TEXT };
    if (args[0] === '-o') return { stdout: OUTPUT_PORTS_TEXT };
    if (args[0] === '-l') return { stdout: linkText };
    if (args[0] === '-d') {
      const [, out, inp] = args;
      if (failUnlink && failUnlink(out, inp)) {
        throw new Error('failed to unlink ports: No such link');
      }
      return { stdout: '' };
    }
    const [out, inp] = args;
    if (failLink && failLink(out, inp)) {
      throw new Error('failed to link ports: No such file or directory');
    }
    return { stdout: '' };
  };
  // A mutating call is an unlink (-d) or a link (two bare port names) - never
  // a -i/-o/-l read.
  const mutations = () => calls.filter((a) => a[0] === '-d' || !a[0].startsWith('-'));
  return { execFn, mutations };
}

const ALREADY_ROUTED_LINK_TEXT = [
  `${BT_IN}:output_MONO`,
  `  |-> ${SINK}:playback_FL`,
  `  |-> ${SINK}:playback_FR`,
  `${SINK}:playback_FL`,
  `  |<- ${BT_IN}:output_MONO`,
  `${SINK}:playback_FR`,
  `  |<- ${BT_IN}:output_MONO`,
  `${SRC}:capture_MONO`,
  `  |-> ${BT_OUT}:playback_MONO`,
  `${BT_OUT}:playback_MONO`,
  `  |<- ${SRC}:capture_MONO`,
].join('\n');

test('applyRouting: an already-fully-routed graph reports both legs linked and touches nothing', async () => {
  const { execFn, mutations } = fakeExec({ linkText: ALREADY_ROUTED_LINK_TEXT });
  const result = await applyRouting({ sink: SINK, source: SRC, execFn });
  assert.deepStrictEqual(result, { remoteLinked: true, micLinked: true, fellBack: false, reason: null });
  assert.strictEqual(mutations().length, 0);
});

const OTHER = 'alsa_output.pci-0000_2d_00.4.analog-stereo';
// One stray link, listed TWICE - the real duplicate shape of pw-link -l -
// feeding call audio to a device that is not the chosen one.
const NEEDS_REROUTE_LINK_TEXT = [
  `${BT_IN}:output_MONO`,
  `  |-> ${OTHER}:playback_FL`,
  `${OTHER}:playback_FL`,
  `  |<- ${BT_IN}:output_MONO`,
].join('\n');

test('applyRouting: a reroute built from duplicated pw-link -l output unlinks the stray pair exactly once', async () => {
  const { execFn, mutations } = fakeExec({ linkText: NEEDS_REROUTE_LINK_TEXT });
  const result = await applyRouting({ sink: SINK, source: SRC, execFn });
  assert.strictEqual(result.fellBack, false);
  assert.strictEqual(result.remoteLinked, true);
  assert.strictEqual(result.micLinked, true);
  const unlinks = mutations().filter((a) => a[0] === '-d');
  assert.strictEqual(unlinks.length, 1);
  assert.deepStrictEqual(unlinks[0], ['-d', `${BT_IN}:output_MONO`, `${OTHER}:playback_FL`]);
});

// Why the caller must not route when both pickers are on "System default".
// There is no mode setting any more - naming a device IS the opt-in - so the
// backend skips routing when neither is named. This pins what it is skipping:
// with nothing to link to, applyRouting reports BOTH legs unlinked, which
// onRouting renders as a red "call audio could not be routed" banner. Routing
// unconditionally would show that warning on every call of a user who never
// chose a device at all.
test('applyRouting: with no devices chosen there is nothing to link, and it reports failure', async () => {
  const { execFn, mutations } = fakeExec({ linkText: '' });
  const result = await applyRouting({ sink: null, source: null, execFn });
  assert.strictEqual(result.remoteLinked, false);
  assert.strictEqual(result.micLinked, false);
  assert.strictEqual(mutations().length, 0);
});

test('applyRouting: a genuine link failure clears only the leg that failed', async () => {
  const { execFn } = fakeExec({
    linkText: '',
    failLink: (out) => out === `${SRC}:capture_MONO`,   // mic leg fails to attach
  });
  const result = await applyRouting({ sink: SINK, source: SRC, execFn });
  assert.strictEqual(result.remoteLinked, true);
  assert.strictEqual(result.micLinked, false);
});

test('applyRouting: a genuine unlink failure falls back and says so, without losing the new route', async () => {
  const { execFn } = fakeExec({
    linkText: NEEDS_REROUTE_LINK_TEXT,
    failUnlink: () => true,
  });
  const result = await applyRouting({ sink: SINK, source: SRC, execFn });
  assert.strictEqual(result.fellBack, true);
  assert.match(result.reason, /previous route/i);
  // The stray unlink failed, but the new links to the chosen sink still went
  // out and still attached.
  assert.strictEqual(result.remoteLinked, true);
});

// ---- mic mute -----------------------------------------------------------
// The call's microphone is this PC's capture node, not the handset's: HFP
// makes the phone the audio gateway and the PC the headset, and the handset's
// own org.ofono.CallVolume.Muted answers "Implementation not provided".

test('setMicMute addresses a pinned source by its wpctl id', async () => {
  const calls = [];
  await setMicMute('alsa_input.usb-Blue_Yeti', true, {
    execFn: (...a) => { calls.push(a); return Promise.resolve({ stdout: '' }); },
    nodeIdFn: async () => 57,
  });
  assert.deepStrictEqual(calls, [['wpctl', ['set-mute', '57', '1']]]);
});

test('setMicMute falls back to the default source when none is pinned', async () => {
  const calls = [];
  const nope = () => { throw new Error('must not resolve a node id'); };
  await setMicMute('', false, {
    execFn: (...a) => { calls.push(a); return Promise.resolve({ stdout: '' }); },
    nodeIdFn: nope,
  });
  assert.deepStrictEqual(calls, [['wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', '0']]]);
});

test('getMicMute reports the muted marker, and null when wpctl says nothing it knows', async () => {
  const read = (stdout) => getMicMute(null, {
    execFn: async () => ({ stdout }),
    nodeIdFn: async () => 1,
  });
  assert.strictEqual(await read('Volume: 0.62 [MUTED]\n'), true);
  assert.strictEqual(await read('Volume: 0.62\n'), false);
  // Unreadable must not read as "not muted" - the button disables on null.
  assert.strictEqual(await read('Node 51 not found\n'), null);
});
