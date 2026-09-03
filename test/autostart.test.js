const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'konnect-autostart-'));
process.env.HOME = tmpHome;
process.env.XDG_CONFIG_HOME = path.join(tmpHome, '.config');

const { desktopEntry, isEnabled, enable, disable, AUTOSTART_PATH } = require('../src/main/autostart');

test('the desktop entry is a valid autostart file that starts hidden', () => {
  const body = desktopEntry({ execPath: '/opt/konnect/konnect', args: ['--hidden'] });
  assert.match(body, /^\[Desktop Entry\]$/m);
  assert.match(body, /^Type=Application$/m);
  assert.match(body, /^Exec=\/opt\/konnect\/konnect --hidden$/m);
  assert.match(body, /^Terminal=false$/m);
  assert.match(body, /^X-GNOME-Autostart-enabled=true$/m);
});

test('a path containing spaces is quoted so Exec does not split it', () => {
  const body = desktopEntry({ execPath: '/home/a b/konnect', args: ['--hidden'] });
  assert.match(body, /^Exec="\/home\/a b\/konnect" --hidden$/m);
});

test('an argument containing spaces is quoted, not just the exec path', () => {
  const body = desktopEntry({ execPath: '/opt/konnect/konnect', args: ['/home/a b/proj', '--hidden'] });
  assert.match(body, /^Exec=\/opt\/konnect\/konnect "\/home\/a b\/proj" --hidden$/m);
});

test('reserved characters inside a quoted component are escaped', () => {
  const body = desktopEntry({ execPath: '/opt/k', args: ['/home/a "b"/p', '--hidden'] });
  assert.match(body, /^Exec=\/opt\/k "\/home\/a \\"b\\"\/p" --hidden$/m);
});

test('a plain path is left unquoted', () => {
  const body = desktopEntry({ execPath: '/opt/konnect/konnect', args: ['--hidden'] });
  assert.match(body, /^Exec=\/opt\/konnect\/konnect --hidden$/m);
});

test('enable creates the file, isEnabled sees it, disable removes it', async () => {
  assert.strictEqual(isEnabled(), false);
  await enable({ execPath: '/opt/konnect/konnect', args: ['--hidden'] });
  assert.strictEqual(isEnabled(), true);
  assert.ok(fs.existsSync(AUTOSTART_PATH));
  await disable();
  assert.strictEqual(isEnabled(), false);
});

test('disable is idempotent when the file is already gone', async () => {
  await disable();
  await assert.doesNotReject(() => disable());
});

test('enable creates the autostart directory when it does not exist', async () => {
  fs.rmSync(path.dirname(AUTOSTART_PATH), { recursive: true, force: true });
  await enable({ execPath: '/opt/konnect/konnect', args: [] });
  assert.strictEqual(isEnabled(), true);
  await disable();
});
