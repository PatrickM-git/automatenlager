'use strict';

// Hand-rolled minimal PDF/1.4 generator for the GuV export.
// Uses built-in Helvetica / Helvetica-Bold Type1 fonts + WinAnsiEncoding.
// No external dependencies. Supports multi-page output.

const { buildReportTotals, formatDeNumber } = require('./reports.js');

// ─── Page geometry (A4, points: 1 pt = 1/72 inch) ────────────────────────────
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MX     = 45;                     // left/right margin
const MY_TOP = 50;                     // top margin
const MY_BOT = 45;                     // bottom margin
const TOP    = PAGE_H - MY_TOP;        // y of first content line (high = top)
const BOT    = MY_BOT;                 // y of last content line

// ─── Typography ───────────────────────────────────────────────────────────────
const SZ_TITLE   = 16;
const SZ_META    = 9;
const SZ_KPI_LBL = 7.5;
const SZ_KPI_VAL = 13;
const SZ_HDR     = 8;
const SZ_ROW     = 9;
const SZ_NOTE    = 7.5;
const LH_TITLE   = 20;
const LH_META    = 14;
const LH_HDR     = 13;
const LH_ROW     = 13;
const LH_KPI     = 22;
const GAP        = 7;

// ─── Column definitions ───────────────────────────────────────────────────────
const COLS = [
  { key: 'product_name',     label: 'Produkt',       x: MX,  w: 225, align: 'left'  },
  { key: 'revenue_gross',    label: 'Umsatz brutto', x: 275, w: 73,  align: 'right' },
  { key: 'gross_profit',     label: 'GuV brutto',    x: 352, w: 68,  align: 'right' },
  { key: 'margin_gross_pct', label: 'Marge',         x: 424, w: 56,  align: 'right' },
  { key: 'qty',              label: 'Stück',         x: 484, w: 65,  align: 'right' },
];
const RIGHT_EDGE = MX + (PAGE_W - MX * 2); // 550.28

// ─── WinAnsi encoding ─────────────────────────────────────────────────────────
// Map UTF-16 code points above U+00FF to WinAnsi byte values.
const WIN_EXTRAS = {
  '€': '\x80', // €
  '–': '\x96', // –
  '—': '\x97', // —
  '‘': '\x91', // '
  '’': '\x92', // '
  '“': '\x93', // "
  '”': '\x94', // "
  '…': '\x85', // …
};

function toWinAnsi(str) {
  return String(str ?? '').replace(/[^\x00-\xFF]/g, (c) => WIN_EXTRAS[c] ?? '?');
}

// Returns a PDF literal string: (escaped content), using binary (WinAnsi) chars.
function pdfStr(s) {
  const win = toWinAnsi(s);
  let out = '(';
  for (let i = 0; i < win.length; i++) {
    const ch = win[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '(') out += '\\(';
    else if (ch === ')') out += '\\)';
    else out += ch;
  }
  return out + ')';
}

// ─── Approximate character width for right-alignment ─────────────────────────
// Helvetica glyph widths (1/1000 em units, simplified). Covers ASCII + umlauts.
function charWidthUnits(c) {
  const code = c.charCodeAt(0);
  if (code === 32) return 278;                         // space
  if (code >= 48 && code <= 57) return 556;            // 0-9
  if (c === ',' || c === '.' || c === ':') return 278; // punctuation
  if (c === '-') return 333;
  if (c === '%') return 889;
  if (c === '\x80' || c === '€') return 556;           // €
  // Latin letters (rough average)
  return 556;
}

function textWidth(s, fontSize) {
  const win = toWinAnsi(String(s ?? ''));
  let units = 0;
  for (const c of win) units += charWidthUnits(c);
  return (units / 1000) * fontSize;
}

// ─── Number formatters ────────────────────────────────────────────────────────
function fmtEuro(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${formatDeNumber(v, 2)} \x80` : '\x96'; // € via WinAnsi 0x80
}

function fmtPct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${formatDeNumber(v, 1)} %` : '\x96';
}

function fmtQty(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v)) : '\x96';
}

function cellText(key, val) {
  if (key === 'revenue_gross' || key === 'gross_profit') return fmtEuro(val);
  if (key === 'margin_gross_pct') return fmtPct(val);
  if (key === 'qty') return fmtQty(val);
  return String(val ?? '');
}

// ─── Content stream (PDF drawing commands) ────────────────────────────────────
class ContentStream {
  constructor() { this._buf = ''; }

  _push(s) { this._buf += s + '\n'; return this; }

  font(name, size) { return this._push(`/${name} ${size} Tf`); }

  // Absolute text position via Tm (text matrix: 1 0 0 1 x y).
  at(x, y) { return this._push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`); }

  draw(s) { return this._push(`${pdfStr(s)} Tj`); }

  // Draw s right-aligned so its right edge is at rightX.
  drawRight(s, rightX, y, fontSize) {
    const tw = textWidth(s, fontSize);
    return this.at(Math.max(COLS[0].x, rightX - tw), y).draw(s);
  }

  // Set gray fill colour (0 = black, 1 = white)
  gray(g) { return this._push(`${g.toFixed(3)} g`); }

  // Horizontal line
  hLine(x1, x2, y, lw = 0.5) {
    return this._push(`${lw} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
  }

  // Filled rectangle (uses fill colour set via gray())
  fillRect(x, y, w, h) {
    return this._push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  begin() { return this._push('BT'); }
  end()   { return this._push('ET'); }

  // Returns the stream as a latin1-encoded Buffer.
  toBuffer() { return Buffer.from(this._buf, 'binary'); }
}

// ─── PDF object builder ───────────────────────────────────────────────────────
// Objects can be pre-allocated (reserve → setObj/setStream) so forward
// references are resolved before adding any content.
class PdfBuilder {
  constructor() {
    this._slots = new Map(); // id → Buffer
    this._nextId = 1;
  }

  reserve() { return this._nextId++; }

  setObj(id, dict) {
    const raw = Buffer.from(`${id} 0 obj\n${dict}\nendobj\n`, 'binary');
    this._slots.set(id, raw);
    return id;
  }

  setStream(id, contentBuf) {
    const head = Buffer.from(`${id} 0 obj\n<< /Length ${contentBuf.length} >>\nstream\n`, 'binary');
    const tail = Buffer.from('\nendstream\nendobj\n', 'binary');
    this._slots.set(id, Buffer.concat([head, contentBuf, tail]));
    return id;
  }

  // Build the final PDF Buffer. rootId = the ID of the Catalog object.
  build(rootId) {
    const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
    const parts  = [header];
    const offsets = new Map();
    let offset = header.length;

    // Write objects in ID order (1, 2, 3, …)
    for (let id = 1; id < this._nextId; id++) {
      const buf = this._slots.get(id);
      if (!buf) throw new Error(`PDF object ${id} was reserved but never set`);
      offsets.set(id, offset);
      parts.push(buf);
      offset += buf.length;
    }

    // xref table (each entry exactly 20 bytes: 10-digit offset + ' ' + 5-digit gen + ' n \r\n')
    const xrefOffset = offset;
    const count = this._nextId;
    let xref = `xref\n0 ${count}\n`;
    xref += '0000000000 65535 f\r\n';
    for (let id = 1; id < count; id++) {
      xref += `${String(offsets.get(id)).padStart(10, '0')} 00000 n\r\n`;
    }
    parts.push(Buffer.from(xref, 'binary'));

    const trailer = `trailer\n<< /Size ${count} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    parts.push(Buffer.from(trailer, 'binary'));

    return Buffer.concat(parts);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build a GuV-report PDF and return it as a Node.js Buffer.
 *
 * @param {object} opts
 *   - title    {string}  Report heading
 *   - period   {string}  Human-readable period label
 *   - machine  {string}  Machine / filter label
 *   - today    {string}  Date string for footer
 *   - kpis     {Array<{label,value}>}  Summary KPI boxes
 *   - rows     {Array}   Product rows sorted by caller
 */
function buildGuvPdf(opts) {
  const title   = String(opts.title   ?? 'GuV-Bericht');
  const period  = String(opts.period  ?? '');
  const machine = String(opts.machine ?? 'Alle Automaten');
  const today   = String(opts.today   ?? '');
  const kpis    = Array.isArray(opts.kpis) ? opts.kpis : [];
  const rows    = Array.isArray(opts.rows) ? opts.rows : [];
  const totals  = buildReportTotals(rows);

  // ── Build page content streams ──────────────────────────────────────────────
  const pageStreams = [];
  let cs = new ContentStream();
  let y = TOP;
  let pageNewFlag = false; // set true when a new page was just started

  function pushPage() {
    pageStreams.push(cs);
    cs = new ContentStream();
    y = TOP;
    pageNewFlag = true;
  }

  // Ensure at least `needed` points of vertical space; start new page if not.
  function need(needed) {
    pageNewFlag = false;
    if (y - needed < BOT) pushPage();
  }

  // ── Table helpers ───────────────────────────────────────────────────────────
  function tableHeader() {
    cs.gray(0.93).fillRect(MX, y - 2, RIGHT_EDGE - MX, LH_HDR + 4).gray(0);
    cs.begin().font('F2', SZ_HDR);
    for (const col of COLS) {
      const s = col.label;
      if (col.align === 'right') {
        const rightX = col.x + col.w;
        const tw = textWidth(s, SZ_HDR);
        cs.at(Math.max(col.x, rightX - tw), y).draw(s);
      } else {
        cs.at(col.x, y).draw(s);
      }
    }
    cs.end();
    y -= LH_HDR;
    cs.hLine(MX, RIGHT_EDGE, y, 0.75);
    y -= 3;
  }

  function tableRow(row, isEven) {
    if (isEven) {
      cs.gray(0.97).fillRect(MX, y - 2, RIGHT_EDGE - MX, LH_ROW + 2).gray(0);
    }
    cs.begin().font('F1', SZ_ROW);
    for (const col of COLS) {
      const val = cellText(col.key, row[col.key]);
      if (col.align === 'right') {
        const rightX = col.x + col.w;
        const tw = textWidth(val, SZ_ROW);
        cs.at(Math.max(col.x, rightX - tw), y).draw(val);
      } else {
        cs.at(col.x, y).draw(val);
      }
    }
    cs.end();
    y -= LH_ROW;
  }

  function totalsRow(tot) {
    cs.hLine(MX, RIGHT_EDGE, y + LH_ROW - 1, 0.75);
    cs.begin().font('F2', SZ_ROW);
    for (const col of COLS) {
      const val = col.key === 'product_name' ? 'Summe' : cellText(col.key, tot[col.key]);
      if (col.align === 'right') {
        const rightX = col.x + col.w;
        const tw = textWidth(val, SZ_ROW);
        cs.at(Math.max(col.x, rightX - tw), y).draw(val);
      } else {
        cs.at(col.x, y).draw(val);
      }
    }
    cs.end();
    y -= LH_ROW;
  }

  // ── First-page header ───────────────────────────────────────────────────────
  // Title
  cs.begin().font('F2', SZ_TITLE).at(MX, y).draw(title).end();
  y -= LH_TITLE;

  // Meta
  const meta = `Zeitraum: ${period}   |   Automat: ${machine}   |   Erstellt am ${today}`;
  cs.begin().font('F1', SZ_META).at(MX, y).draw(meta).end();
  y -= LH_META;

  cs.hLine(MX, RIGHT_EDGE, y, 0.5);
  y -= GAP;

  // KPI row
  if (kpis.length > 0) {
    const kpiW = (RIGHT_EDGE - MX) / kpis.length;
    for (let i = 0; i < kpis.length; i++) {
      const kx = MX + i * kpiW;
      cs.begin().font('F1', SZ_KPI_LBL).at(kx, y).draw(String(kpis[i].label ?? '')).end();
      cs.begin().font('F2', SZ_KPI_VAL).at(kx, y - SZ_KPI_LBL - 3).draw(String(kpis[i].value ?? '')).end();
    }
    y -= LH_KPI;
    cs.hLine(MX, RIGHT_EDGE, y, 0.5);
    y -= GAP;
  }

  // ── Table ───────────────────────────────────────────────────────────────────
  need(LH_HDR + LH_ROW * 3 + 10);
  tableHeader();

  for (let i = 0; i < rows.length; i++) {
    need(LH_ROW + 3);
    if (pageNewFlag) tableHeader(); // re-draw header on continuation pages
    tableRow(rows[i], i % 2 === 1);
  }

  need(LH_ROW + 6);
  if (pageNewFlag) tableHeader();
  totalsRow(totals);

  // Footer note
  y -= GAP;
  need(SZ_NOTE + 6);
  cs.gray(0.5)
    .begin().font('F1', SZ_NOTE).at(MX, y).draw(`GuV-Bericht erstellt am ${today} – Alle Beträge brutto.`).end()
    .gray(0);

  // Page number on each page footer
  pageStreams.push(cs);

  // ── Assemble PDF objects ────────────────────────────────────────────────────
  const b     = new PdfBuilder();
  const nPg   = pageStreams.length;

  // Pre-allocate all IDs so forward references are known.
  const catId    = b.reserve();
  const pagesId  = b.reserve();
  const fRegId   = b.reserve();
  const fBoldId  = b.reserve();
  const contIds  = pageStreams.map(() => b.reserve());
  const pageIds  = pageStreams.map(() => b.reserve());

  // Fill objects
  b.setObj(catId,  `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  b.setObj(pagesId,
    `<< /Type /Pages /Count ${nPg} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  );
  b.setObj(fRegId,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  b.setObj(fBoldId,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  const fontRes = `/Font << /F1 ${fRegId} 0 R /F2 ${fBoldId} 0 R >>`;
  for (let i = 0; i < nPg; i++) {
    b.setStream(contIds[i], pageStreams[i].toBuffer());
    b.setObj(pageIds[i],
      `<< /Type /Page /Parent ${pagesId} 0 R\n` +
      `   /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]\n` +
      `   /Contents ${contIds[i]} 0 R\n` +
      `   /Resources << ${fontRes} >> >>`,
    );
  }

  return b.build(catId);
}

module.exports = { buildGuvPdf };
