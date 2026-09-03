'use strict';
const dbus = require('dbus-next');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sessionBus, unwrap, getInterface } = require('./bus');
const { createEmitter } = require('../interface');
const { parseVCards } = require('../../../shared/vcard');

const OBEX = 'org.bluez.obex';
const AGENT_PATH = '/konnect/obex/agent';
const VCARD_TYPES = new Set(['text/vcard', 'text/x-vcard', 'text/directory']);
const MAX_BYTES = 5 * 1024 * 1024;

// Trust boundary (spec 6.3). Incoming OBEX is device input: validate the
// sender, the content type, the size and the filename before touching disk.
function isAcceptableTransfer(transfer, { mac, maxBytes = MAX_BYTES } = {}) {
  const { name, type, size, destination } = transfer || {};

  if (!destination || destination.toUpperCase() !== String(mac).toUpperCase()) {
    return { ok: false, reason: 'push from an unexpected device' };
  }
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, reason: 'unsafe file name' };
  }
  // Transfer1.Size is D-Bus uint64, which dbus-next marshals as a native
  // BigInt (not a number) - typeof size === 'number' is false for every
  // real transfer, so a type-test here is dead code in production. Number()
  // on a BigInt is lossy only in the direction of "still enormous", so the
  // comparison still holds even for values that lose precision.
  if (size !== undefined && size !== null) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes > maxBytes) {
      return { ok: false, reason: `transfer size ${size} exceeds limit` };
    }
  }
  const declared = (type || '').toLowerCase();
  if (declared) {
    if (!VCARD_TYPES.has(declared)) return { ok: false, reason: `unsupported content type ${type}` };
  } else if (!/\.vcf$/i.test(name)) {
    return { ok: false, reason: 'unsupported content type (no vcf extension)' };
  }
  return { ok: true, reason: null };
}

function createOppReceiver({ mac, stagingDir = path.join(os.tmpdir(), 'konnect-import') }) {
  const emitter = createEmitter();
  let active = false;
  let agentRegistered = false;
  const seen = new Set();

  const { Interface } = dbus.interface;

  class KonnectAgent extends Interface {
    // obexd calls this before accepting a push. Returning a path accepts it;
    // throwing rejects it.
    async AuthorizePush(transferPath) {
      if (!active) throw new dbus.DBusError(`${OBEX}.Error.Rejected`, 'import not in progress');

      const bus = sessionBus();
      const props = await getInterface(bus, OBEX, transferPath, 'org.freedesktop.DBus.Properties');
      const t = unwrap(await props.GetAll('org.bluez.obex.Transfer1'));

      // The session object carries the peer address.
      const sessionPath = transferPath.replace(/\/transfer\d+$/, '');
      const sProps = await getInterface(bus, OBEX, sessionPath, 'org.freedesktop.DBus.Properties');
      const s = unwrap(await sProps.GetAll('org.bluez.obex.Session1'));

      // Session1.Source is OUR adapter's address, Session1.Destination is the
      // remote peer's - verified against bluez source (obexd/src/obex.c sets
      // os->src via getsockname and os->dst via getpeername; both server- and
      // client-side property getters expose them unconditionally under those
      // names). The peer we must match against `mac` is Destination. Using
      // Source here would compare our own PC's Bluetooth adapter address
      // against the handset's MAC and reject every real push.
      const verdict = isAcceptableTransfer(
        { name: t.Name, type: t.Type, size: t.Size, destination: s.Destination },
        { mac });
      if (!verdict.ok) {
        throw new dbus.DBusError(`${OBEX}.Error.Rejected`, verdict.reason);
      }

      await fs.mkdir(stagingDir, { recursive: true });
      const target = path.join(stagingDir, `${Date.now()}-${path.basename(t.Name)}`);
      // obexd does not begin writing until AuthorizePush returns, so the
      // PropertiesChanged listener must be attached before we return - await
      // it here rather than firing and forgetting, or a fast transfer can
      // complete during watchTransfer's own setup round trip and be missed
      // (and a setup failure would otherwise escape as an unhandled rejection
      // instead of failing this push).
      await watchTransfer(transferPath, target);
      return target;
    }

    Cancel() { /* obexd calls this if the peer aborts; nothing to undo */ }
  }

  KonnectAgent.configureMembers({
    methods: {
      AuthorizePush: { inSignature: 'o', outSignature: 's' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  });

  const agent = new KonnectAgent(`${OBEX}.Agent1`);

  async function watchTransfer(transferPath, target) {
    const bus = sessionBus();
    const props = await getInterface(bus, OBEX, transferPath, 'org.freedesktop.DBus.Properties');
    const onChanged = async (iface, changed) => {
      const c = unwrap(changed);
      // 'error' is a real terminal status (link drop, peer abort mid-transfer),
      // not just 'complete' - stop listening either way, or a failed transfer
      // leaks this listener and its staging file forever.
      if (c.Status !== 'complete' && c.Status !== 'error') return;
      props.off('PropertiesChanged', onChanged);
      if (c.Status === 'complete') {
        try {
          const text = await fs.readFile(target, 'utf8');
          const cards = parseVCards(text);
          const fresh = cards.filter((card) => !seen.has(card.uid));
          for (const card of fresh) seen.add(card.uid);
          if (fresh.length) emitter.emit(fresh);
        } catch (err) {
          console.error('failed to read pushed vcard:', err.message);
        }
      }
      await fs.unlink(target).catch(() => {});
    };
    props.on('PropertiesChanged', onChanged);
  }

  return {
    async start() {
      const bus = sessionBus();
      if (!agentRegistered) {
        bus.export(AGENT_PATH, agent);
        const mgr = await getInterface(bus, OBEX, '/org/bluez/obex', 'org.bluez.obex.AgentManager1');
        await mgr.RegisterAgent(AGENT_PATH);
        agentRegistered = true;
      }
      seen.clear();
      active = true;
    },

    async cancel() {
      active = false;
      if (!agentRegistered) return;
      try {
        const bus = sessionBus();
        const mgr = await getInterface(bus, OBEX, '/org/bluez/obex', 'org.bluez.obex.AgentManager1');
        await mgr.UnregisterAgent(AGENT_PATH);
        bus.unexport(AGENT_PATH, agent);
      } catch { /* already gone */ }
      agentRegistered = false;
    },

    onContacts(cb) { return emitter.on(cb); },
  };
}

module.exports = { isAcceptableTransfer, createOppReceiver };
