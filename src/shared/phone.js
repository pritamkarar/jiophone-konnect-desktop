'use strict';

// India-first E.164 normalisation. The handset reports caller id in mixed
// formats and the call log joins to contacts on this value, so both sides
// must normalise identically or caller-id lookup silently misses.
const NSN_LENGTH = 10;   // Indian national significant number
const IN_CC = '91';

// Stored in place of a number for a withheld / no-caller-id call. It is a
// sentinel, not a number: anything grouping calls by number must exclude it,
// or unrelated anonymous callers appear as one frequent contact.
const UNKNOWN_NUMBER = 'unknown';

function normaliseIndian(input) {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (hadPlus) return `+${digits}`;

  // 00 is the international access prefix in India.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return digits ? `+${digits}` : null;
  }

  // National trunk prefix.
  if (digits.length === NSN_LENGTH + 1 && digits.startsWith('0')) {
    return `+${IN_CC}${digits.slice(1)}`;
  }

  if (digits.length === NSN_LENGTH) return `+${IN_CC}${digits}`;

  if (digits.length === NSN_LENGTH + IN_CC.length && digits.startsWith(IN_CC)) {
    return `+${digits}`;
  }

  // Anything shorter is a short code or service number: leave it alone rather
  // than inventing a country code for something that is not a phone number.
  if (digits.length < NSN_LENGTH) return digits;

  return `+${digits}`;
}

// Characters a dial field may hold. The renderer strips everything else as
// you type, with the same class written out in app.js's input handler - this
// function is the authority the two have to agree on.
//
// NOT global. `test` on a /g regex advances lastIndex and so answers
// differently on consecutive calls with the same input: isDialable('9a')
// returned false, then true. A module-level regex used with `test` must be
// stateless.
const NOT_DIALABLE = /[^0-9+*#]/;

// What may be handed to oFono's Dial(). Deliberately a REFUSAL, not a
// normalisation: the field is already filtered as you type, so anything
// arriving here malformed came from somewhere else, and quietly altering a
// number about to be called is worse than declining to call it.
//
// * and # are in because the keypad has both and *123# is a real thing to
// dial. Separators are out: they are stripped from the field on input, so a
// number still carrying them never came from the dialer.
function isDialable(number) {
  return typeof number === 'string'
    && !NOT_DIALABLE.test(number)
    && /[0-9]/.test(number);
}

// A tel: URL (RFC 3966) can be handed to this app by any web page, any other
// desktop app, or a command line, so treat one as untrusted text that MIGHT
// contain a number rather than as a number. Everything it yields goes into
// the dial field only - nothing here places a call.
//
// The grammar allows visual separators (-.() and spaces) and a trailing
// ;param=value list. Parameters are dropped, never dialled:
// `tel:9876543210;phone-context=+91` means call that number, and letting the
// parameter's own digits through would dial something nobody typed.
//
// Normalisation is deliberately normaliseIndian, the same function the dial
// field and the call log use, so a number arriving by link and the same
// number typed by hand resolve to one contact.
function numberFromTelUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^tel:(.*)$/i.exec(url.trim());
  if (!m) return null;
  // Split BEFORE decoding: an encoded %3B has to stay inside the number part,
  // where normalisation drops it, rather than being decoded into a separator
  // that would silently truncate the number.
  const [subject] = m[1].split(';');
  let decoded;
  try {
    decoded = decodeURIComponent(subject);
  } catch {
    // decodeURIComponent throws URIError on a malformed escape. Null beats
    // falling back to the raw text, where '%E0%A4' would contribute a stray
    // '0' and '4' to something presented as a phone number.
    return null;
  }
  return normaliseIndian(decoded);
}

// HFP carries a caller's NUMBER but not their name: oFono's Name property is
// empty on every inbound call from the handset, so the popup and the call
// panel both showed "Unknown" for people already in Contacts. The call LOG got
// this right all along - insertCall() resolves the same way - so this is the
// live half of a lookup the app already does.
//
// findByNumber is injected rather than the store imported: keeps this pure,
// and the caller owns the "a throw here must not escape into a D-Bus signal
// handler" guard.
function withContactName(call, findByNumber) {
  // An HFP-supplied name, when one ever arrives, outranks the local address
  // book - it came from the network.
  if (!call || call.name || !call.number) return call;
  const e164 = normaliseIndian(call.number) || call.number;
  const contact = findByNumber(e164);
  return contact && contact.name ? { ...call, name: contact.name } : call;
}

module.exports = {
  normaliseIndian, UNKNOWN_NUMBER, withContactName, numberFromTelUrl,
  isDialable,
};
