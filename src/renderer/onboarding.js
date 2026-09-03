'use strict';
/* global $, showManualStep, renderSettings */

// The 1a-1e onboarding flow (spec 2026-09-02 §6), replacing the four-step
// wizard. All the branching lives in the pure reducer in
// src/shared/onboarding-state.js; this file only turns state into DOM and
// turns IPC into events.
//
// Wrapped in an IIFE because every renderer script shares one global scope:
// names like `state`, `render` and `dispatch` would otherwise collide with
// app.js/settings.js the moment either grows one. Only the two entry points
// the rest of the renderer calls are published.
(() => {
  const { INITIAL, reduce, decideOnboarding } = window.Onboarding;
  const { rankDiscovered, signalLabel, signalBars } = window.Rank;

  // The unbound backend's sentinel (src/main/backend/linux/index.js). Electron
  // prefixes the message across `invoke`, hence includes() rather than ===.
  const NO_HANDSET = 'No handset selected';

  // Artboard 1a's status tile. Module constants, never interpolated - the same
  // static-svg-via-innerHTML idiom settings.js uses for its glyphs.
  const BT_GLYPH = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11"/></svg>';
  const CROSS_GLYPH = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  // Artboard 1c's device rows.
  const PHONE_GLYPH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 18h4"/></svg>';
  const CHECK_GLYPH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const TICK_GLYPH = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const PLUS_GLYPH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const MINUS_GLYPH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>';

  let state = INITIAL;
  let blocking = false;
  // The one gate that keeps a closed flow closed - see teardown().
  let isOpen = false;
  // Bumped at the top of every render(): an async tail that resolves after a
  // newer render started must not append to the superseded DOM.
  let renderToken = 0;
  let slowScan = false;
  let slowTimer = null;
  // The mac whose connect/verify tail is already in flight, so the repeated
  // renders that discovery events cause cannot start a second one.
  let connectingFor = null;
  let listenersBound = false;

  function dispatch(event) {
    // window.konnect.onAdapterChanged/onScanDevice/onPairingRequest are
    // ipcRenderer.on wrappers: they return nothing, so there is no
    // unsubscribe to call at teardown. Instead they are bound exactly once
    // (bindListeners) and every event - and every async tail - funnels
    // through here, where a closed flow drops it on the floor.
    if (!isOpen) return;
    const next = reduce(state, event);
    if (next === state) return;
    const was = state.name;
    state = next;
    if (state.name !== 'connecting') connectingFor = null;
    render();
    // Discovery runs only while the device list is on screen: BlueZ pairs and
    // connects far more reliably with the radio not scanning, and a scan left
    // running drains the handset battery (spec §8).
    if (state.name === 'scanning' && was !== 'scanning') beginScan();
    else if (state.name !== 'scanning' && was === 'scanning') stopScanning();
  }

  function openOnboarding({ blocking: isBlocking = false } = {}) {
    blocking = isBlocking;
    isOpen = true;
    // A reopen (Settings' "Change handset") starts clean: the previous run's
    // device list is stale and its scan was stopped at teardown, so resuming
    // that state would show a frozen list that never updates.
    state = INITIAL;
    connectingFor = null;
    slowScan = false;
    $('#wizard').hidden = false;
    // Spec §6.1: full-window only when the app is genuinely unusable. When a
    // handset was resolved at bootstrap the app works and this is a
    // suggestion, so hiding the shell behind it would be a lie.
    document.body.classList.toggle('onboarding-blocking', blocking);
    // Not render(): INITIAL is bt-off, and flashing "No Bluetooth adapter
    // found" before the adapter has been read would be a lie too.
    const box = $('#wizard-box');
    box.replaceChildren();
    const wait = document.createElement('p');
    wait.textContent = 'Checking Bluetooth…';
    box.append(wait);
    start().catch((err) => dispatch({
      type: 'adapter', present: false, powered: false, reason: err.message,
    }));
  }

  function closeOnboarding() {
    // Blocking means there is no handset at all; dismissing would leave an app
    // whose every action rejects with "No handset selected" and no way back.
    if (blocking) return;
    $('#wizard').hidden = true;
    document.body.classList.remove('onboarding-blocking');
    teardown();
  }

  function teardown() {
    // A pending RequestConfirmation must always be settled - the same rule the
    // pairing agent itself enforces. Closing mid-pair otherwise leaves BlueZ's
    // reply and the phone's own prompt hanging until they time out.
    if (state.name === 'pairing') window.konnect.confirmPairing(false).catch(() => {});
    isOpen = false;
    connectingFor = null;
    stopScanning();
    // The agent is a process-wide bus registration held only for this flow.
    // Keeping it past the last screen blocks the next application that wants
    // it for the rest of the session. beginScan() re-registers on reopen -
    // register() is idempotent either way.
    window.konnect.unregisterPairingAgent().catch(() => {});
  }

  function stopScanning() {
    clearTimeout(slowTimer);
    slowTimer = null;
    window.konnect.stopScan().catch(() => {});
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.konnect.onAdapterChanged((s) => dispatch({
      type: 'adapter', present: s.present !== false, powered: s.powered,
    }));
    window.konnect.onScanDevice((d) => dispatch(d.gone
      ? { type: 'scan-gone', mac: d.mac }
      : { type: 'scan-device', device: d }));
    window.konnect.onPairingRequest((r) => dispatch({ type: 'passkey', ...r }));
  }

  async function start() {
    // Before the first adapter read, so a device discovered the instant the
    // scan starts cannot land between startScan() and a later subscribe.
    bindListeners();
    const powered = await window.konnect.adapterPower();
    // powered === null means there is no adapter at all (spec §7).
    dispatch({
      type: 'adapter',
      present: powered !== null,
      powered: powered === true,
      reason: powered === null ? 'No Bluetooth adapter found' : null,
    });
    // Entering `scanning` is what starts discovery - see dispatch().
  }

  async function beginScan() {
    // Register the agent BEFORE scanning: a user who picks a device the instant
    // it appears must not race an unregistered agent. A false return is not an
    // error - it is spec §7.1's degraded mode. register() is idempotent, so
    // re-entering the list after a failed pair does not re-register.
    const ok = await window.konnect.registerPairingAgent().catch(() => false);
    if (!ok) dispatch({ type: 'agent-unavailable', reason: 'another application owns the pairing agent' });
    // Closed, or a device was picked, while the agent registration was in
    // flight: starting a scan now leaves the radio hot right through pairing,
    // because the transition that would have stopped it has already run.
    if (!isOpen || state.name !== 'scanning') return;

    slowScan = false;
    clearTimeout(slowTimer);
    // Spec §7: after 30s with nothing found, say so rather than spinning forever.
    slowTimer = setTimeout(() => { if (isOpen) { slowScan = true; render(); } }, 30000);

    await window.konnect.startScan().catch((err) => {
      dispatch({ type: 'connect-failed', reason: err.message });
    });
  }

  function render() {
    const token = ++renderToken;
    const box = $('#wizard-box');
    // Lets a single view carry its own styling (1a greys the handset art)
    // without this file naming a class per state.
    const wiz = $('#wizard');
    wiz.dataset.view = state.name;
    // Only renderScanning knows whether anything has turned up yet; clear it
    // here so a stale 'empty' cannot outlive the scan and keep the radar
    // rings sweeping behind, say, the pairing card.
    delete wiz.dataset.scan;
    box.replaceChildren();
    const views = {
      'bt-off': renderBtOff,
      scanning: renderScanning,
      pairing: renderPairing,
      connecting: renderConnecting,
      connected: renderConnected,
    };
    (views[state.name] || renderScanning)(box, token);
    // Blocking onboarding is deliberately a wall (spec §6.1). A dismissible
    // one must offer a way out from every state, or "Change handset" opens a
    // modal with no exit but finishing the flow.
    if (!blocking) {
      const close = document.createElement('button');
      close.className = 'link';
      close.textContent = 'Close';
      close.addEventListener('click', closeOnboarding);
      box.append(close);
    }
  }

  // The 64px tile every onboarding card opens with. `variant` picks the
  // artboard's treatment: 1a's rounded square with a red cross badge, 1b's
  // circle inside a spinner, or 1e's solid green tick.
  function onboardIcon(variant, glyph = BT_GLYPH) {
    const icon = document.createElement('div');
    icon.className = variant ? `onboard-icon ${variant}` : 'onboard-icon';
    icon.innerHTML = glyph;                 // module constant, never interpolated
    if (!variant) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.innerHTML = CROSS_GLYPH;
      icon.append(badge);
    }
    return icon;
  }

  // The heading-plus-copy pair the cards centre on, kept in one 10px stack.
  function onboardHead(box, title) {
    const head = document.createElement('div');
    head.className = 'onboard-head';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    head.append(h, p);
    box.append(head);
    return p;                               // the caller fills the copy
  }

  function onboardStatus(box, tone, text) {
    const status = document.createElement('div');
    status.className = 'onboard-status';
    const dot = document.createElement('span');
    dot.className = `dot ${tone}`;
    const label = document.createElement('span');
    label.textContent = text;
    status.append(dot, label);
    box.append(status);
  }

  function renderBtOff(box) {
    box.append(onboardIcon());
    const p = onboardHead(box, state.adapter.present
      ? 'Bluetooth is turned off'
      : 'No Bluetooth adapter found');
    p.textContent = state.adapter.present
      ? 'Konnect uses Bluetooth to reach your JioPhone. Turn it on to start looking for nearby devices.'
      : 'Konnect could not find a Bluetooth adapter on this computer.';
    if (state.adapter.reason) {
      const why = document.createElement('p');
      why.className = 'muted';
      why.textContent = state.adapter.reason;
      box.append(why);
    }
    const row = document.createElement('div');
    row.className = 'dial-actions onboard-actions';
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
        } catch (err) {
          on.disabled = false;
          dispatch({ type: 'adapter', present: true, powered: false, reason: err.message });
        }
      });
      row.append(on);
    }
    // Ruling R12: `adapter:changed` only ever comes from an adapter that
    // already exists, so plugging in a dongle produces no event at all. Without
    // this the no-adapter card can never recover. start() re-polls and
    // re-dispatches; bindListeners() inside it is idempotent.
    const again = document.createElement('button');
    again.textContent = 'Check again';
    again.addEventListener('click', () => {
      again.disabled = true;
      start().catch((err) => dispatch({
        type: 'adapter', present: false, powered: false, reason: err.message,
      }));
    });
    row.append(again);
    box.append(row);

    // Artboard 1a's footnote. It reports what the renderer actually knows -
    // there is no IPC that exposes the adapter's model name.
    onboardStatus(box, 'bad', state.adapter.present
      ? 'Bluetooth adapter \u00b7 Off'
      : 'Bluetooth adapter \u00b7 Not found');
  }

  function banner(box) {
    if (!state.error) return;
    const b = document.createElement('div');
    b.className = 'banner';
    b.textContent = state.error;      // device names are untrusted; never innerHTML
    box.append(b);
  }

  function deviceButton(d, selected) {
    const btn = document.createElement('button');
    btn.className = d === selected ? 'device-row selected' : 'device-row';
    // A row is a radio choice now, not a command - say so, since sighted users
    // read that off the tick and the accent border.
    btn.setAttribute('aria-pressed', String(d === selected));
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = PHONE_GLYPH;         // module constant, never interpolated
    const text = document.createElement('span');
    text.className = 'text';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.name;            // untrusted; never innerHTML
    const meta = document.createElement('span');
    meta.className = 'meta';
    // Paired beats signal: it is the difference between 1d and going straight
    // to the link, which is what the user actually wants to know.
    meta.textContent = `${d.mac} \u00b7 ${d.paired ? 'Paired' : signalLabel(d.rssi)}`;
    text.append(name, meta);
    const tick = document.createElement('span');
    tick.className = 'tick';
    if (d === selected) tick.innerHTML = CHECK_GLYPH;
    btn.append(icon, text, tick);
    btn.addEventListener('click', () => dispatch({ type: 'select', mac: d.mac }));
    return btn;
  }

  // 1c's quiet expander for everything that did not rank as a handset. Kept
  // selectable per spec §3.1: BlueZ fills in Class and Icon asynchronously, so
  // a real JioPhone can still be sitting in this group.
  function moreButton(count) {
    const btn = document.createElement('button');
    btn.className = 'device-more';
    btn.innerHTML = state.showAll ? MINUS_GLYPH : PLUS_GLYPH;
    btn.append(state.showAll
      ? 'Hide other Bluetooth devices'
      : `Show ${count} other Bluetooth device${count === 1 ? '' : 's'}`);
    btn.addEventListener('click', () => dispatch({ type: 'toggle-all' }));
    return btn;
  }

  function connectTo(d) {
    // `pick` routes on Paired at the moment of choosing (spec §6.2): an
    // already-paired device goes straight to `connecting`, where the link is
    // brought up; an unpaired one goes to `pairing` for the passkey below.
    dispatch({ type: 'pick', mac: d.mac });
    if (d.paired) return;
    // Spec §5.3: Pair() then Connect(), never the reverse. This resolves
    // once Paired=true, which is after the user confirms the passkey.
    // Guarded like the connecting tail below: a cancelled pair whose
    // rejection lands after the user has picked a second device would
    // otherwise clear that device's target, and the reducer would then drop
    // its passkey (it only accepts one while `pairing`).
    const mine = () => state.name === 'pairing' && state.target === d.mac;
    window.konnect.pairDevice(d.mac).then(
      () => { if (mine()) dispatch({ type: 'pair-ok' }); },
      (err) => { if (mine()) dispatch({ type: 'pair-failed', reason: err.message }); },
    );
  }

  function renderScanning(box) {
    banner(box);
    const { phones, others } = rankDiscovered(state.devices);
    const found = phones.length > 0;

    // Artboard 1b is the empty scan: radar rings behind the handset, a spinner
    // round the tile, skeleton rows where the results will land. Once a phone
    // turns up the card becomes 1c's list and none of that applies.
    if (!found) {
      $('#wizard').dataset.scan = 'empty';
      box.append(onboardIcon('scanning'));
    }

    const p = onboardHead(box, found
      ? `Found ${phones.length} JioPhone${phones.length === 1 ? '' : 's'}`
      : 'Looking for your JioPhone…');
    if (found) {
      p.textContent = 'Pick the one you want to connect.';
    } else if (slowScan) {
      p.textContent = 'Still looking — make sure the phone is discoverable.';
    } else {
      const where = document.createElement('b');
      where.textContent = 'Settings › Bluetooth';
      p.append('On the phone, open ', where,
        ' and make sure it is visible. Keep it within a few metres.');
    }

    if (state.degraded) {
      const d = document.createElement('p');
      d.className = 'muted';
      d.textContent = 'In-app pairing is unavailable because another application '
        + 'owns the Bluetooth pairing agent. Pair the phone in your system '
        + 'Bluetooth settings, then pick it below.';
      box.append(d);
    }

    if (!found) {
      const skeleton = document.createElement('div');
      skeleton.className = 'scan-skeleton';
      for (let i = 0; i < 2; i += 1) {
        const row = document.createElement('div');
        row.className = 'row';
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        const lines = document.createElement('div');
        lines.className = 'lines';
        lines.append(document.createElement('span'), document.createElement('span'));
        row.append(avatar, lines);
        skeleton.append(row);
      }
      box.append(skeleton);
    }

    // The highlight falls back to the strongest phone, so the card always has
    // something to connect to. That also covers a selected device going out of
    // range mid-scan: it hands the highlight back rather than leaving Connect
    // pointed at a mac that is no longer on the bus.
    const selected = [...phones, ...others].find((d) => d.mac === state.selected)
      || phones[0] || null;

    if (found || others.length) {
      const list = document.createElement('div');
      list.className = 'device-list';
      for (const d of phones) list.append(deviceButton(d, selected));
      if (others.length) {
        list.append(moreButton(others.length));
        if (state.showAll) for (const d of others) list.append(deviceButton(d, selected));
      }
      box.append(list);
    }

    const actions = document.createElement('div');
    actions.className = 'dial-actions onboard-actions';
    if (selected) {
      const connect = document.createElement('button');
      connect.className = 'primary';
      connect.textContent = `Connect to ${selected.name}`;   // untrusted; textContent
      connect.addEventListener('click', () => {
        connect.disabled = true;
        connectTo(selected);
      });
      actions.append(connect);
    }
    // Spec §6.3's `Scan again`. Not decoration: when StartDiscovery rejects,
    // adapter.js has already cleared its scan state, so nothing polls and
    // nothing retries - and in blocking mode there is no Close either, which
    // leaves a card with no controls at all until the app is killed. 1c shows
    // it beside Connect as well, where a stale list is the likelier problem.
    if (found || state.error || !state.devices.length) {
      const again = document.createElement('button');
      if (found) again.className = 'quiet';
      again.textContent = 'Scan again';
      again.addEventListener('click', () => { again.disabled = true; beginScan(); });
      actions.append(again);
    }
    if (actions.children.length) box.append(actions);

    // 1b's footnote. `others` is everything discovered that did not rank as a
    // phone, so the two counts together are the whole radio picture.
    if (!found) {
      const n = state.devices.length;
      onboardStatus(box, 'acc',
        `Scanning \u00b7 ${n} device${n === 1 ? '' : 's'} nearby, no JioPhones yet`);
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
      p.textContent = 'Waiting for the phone to respond…';
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
      window.konnect.confirmPairing(true).catch(() => {});
    });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      window.konnect.confirmPairing(false).catch(() => {});
      dispatch({ type: 'cancel' });
    });
    row.append(pair, cancel);
    box.append(row);
  }

  function renderConnecting(box) {
    const target = state.devices.find((d) => d.mac === state.target);
    const h = document.createElement('h2');
    h.textContent = `Connecting to ${target ? target.name : 'your phone'}…`;
    const spin = document.createElement('div');
    spin.className = 'scan-spinner';
    box.append(h, spin);

    // Fired once per ENTRY into this state, not once per render: a discovery
    // event re-renders the card, and re-running the connect on every one of
    // them would hammer the link. renderToken is the wrong guard here - it is
    // bumped by those same re-renders, which would make the tail below bail
    // every time and leave the spinner up forever - so this tail checks the
    // thing it actually cares about: that the flow is still connecting to the
    // same handset.
    if (connectingFor === state.target) return;
    connectingFor = state.target;
    const mac = state.target;
    const stale = () => !isOpen || state.name !== 'connecting' || state.target !== mac;

    (async () => {
      try {
        // Bringing the link up is what makes the oFono modem appear for
        // verifyLink to probe. The unbound backend that runs during blocking
        // onboarding has no connect at all and rejects with NO_HANDSET; the
        // link comes up after selectDevice() relaunches bound, so that one is
        // expected. Every other rejection - host is down, device vanished - is
        // a real failure and goes back to the list with its reason (spec §7).
        let linked = true;
        await window.konnect.connectDevice(mac).catch((err) => {
          if (!err.message.includes(NO_HANDSET)) throw err;
          linked = false;
        });
        if (stale()) return;
        // No connect means no modem to probe: verifyLink would report three
        // red checks for a link this path deliberately never made, and 1e
        // would print them under a "connected" heading. Skip straight to the
        // paired-and-ready card instead.
        if (!linked) { dispatch({ type: 'connect-ok', connected: false, checks: [] }); return; }
        const result = await window.konnect.verifyLink(mac);
        // Spec §6.4: verifyLink's results in full, then only the FAILING
        // setup checks, each carrying the id its Fix button needs.
        const checks = await window.konnect.runSetupChecks(mac).catch(() => []);
        if (stale()) return;
        dispatch({
          type: 'connect-ok',
          checks: [...(result.checks || []), ...checks.filter((c) => !c.ok)],
        });
      } catch (err) {
        if (stale()) return;
        dispatch({ type: 'connect-failed', reason: err.message });
      }
    })();
  }

  // 1e's three stat tiles. Only ever drawn against a live link: on first run
  // the backend is still unbound, getStatus() answers nothing but nulls, and
  // three dashes would say "broken" about a handset that is merely not bound
  // yet. Filled asynchronously - the card must not wait on D-Bus to paint.
  function statTiles(box, token) {
    const grid = document.createElement('div');
    grid.className = 'stat-tiles';
    const values = {};
    for (const label of ['Battery', 'Network', 'Profiles']) {
      const tile = document.createElement('div');
      const cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = label;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = '…';
      values[label] = val;
      tile.append(cap, val);
      grid.append(tile);
    }
    box.append(grid);

    // HFP is the one profile this app can actually prove: verifyLink asks
    // oFono whether the modem is up and carrying VoiceCallManager. Contacts
    // come over OPP, not PBAP, so the artboard's "PBAP" would be a fiction.
    const hfp = (state.checks || []).every((c) => c.ok) ? 'HFP' : '\u2014';
    values.Profiles.textContent = hfp;

    window.konnect.getStatus().then((st) => {
      if (token !== renderToken) return;
      values.Battery.textContent = typeof st.battery === 'number' ? `${st.battery}%` : '\u2014';
      const bars = signalBars(st.signal);
      values.Network.textContent = st.operator
        ? `${st.operator}${bars ? ` ${bars}` : ''}`
        : '\u2014';
    }).catch(() => {
      if (token !== renderToken) return;
      values.Battery.textContent = '\u2014';
      values.Network.textContent = '\u2014';
    });
  }

  function renderConnected(box, token) {
    const target = state.devices.find((d) => d.mac === state.target);
    const name = target ? target.name : 'your phone';
    box.append(onboardIcon('ok', TICK_GLYPH));
    // Two different truths. state.connected means the link is up and the
    // checks below were measured against a live modem. Otherwise this is
    // first-run onboarding, where the backend is unbound and connecting was
    // deliberately skipped - the phone is paired and ready, and Open dialer
    // is what actually brings it up (via selectDevice's relaunch). Claiming
    // a connection here is the one thing this card must not do.
    const p = onboardHead(box, state.connected
      ? `${target ? target.name : 'Your phone'} is connected`
      : `Paired with ${name}`);
    p.textContent = state.connected
      ? 'Calls, contacts and call history will now flow through this desktop. '
        + 'Audio plays on your default speakers and microphone.'
      : `Konnect will connect to ${name} when it restarts with this handset. `
        + 'Open the dialer to finish.';

    if (state.connected) statTiles(box, token);

    // Artboard 1e is a success card, not a diagnostics panel: the tick and the
    // tiles carry what a row of green ticks used to. Failures still get a row
    // each - they are the only ones with something to do about them.
    const ul = document.createElement('ul');
    for (const c of (state.checks || []).filter((chk) => !chk.ok)) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `dot ${c.ok ? 'ok' : 'bad'}`;
      const label = document.createElement('span');
      label.textContent = c.detail ? `${c.label} — ${c.detail}` : c.label;
      li.append(dot, label);
      if (!c.ok && c.id) {
        const fix = document.createElement('button');
        fix.className = 'primary';
        fix.textContent = 'Fix';
        fix.addEventListener('click', async () => {
          fix.disabled = true;
          const res = await window.konnect.remediate(c.id, state.target).catch(
            (e) => ({ ok: false, reason: 'failed', detail: e.message, command: null }));
          if (res.ok) {
            // NOT `cancel`: that means "back to the device list", which would
            // throw away the target and make the user re-find their handset to
            // get Open dialer back. `pair-ok` re-enters `connecting` for the
            // same target, which re-runs connect-then-verify and lands back
            // here with fresh checks. connectingFor has to be released first
            // or renderConnecting treats the run as already in flight.
            connectingFor = null;
            dispatch({ type: 'pair-ok' });
            return;
          }
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
    if (ul.children.length) box.append(ul);

    const actions = document.createElement('div');
    actions.className = 'dial-actions onboard-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'primary';
    openBtn.textContent = 'Open dialer';
    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      let res;
      try {
        res = await window.konnect.selectDevice(state.target);
      } catch (err) {
        // Never leave the button permanently disabled with nothing shown for
        // why. The token guard is what stops this message being appended to a
        // card a newer render has already rebuilt.
        if (token !== renderToken) return;
        openBtn.disabled = false;
        const e = document.createElement('p');
        e.className = 'muted finish-error';
        e.textContent = `Could not select this handset: ${err.message}`;
        box.append(e);
        return;
      }
      if (token !== renderToken) return;
      if (res.relaunching) {
        box.replaceChildren();
        const msg = document.createElement('p');
        msg.textContent = 'Starting Konnect with your JioPhone…';
        box.append(msg);
        return;
      }
      blocking = false;
      closeOnboarding();
      renderSettings();
    });
    actions.append(openBtn);
    box.append(actions);
  }

  window.openOnboarding = openOnboarding;
  window.closeOnboarding = closeOnboarding;

  // Decided from the DEVICE LIST, not from whether device_mac happens to be
  // set. A persisted mac outlives the device it names: unpair the handset, or
  // let it drop off the bus, and the setting still reads back fine while the
  // device is gone. The old check returned early on that setting alone, so the
  // app booted to a dialer bound to a handset that was not there, with no way
  // to reach onboarding and re-pair it. decideOnboarding() owns the rule and
  // is tested; blocking still follows spec §4.2 - a wall only when there is
  // genuinely nothing to bind to.
  (async () => {
    const [deviceMac, devices] = await Promise.all([
      window.konnect.getSetting('device_mac').catch(() => null),
      window.konnect.listDevices().catch(() => null),
    ]);
    const { open, blocking } = decideOnboarding({ deviceMac, devices });
    if (open) openOnboarding({ blocking });
  })();
})();
