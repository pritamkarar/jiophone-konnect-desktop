const test = require('node:test');
const assert = require('node:assert');
const {
  normaliseIndian, withContactName, numberFromTelUrl, isDialable,
} = require('../src/shared/phone');

test('already E.164 passes through', () => {
  assert.strictEqual(normaliseIndian('+919876543210'), '+919876543210');
});

test('ten digit local number gains +91', () => {
  assert.strictEqual(normaliseIndian('9876543210'), '+919876543210');
});

test('leading zero trunk prefix is stripped', () => {
  assert.strictEqual(normaliseIndian('09876543210'), '+919876543210');
});

test('country code without plus is normalised', () => {
  assert.strictEqual(normaliseIndian('919876543210'), '+919876543210');
});

test('formatting characters are ignored', () => {
  assert.strictEqual(normaliseIndian('+91 98765-43210'), '+919876543210');
  assert.strictEqual(normaliseIndian('(098) 7654 3210'), '+919876543210');
});

test('international numbers keep their own country code', () => {
  assert.strictEqual(normaliseIndian('+14155552671'), '+14155552671');
});

test('00 international prefix becomes +', () => {
  assert.strictEqual(normaliseIndian('0014155552671'), '+14155552671');
});

test('short codes are preserved verbatim, not forced to +91', () => {
  assert.strictEqual(normaliseIndian('121'), '121');
  assert.strictEqual(normaliseIndian('1800180'), '1800180');
});

test('unusable input returns null', () => {
  assert.strictEqual(normaliseIndian(''), null);
  assert.strictEqual(normaliseIndian(null), null);
  assert.strictEqual(normaliseIndian('abc'), null);
});

// ---- caller id ----------------------------------------------------------
// HFP gives a number but no name, so a live call arrives with name: null even
// when the caller is in Contacts. The call log already resolved this; the
// popup and the call panel did not.

test('withContactName fills a missing name from the local contacts', () => {
  const call = { id: '/c1', number: '09876543210', name: null };
  const out = withContactName(call, (n) => (n === '+919876543210' ? { id: 3, name: 'Amra Jain' } : null));
  assert.strictEqual(out.name, 'Amra Jain');
  // A copy, never a mutation: the backend's object is shared with the caller.
  assert.strictEqual(call.name, null);
  assert.strictEqual(out.number, '09876543210');
});

test('withContactName normalises before looking up, the way the call log does', () => {
  const seen = [];
  withContactName({ number: '98765 43210' }, (n) => { seen.push(n); return null; });
  withContactName({ number: '+91 98765 43210' }, (n) => { seen.push(n); return null; });
  assert.deepStrictEqual(seen, ['+919876543210', '+919876543210']);
});

test('withContactName leaves a network-supplied name alone', () => {
  const call = { number: '+919876543210', name: 'From The Network' };
  const out = withContactName(call, () => ({ id: 1, name: 'Local Book' }));
  assert.strictEqual(out.name, 'From The Network');
});

test('withContactName is a no-op with nothing to look up or nothing found', () => {
  const miss = { number: '+919999999999', name: null };
  assert.strictEqual(withContactName(miss, () => null), miss);
  const withheld = { number: null, name: null };
  assert.strictEqual(withheld, withContactName(withheld, () => { throw new Error('must not look up'); }));
  assert.strictEqual(withContactName(null, () => null), null);
  // A contact row with no usable name must not blank out the display.
  assert.strictEqual(withContactName(miss, () => ({ id: 1, name: '' })), miss);
});

// ---- tel: URLs ----------------------------------------------------------
// Every one of these arrives from outside the app - a web page, another
// desktop app, a command line - so this is a trust boundary, not a formatter.

test('a plain tel: URL yields its number', () => {
  assert.strictEqual(numberFromTelUrl('tel:+919876543210'), '+919876543210');
});

test('the scheme is matched case-insensitively', () => {
  // RFC 3986 §3.1: schemes are case-insensitive, and TEL: does turn up.
  assert.strictEqual(numberFromTelUrl('TEL:+919876543210'), '+919876543210');
});

test('RFC 3966 visual separators are dropped', () => {
  assert.strictEqual(numberFromTelUrl('tel:+91-98765-43210'), '+919876543210');
  assert.strictEqual(numberFromTelUrl('tel:(098) 765 43210'), '+919876543210');
});

test('percent-encoding is decoded before parsing', () => {
  // A '+' cannot travel literally in every context, and spaces arrive as %20.
  assert.strictEqual(numberFromTelUrl('tel:%2B91%20987%2065%2043210'), '+919876543210');
});

test('RFC 3966 parameters are discarded, not dialled', () => {
  // phone-context is the common one; isub and ext also appear. Dialling the
  // parameter text would place a call to a number nobody typed.
  assert.strictEqual(numberFromTelUrl('tel:9876543210;phone-context=+91'), '+919876543210');
  assert.strictEqual(numberFromTelUrl('tel:+919876543210;ext=123'), '+919876543210');
});

test('a local number still gets the same normalisation as typed input', () => {
  assert.strictEqual(numberFromTelUrl('tel:9876543210'), '+919876543210');
});

test('anything that is not a tel: URL is refused', () => {
  // The handler is reachable from any web page, so a non-tel scheme must not
  // be coaxed into the dialer by stripping a prefix that was never there.
  assert.strictEqual(numberFromTelUrl('https://evil.example/+919876543210'), null);
  assert.strictEqual(numberFromTelUrl('telnet:9876543210'), null);
  assert.strictEqual(numberFromTelUrl('not a url'), null);
});

test('a tel: URL with no dialable digits is refused', () => {
  assert.strictEqual(numberFromTelUrl('tel:'), null);
  assert.strictEqual(numberFromTelUrl('tel:;phone-context=+91'), null);
  assert.strictEqual(numberFromTelUrl('tel:abc'), null);
});

test('non-strings are refused rather than thrown on', () => {
  // process.argv entries are strings, but this is also fed straight from an
  // IPC-adjacent path; a throw here would happen during startup.
  assert.strictEqual(numberFromTelUrl(undefined), null);
  assert.strictEqual(numberFromTelUrl(null), null);
  assert.strictEqual(numberFromTelUrl(42), null);
});

test('a malformed percent-escape does not throw', () => {
  // decodeURIComponent('%E0%A4') throws URIError. Reaching the dialer with a
  // broken escape must degrade to "no number", never crash the handler.
  assert.strictEqual(numberFromTelUrl('tel:%E0%A4'), null);
});

// ---- what may be dialled ------------------------------------------------
// The dial field is type="tel", which restricts nothing - it is a keyboard
// hint. Whatever it holds goes to oFono's Dial() verbatim, so "what counts as
// a number" has to be decided somewhere both the field and the IPC boundary
// can share.

test('ordinary numbers are dialable', () => {
  assert.strictEqual(isDialable('+919876543210'), true);
  assert.strictEqual(isDialable('9876543210'), true);
  assert.strictEqual(isDialable('112'), true);
});

test('service and USSD codes are dialable', () => {
  // The keypad has * and # buttons, so *123# has to survive this check.
  assert.strictEqual(isDialable('*123#'), true);
  assert.strictEqual(isDialable('#31#9876543210'), true);
});

test('letters are not dialable', () => {
  assert.strictEqual(isDialable('abc'), false);
  assert.strictEqual(isDialable('98765abcde'), false);
  assert.strictEqual(isDialable('+91 98765 43210'), false, 'separators are stripped before dialling, not sent');
});

test('punctuation with no digits at all is not dialable', () => {
  assert.strictEqual(isDialable('*#'), false);
  assert.strictEqual(isDialable('+'), false);
  assert.strictEqual(isDialable(''), false);
});

test('non-strings are not dialable', () => {
  // call:dial is an IPC channel, so the argument is whatever the caller sent.
  assert.strictEqual(isDialable(null), false);
  assert.strictEqual(isDialable(undefined), false);
  assert.strictEqual(isDialable(9876543210), false);
  assert.strictEqual(isDialable({}), false);
});

test('isDialable gives the same answer every time it is asked', () => {
  // A module-level /g regex used with `test` carries lastIndex between calls:
  // this returned false then true before the flag came off.
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(isDialable('9a'), false, `call ${i + 1}`);
    assert.strictEqual(isDialable('+919876543210'), true, `call ${i + 1}`);
  }
});
