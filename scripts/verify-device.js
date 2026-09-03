// Manual hardware check. Run with the handset paired and connected:
//   node scripts/verify-device.js
const { createLinuxBackend } = require('../src/main/backend/linux');

(async () => {
  const backend = createLinuxBackend();
  console.log('devices:', await backend.listDevices());
  console.log('status :', await backend.getStatus());
  backend.onDeviceStatus((s) => console.log('change :', s));
  console.log('watching for 20s - toggle bluetooth on the handset to see events');
  setTimeout(() => { backend.dispose(); process.exit(0); }, 20000);
})();
