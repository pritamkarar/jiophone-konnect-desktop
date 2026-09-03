'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// XDG_CONFIG_HOME is honoured because the tests set it, and because a user
// who has moved their config directory expects everything to follow.
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const AUTOSTART_PATH = path.join(CONFIG_HOME, 'autostart', 'konnect.desktop');

// The FILE is the single source of truth - there is deliberately no
// `autostart` settings key. Two records of one fact drift, and the one the
// checkbox shows would then disagree with the one the session actually reads.

// Desktop-entry Exec fields are whitespace-split, so any component holding a
// space silently becomes two arguments and the entry never launches. In
// development `args` carries app.getAppPath(), a real filesystem path, so
// quoting only execPath left the common case broken. Inside a quoted value
// the spec requires ", `, $ and \ to be backslash-escaped.
function quoteExecPart(part) {
  if (!/[\s"`$\\]/.test(part)) return part;
  return `"${part.replace(/(["`$\\])/g, '\\$1')}"`;
}

function desktopEntry({ execPath, args = [] }) {
  const exec = [execPath, ...args].map(quoteExecPart).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Konnect',
    'Comment=PC suite for JioPhone over Bluetooth',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function isEnabled() {
  return fs.existsSync(AUTOSTART_PATH);
}

async function enable({ execPath, args = [] }) {
  await fsp.mkdir(path.dirname(AUTOSTART_PATH), { recursive: true });
  await fsp.writeFile(AUTOSTART_PATH, desktopEntry({ execPath, args }), 'utf8');
}

async function disable() {
  await fsp.rm(AUTOSTART_PATH, { force: true });
}

module.exports = { AUTOSTART_PATH, desktopEntry, isEnabled, enable, disable };
