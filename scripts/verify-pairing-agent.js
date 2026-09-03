'use strict';
// Throwaway probe for spec §5.2. Registers a pairing agent WITHOUT
// RequestDefaultAgent, then reports whether BlueZ would route to it.
// Does not pair anything: it registers, reports, and unregisters.
const dbus = require('dbus-next');
const { systemBus, getInterface } = require('../src/main/backend/linux/bus');

const BLUEZ = 'org.bluez';
const AGENT_PATH = '/konnect/pairing/agent/probe';

(async () => {
  const bus = systemBus();
  const { Interface } = dbus.interface;

  class ProbeAgent extends Interface {
    async RequestConfirmation(devicePath, passkey) {
      console.log('ROUTED TO US:', devicePath, passkey);
      throw new dbus.DBusError('org.bluez.Error.Rejected', 'probe only');
    }
    Release() {}
    Cancel() {}
  }
  ProbeAgent.configureMembers({
    methods: {
      RequestConfirmation: { inSignature: 'ou', outSignature: '' },
      Release: { inSignature: '', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  });

  const agent = new ProbeAgent(`${BLUEZ}.Agent1`);
  bus.export(AGENT_PATH, agent);

  const mgr = await getInterface(bus, BLUEZ, '/org/bluez', 'org.bluez.AgentManager1');
  try {
    await mgr.RegisterAgent(AGENT_PATH, 'KeyboardDisplay');
    console.log('RegisterAgent: OK (no RequestDefaultAgent called)');
  } catch (err) {
    console.log('RegisterAgent: FAILED —', err.message);
    console.log('=> spec §7.1 degraded path becomes primary');
    process.exit(0);
  }
  await mgr.UnregisterAgent(AGENT_PATH).catch(() => {});
  bus.unexport(AGENT_PATH, agent);
  console.log('UnregisterAgent: OK');
  process.exit(0);
})().catch((e) => { console.log('PROBE ERROR:', e.message); process.exit(1); });
