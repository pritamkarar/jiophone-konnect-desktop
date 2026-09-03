// Manual check. Start a call first, then run this while it is active:
//   node scripts/verify-recording.js
const { createRecorder } = require('../src/main/backend/linux/recorder');

(async () => {
  const rec = createRecorder({ outputDir: '/tmp/konnect-verify' });
  const wav = await rec.start('verify-1');
  console.log('recording to', wav, '- speak into both ends for 12s');
  await new Promise((r) => setTimeout(r, 12000));
  const out = await rec.stop('verify-1');
  console.log('final file:', out);
})();
