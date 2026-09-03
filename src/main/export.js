'use strict';

// A field beginning with = + - @ is interpreted as a formula by Excel and
// LibreOffice. Contact names arrive from the handset, so neutralise them.
function csvField(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const head = columns.map(([, label]) => csvField(label)).join(',');
  const body = rows.map((row) => columns.map(([key]) => csvField(row[key])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

function directionLabel(row) {
  if (row.direction === 'in' && !row.started_at) return 'Missed';
  return row.direction === 'in' ? 'Incoming' : 'Outgoing';
}

function callsToCsv(rows) {
  const decorated = rows.map((r) => ({ ...r, kind: directionLabel(r) }));
  return toCsv(decorated, [
    ['kind', 'Direction'], ['name', 'Name'], ['number_e164', 'Number'],
    ['started_at', 'Started'], ['ended_at', 'Ended'],
    ['duration_s', 'Duration (s)'], ['recording_path', 'Recording'],
  ]);
}

function contactsToCsv(rows) {
  return toCsv(rows, [['name', 'Name'], ['number_e164', 'Number'], ['type', 'Type']]);
}

// RFC 2426 2.4.2: backslash, comma, semicolon and newlines are STRUCTURAL in
// a vCard text value and must be escaped. Contact names arrive from the
// handset over OPP, so an unescaped name is an injection vector rather than a
// formatting nicety. Measured against our own parser: a contact named
// "Ann\r\nTEL;TYPE=CELL:+99999999" round-trips as a card carrying TWO numbers,
// with the injected one FIRST - so it becomes the primary number when the file
// is imported into another address book. Backslash must be replaced first or
// it re-escapes the escapes added after it.
function vcardText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function contactsToVcf(rows) {
  return rows.map((c) => [
    'BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardText(c.name)}`,
    `TEL;TYPE=CELL:${vcardText(c.number_e164)}`, 'END:VCARD',
  ].join('\r\n')).join('\r\n') + '\r\n';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function hms(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function reportHtml({ stats, rows, range }) {
  const period = range.from || range.to
    ? `${esc(range.from || 'start')} to ${esc(range.to || 'today')}`
    : 'All time';

  const tiles = [
    ['Total calls', stats.total], ['Incoming', stats.in], ['Outgoing', stats.out],
    ['Missed', stats.missed], ['Talk time', hms(stats.talkTimeSeconds)],
  ].map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  const top = stats.topContacts.map((c) =>
    `<tr><td>${esc(c.name)}</td><td>${esc(c.number)}</td><td>${esc(c.count)}</td></tr>`).join('');

  const recent = rows.slice(0, 50).map((r) =>
    `<tr><td>${esc(directionLabel(r))}</td><td>${esc(r.name || 'Unknown')}</td>` +
    `<td>${esc(r.number_e164)}</td><td>${esc(r.ended_at)}</td>` +
    `<td>${esc(r.duration_s)}s</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Konnect call report</title>
<style>
  body { font: 12px system-ui, sans-serif; color: #14161a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .period { color: #666; margin-bottom: 20px; }
  .tiles { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .tile { border: 1px solid #ddd; border-radius: 8px; padding: 10px 14px; min-width: 110px; }
  .tile span { display: block; color: #666; font-size: 10px; text-transform: uppercase; }
  .tile strong { font-size: 17px; }
  h2 { font-size: 14px; margin: 22px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
  th { color: #666; font-size: 10px; text-transform: uppercase; }
</style></head><body>
<h1>Konnect call report</h1>
<div class="period">${period}</div>
<div class="tiles">${tiles}</div>
<h2>Top contacts</h2>
<table><thead><tr><th>Name</th><th>Number</th><th>Calls</th></tr></thead><tbody>${top}</tbody></table>
<h2>Recent calls</h2>
<table><thead><tr><th>Direction</th><th>Name</th><th>Number</th><th>When</th><th>Duration</th></tr></thead><tbody>${recent}</tbody></table>
</body></html>`;
}

// Electron-only: renders the report in an offscreen window and prints to PDF.
async function writeReportPdf({ html, outPath }) {
  const { BrowserWindow } = require('electron');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  // Chromium blocks top-level navigation to a data: URL. Measured on the
  // Electron in this repo: data: + offscreen HAPPENS to load, but data: +
  // show:false fails outright with ERR_FAILED - so the planned version was
  // leaning on an offscreen quirk to bypass a deliberate security block, and
  // an Electron upgrade could close it. loadFile works in BOTH window modes.
  // It also avoids encodeURIComponent inflating the page 2.9x for Devanagari
  // contact names, which this app expects to see.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'konnect-report-'));
  const page = path.join(dir, 'report.html');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await fs.writeFile(page, html, 'utf8');
    await win.loadFile(page);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.writeFile(outPath, pdf);
    return outPath;
  } finally {
    win.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = {
  toCsv, callsToCsv, contactsToCsv, contactsToVcf, reportHtml, writeReportPdf,
};
