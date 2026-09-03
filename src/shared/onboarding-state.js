'use strict';

// Pure state machine for the 1a-1e onboarding flow (spec §6.2). No DOM, no
// IPC, no Electron - everything here is testable under `node --test`, which
// is the whole reason it lives in shared/ rather than in the renderer.

const INITIAL = Object.freeze({
  name: 'bt-off',
  adapter: { present: false, powered: false, reason: null },
  devices: [],
  // The row the user has highlighted. `target` is the one they committed to
  // with Connect - artboard 1c puts a step between the two, so a mis-click on
  // a neighbour's handset no longer starts a pairing.
  selected: null,
  target: null,
  passkey: null,
  error: null,
  checks: null,
  connected: false,
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
          ...state,
          adapter,
          name: 'bt-off',
          devices: [],
          selected: null,
          target: null,
          passkey: null,
          checks: null,
        };
      }
      // Already past scanning - a redundant "powered on" must not throw the
      // user back to the device list mid-pair.
      if (state.name !== 'bt-off') return { ...state, adapter };
      return { ...state, adapter, name: 'scanning', error: null };
    }

    case 'scan-device': {
      const devices = [...state.devices];
      const i = devices.findIndex((d) => d.mac === event.device.mac);
      if (i === -1) { devices.push(event.device); return { ...state, devices }; }
      // Replace IN PLACE, never filter-then-push: adapter.js keeps a Map so an
      // updated device holds its insertion position, and re-adding at the end
      // would throw that away and slide the row out from under the cursor.
      // The frozen rssi does the other half: rank.js orders on signal
      // strength, which moves on nearly every 1.5s tick, so a device keeps the
      // reading it was first RANKED with - ranked on first sight, then held
      // still. Nothing displays rssi, so a stale one costs nothing. `??`
      // rather than a plain keep: a device already known to BlueZ but not yet
      // seen in this discovery has no RSSI at all, and would otherwise be
      // pinned to the bottom of its group for the whole session.
      devices[i] = { ...event.device, rssi: devices[i].rssi ?? event.device.rssi };
      return { ...state, devices };
    }

    case 'scan-gone':
      return { ...state, devices: state.devices.filter((d) => d.mac !== event.mac) };

    // Highlight only. Nothing on the bus happens until `pick`.
    case 'select': {
      // Identity, so dispatch()'s no-op check drops a re-click on the row that
      // is already highlighted rather than rebuilding the list under the cursor.
      if (state.selected === event.mac) return state;
      if (!findDevice(state, event.mac)) return state;
      return { ...state, selected: event.mac, error: null };
    }

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

    // `connected` is what 1e's copy branches on. During blocking onboarding
    // the backend is the unbound one, whose connect() rejects by design and
    // whose modem does not exist until Konnect relaunches bound - the flow
    // deliberately does not connect, so the card must not claim it did.
    // Defaults true: every other caller does bring the link up.
    case 'connect-ok':
      return {
        ...state,
        name: 'connected',
        connected: event.connected !== false,
        checks: event.checks || [],
        error: null,
      };

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

// Whether first-run onboarding should open, and whether it blocks.
//
// Pure so the rule is testable without Electron, following pickBootstrapMac's
// shape in src/main/device-select.js: the caller supplies the device list.
//
// The rule this replaces asked only whether `device_mac` was set. A persisted
// mac outlives the device it names - unpair the handset, or take it out of
// range long enough for BlueZ to drop the object, and the setting still reads
// back fine. The app then booted to a dialer bound to a handset that was not
// there. So presence of the SETTING is not evidence of a usable handset;
// presence in the device list, still paired, is.
//
// Note this deliberately does NOT mirror pickBootstrapMac, which trusts a
// stored mac even when absent. That is right for backend binding - the app
// should keep pointing at your handset while it is merely switched off - and
// wrong for this decision, which is about whether to show the user a way to
// fix it.
//
// Blocking follows the prior spec's rule (2026-09-01 §4.2): a wall only when
// there is genuinely nothing to bind to. An unreadable device list counts as
// nothing paired - failing to read BlueZ is not evidence the handset is fine.
function decideOnboarding({ deviceMac, devices }) {
  const paired = Array.isArray(devices) ? devices.filter((d) => d && d.paired) : [];
  const stored = deviceMac ? paired.find((d) => d.mac === deviceMac) : null;
  if (stored) return { open: false, blocking: false };
  return { open: true, blocking: paired.length === 0 };
}

// Dual export: this module is required by tests under node and loaded as a
// plain <script> by the renderer, which has no require().
if (typeof module !== 'undefined' && module.exports) module.exports = { INITIAL, reduce, decideOnboarding };
if (typeof window !== 'undefined') { window.Onboarding = { INITIAL, reduce, decideOnboarding }; }
