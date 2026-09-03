'use strict';
const crypto = require('node:crypto');
const { normaliseIndian } = require('./phone');

// vCard 2.1 as emitted by KaiOS over OBEX Object Push. Deliberately narrow:
// we need name, numbers and uid. Everything else is skipped, and any entry
// that fails to parse is dropped rather than aborting the whole import.

function decodeQuotedPrintable(value, charset) {
  const bytes = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '=' && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(value.charCodeAt(i) & 0xff);
  }
  return bytesToString(bytes, charset);
}

// KaiOS and many other emitters send UTF-8 quoted-printable WITHOUT declaring
// CHARSET. Defaulting to latin1 mojibakes exactly the non-Latin names QP
// exists to carry, so when no charset is declared, prefer UTF-8 and fall back
// to latin1 only when the bytes cannot be valid UTF-8.
function bytesToString(bytes, charset) {
  const buf = Buffer.from(bytes);
  if (charset) {
    return /utf-?8/i.test(charset) ? buf.toString('utf8') : buf.toString('latin1');
  }
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

// A line that begins a new property, e.g. `TEL;CELL:...` or `FN:...`.
const PROPERTY_RE = /^[A-Za-z0-9.-]+(;[^:]*)?:/;

// Joins folded lines. Two mechanisms coexist in the wild: RFC folding
// (continuation starts with space or tab) and quoted-printable soft breaks
// (line ends with '='). Both must be handled before parsing properties.
function unfold(text) {
  const raw = text.split(/\r\n|\r|\n/);
  const out = [];
  for (const line of raw) {
    const prev = out.length ? out[out.length - 1] : null;

    // A trailing '=' is a soft line break ONLY inside a quoted-printable
    // value. Treating it as one unconditionally also fires on base64 '='
    // padding and on transfers truncated mid-value, and in both cases it
    // swallows the following property line. When that line is the TEL, the
    // card ends up with no numbers and buildCard drops the contact entirely -
    // silent data loss, not a visible error.
    const qpSoftBreak = prev !== null
      && prev.endsWith('=')
      && /ENCODING=QUOTED-PRINTABLE/i.test(prev)
      && !PROPERTY_RE.test(line);

    if (qpSoftBreak) {
      // Drop the '='. If the emitter ALSO RFC-folded, one leading whitespace
      // is a fold marker and belongs to the folding, not to the value.
      out[out.length - 1] = prev.slice(0, -1) + line.replace(/^[ \t]/, '');
    } else if (prev !== null && /^[ \t]/.test(line)) {
      out[out.length - 1] = prev + line.replace(/^[ \t]/, '');
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...params] = head.split(';');
  const paramStr = params.join(';');
  const charset = (paramStr.match(/CHARSET=([^;]+)/i) || [])[1];
  const isQP = /ENCODING=QUOTED-PRINTABLE/i.test(paramStr);
  return {
    name: name.toUpperCase(),
    params: paramStr,
    value: isQP ? decodeQuotedPrintable(value, charset) : value,
  };
}

function nameFromN(value) {
  // N is Last;First;Middle;Prefix;Suffix
  const [last = '', first = '', middle = ''] = value.split(';');
  return [first, middle, last].filter(Boolean).join(' ').trim();
}

function buildCard(lines) {
  let fn = '';
  let n = '';
  let uid = '';
  const numbers = [];
  const raw = [];

  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'FN') fn = p.value.trim();
    else if (p.name === 'N') n = p.value;
    else if (p.name === 'UID') uid = p.value.trim();
    else if (p.name === 'TEL') {
      const e164 = normaliseIndian(p.value);
      // raw is index-parallel to numbers BY CONSTRUCTION. Pushing raw
      // unconditionally desynced the two arrays for any TEL that failed to
      // normalise or repeated a number already seen, so raw[i] then described
      // a different number than numbers[i] - measured, a 3-TEL card yielded
      // 2 numbers and 3 raw values. raw exists only to record the handset's
      // original formatting of a number we kept, so it is pushed with it.
      if (e164 && !numbers.includes(e164)) {
        numbers.push(e164);
        raw.push(p.value.trim());
      }
    }
  }

  if (!numbers.length) return null;
  const name = fn || nameFromN(n) || numbers[0];
  if (!uid) {
    uid = crypto.createHash('sha1')
      .update(`${name} ${numbers.join(',')}`)
      .digest('hex')
      .slice(0, 16);
  }
  return { uid, name, numbers, raw };
}

function parseVCards(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = unfold(text);
  const cards = [];
  let current = null;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') { current = []; continue; }
    if (upper === 'END:VCARD') {
      if (current) {
        try {
          const card = buildCard(current);
          if (card) cards.push(card);
        } catch { /* skip this entry, keep the import going */ }
      }
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return cards;
}

module.exports = { parseVCards };
