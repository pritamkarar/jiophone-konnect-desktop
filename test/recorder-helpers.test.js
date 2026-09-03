'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parsePwLink, findMicFeedingPhone, isBenignLinkError, recordingBasename,
} = require('../src/main/backend/linux/recorder');

// Real `pw-link -l` output captured during the phase 0 spike.
const SAMPLE = [
  'alsa_output.pci-0000_2d_00.4.analog-stereo:playback_FL',
  '  |<- bluez_input.44_CD_0E_AD_5E_34.0:output_FL',
  'alsa_output.pci-0000_2d_00.4.analog-stereo:playback_FR',
  '  |<- bluez_input.44_CD_0E_AD_5E_34.0:output_FR',
  'alsa_input.usb-Jieli_Technology_USB_Composite_Device-00.mono-fallback:capture_MONO',
  '  |-> bluez_output.44_CD_0E_AD_5E_34.1:input_MONO',
].join('\n');

test('parsePwLink extracts output to input pairs in both arrow directions', () => {
  const links = parsePwLink(SAMPLE);
  assert.ok(links.some((l) =>
    l.output === 'bluez_input.44_CD_0E_AD_5E_34.0:output_FL' &&
    l.input === 'alsa_output.pci-0000_2d_00.4.analog-stereo:playback_FL'));
  assert.ok(links.some((l) =>
    l.output === 'alsa_input.usb-Jieli_Technology_USB_Composite_Device-00.mono-fallback:capture_MONO' &&
    l.input === 'bluez_output.44_CD_0E_AD_5E_34.1:input_MONO'));
});

test('findMicFeedingPhone returns the source actually routed to the handset', () => {
  const mic = findMicFeedingPhone(parsePwLink(SAMPLE));
  assert.strictEqual(mic, 'alsa_input.usb-Jieli_Technology_USB_Composite_Device-00.mono-fallback:capture_MONO');
});

test('findMicFeedingPhone returns null when no call audio is routed', () => {
  assert.strictEqual(findMicFeedingPhone(parsePwLink('')), null);
  assert.strictEqual(
    findMicFeedingPhone(parsePwLink('foo:out\n  |-> bar:in')), null);
});

test('parsePwLink tolerates blank and malformed lines', () => {
  assert.deepStrictEqual(parsePwLink('\n\n   \n'), []);
  assert.deepStrictEqual(parsePwLink('no arrows here'), []);
});

test('isBenignLinkError treats "already linked" as benign, everything else as a real failure', () => {
  // Verbatim stderr observed from a real pw-link run on this machine, linking
  // two ports that were already linked to each other.
  assert.strictEqual(isBenignLinkError(new Error('failed to link ports: File exists')), true);
  assert.strictEqual(isBenignLinkError({ stderr: 'failed to link ports: File exists' }), true);
  assert.strictEqual(isBenignLinkError(new Error('already linked')), true);

  // Verbatim stderr observed linking to a port that does not exist - a real
  // failure that must NOT be swallowed as "already linked".
  assert.strictEqual(isBenignLinkError(new Error('failed to link ports: No such file or directory')), false);
  assert.strictEqual(isBenignLinkError({ stderr: 'Permission denied' }), false);
  assert.strictEqual(isBenignLinkError(new Error('')), false);
  assert.strictEqual(isBenignLinkError({}), false);
});

test('two sequential calls do not share a recording filename', () => {
  // oFono hands out the lowest free call index, so with one call at a time
  // every callId is .../voicecall01. A callId-only name was byte-identical
  // between calls: pw-record truncated the previous WAV and ffmpeg ran with
  // -y, so each recording destroyed the one before it while that call's log
  // row still pointed at the path and would play the wrong call's audio.
  const id = '/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34/voicecall01';
  assert.notStrictEqual(recordingBasename(id, 1000), recordingBasename(id, 2000));
});

test('a recording basename keeps the call identity and stays path-safe', () => {
  const name = recordingBasename('/hfp/org/bluez/hci0/dev_44_CD_0E_AD_5E_34/voicecall01', 1000);
  assert.match(name, /voicecall01$/);
  assert.ok(!name.includes('/') && !name.includes('\\') && !name.includes('..'));
});
