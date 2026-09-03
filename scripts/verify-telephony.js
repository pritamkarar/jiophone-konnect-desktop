// Manual hardware check. Watches call events; optionally dials.
//   node scripts/verify-telephony.js            # watch only
//   node scripts/verify-telephony.js +919876543210
const { createLinuxBackend } = require('../src/main/backend/linux');

(async () => {
  const backend = createLinuxBackend();
  await backend.ensureOnline();
  console.log('status:', await backend.getStatus());

  backend.onCall((c) => console.log(
    `call ${c.state.padEnd(12)} dir=${c.direction} num=${c.number} start=${c.startedAt}`));

  const number = process.argv[2];
  if (number) {
    const id = await backend.dial(number);
    console.log('dialed, call id:', id);
    setTimeout(() => backend.hangup(id).catch(() => {}), 25000);
  } else {
    console.log('watching 90s - call the handset to see incoming events');
  }
  setTimeout(() => { backend.dispose(); process.exit(0); }, 95000);
})();
