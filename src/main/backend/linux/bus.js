'use strict';
const dbus = require('dbus-next');

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function macToPathSegment(mac) {
  if (typeof mac !== 'string' || !MAC_RE.test(mac)) {
    throw new Error(`invalid MAC address: ${mac}`);
  }
  return mac.toUpperCase().replace(/:/g, '_');
}

function isValidMac(mac) {
  return typeof mac === 'string' && MAC_RE.test(mac);
}

// oFono exposes HFP modems under /hfp/<bluez device path>.
function modemPathFor(mac) {
  return `/hfp/org/bluez/hci0/dev_${macToPathSegment(mac)}`;
}

function devicePathFor(mac) {
  return `/org/bluez/hci0/dev_${macToPathSegment(mac)}`;
}

// Reverse of devicePathFor. BlueZ hands us object paths in agent callbacks and
// InterfacesAdded; every other module in this codebase speaks MAC addresses.
function macFromPath(objectPath) {
  const m = /\/dev_([0-9A-Fa-f_]{17})$/.exec(String(objectPath || ''));
  return m ? m[1].replace(/_/g, ':').toUpperCase() : null;
}

// dbus-next returns a{sv} as { key: Variant }. One level is all we need.
function unwrap(dict) {
  const out = {};
  for (const [key, value] of Object.entries(dict || {})) {
    out[key] = value && typeof value === 'object' && 'value' in value ? value.value : value;
  }
  return out;
}

let _system = null;
let _session = null;
function systemBus() { if (!_system) _system = dbus.systemBus(); return _system; }
function sessionBus() { if (!_session) _session = dbus.sessionBus(); return _session; }

async function getInterface(bus, service, path, iface) {
  const obj = await bus.getProxyObject(service, path);
  return obj.getInterface(iface);
}

// BlueZ answers GetAll for an interface an object does not carry with
// InvalidArgs, NOT UnknownInterface. Verified against the handset:
//   type    "org.freedesktop.DBus.Error.InvalidArgs"
//   message "No such interface 'org.bluez.Battery1'"
// InvalidArgs ALSO covers genuinely malformed calls, so match on the MESSAGE
// rather than trusting the type: blanket-trusting InvalidArgs would silence
// real programming errors, and rejecting it outright reports a false bus
// fault on every poll, because Battery1 is legitimately absent here.
const ABSENT_TYPE_RE = /UnknownInterface|UnknownObject|UnknownProperty|DoesNotExist/i;
const ABSENT_MESSAGE_RE = /No such (interface|property|object)/i;

function describeDBusError(err) {
  if (!err) return 'unknown error';
  // message BEFORE name: a plain Error's name is the useless string "Error",
  // and a bus-unreachable failure - the very case this exists to diagnose -
  // arrives as a plain Error rather than a dbus-next DBusError with a type.
  return String(err.type || err.message || err.name || err);
}

function isAbsentError(err) {
  if (!err) return false;
  if (ABSENT_TYPE_RE.test(String(err.type || ''))) return true;
  return ABSENT_MESSAGE_RE.test(String(err.message || ''));
}

module.exports = {
  modemPathFor, devicePathFor, macFromPath, unwrap, systemBus, sessionBus, getInterface,
  isAbsentError, describeDBusError, isValidMac,
};
