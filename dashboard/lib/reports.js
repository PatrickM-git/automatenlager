'use strict';

function escapeCsvValue(val) {
  const str = val == null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvExport(rows, fields) {
  const header = fields.map((f) => escapeCsvValue(f.label)).join(',');
  const dataLines = rows.map((row) =>
    fields.map((f) => escapeCsvValue(row[f.key])).join(',')
  );
  return [header, ...dataLines].join('\n');
}

function buildCsvFilename(from, to) {
  if (from === to) return `kpi-bericht-${from}.csv`;
  return `kpi-bericht-${from}-bis-${to}.csv`;
}

/* =========================================================================
   GuV-Steuerberater-Report: Brutto-Werte (wie die GuV-Seite), Summenzeile,
   deutsches Zahlenformat (Komma) + Semikolon-Trenner + UTF-8-BOM, damit die
   Datei in (deutschem) Excel sauber mit korrekten Umlauten oeffnet.
   ========================================================================= */

// Byte Order Mark als explizites Escape (NICHT als literales Zeichen im
// Quelltext) — schuetzt vor versehentlichen Encoding-Round-Trips.
const UTF8_BOM = String.fromCharCode(0xFEFF);

const REPORT_FIELDS = [
  { key: 'product_name',     label: 'Produkt' },
  { key: 'revenue_gross',    label: 'Umsatz brutto (EUR)', type: 'eur' },
  { key: 'gross_profit',     label: 'GuV brutto (EUR)',    type: 'eur' },
  { key: 'margin_gross_pct', label: 'Marge %',             type: 'pct' },
  { key: 'qty',              label: 'Stück',               type: 'int' },
];

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

function formatDeNumber(n, decimals) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return num.toFixed(decimals).replace('.', ',');
}

function escapeCsvCell(val, sep) {
  const str = val == null ? '' : String(val);
  if (str.includes(sep) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatReportCell(field, value) {
  if (field.type === 'eur') return formatDeNumber(value, 2);
  if (field.type === 'pct') return formatDeNumber(value, 1);
  if (field.type === 'int') return String(Math.round(Number(value) || 0));
  return value == null ? '' : String(value);
}

// Summen ueber alle Produktzeilen (Brutto), inkl. gewichteter Gesamt-Marge.
function buildReportTotals(rows) {
  const t = (Array.isArray(rows) ? rows : []).reduce(
    (a, r) => ({
      revenue_gross: a.revenue_gross + (Number(r.revenue_gross) || 0),
      gross_profit:  a.gross_profit  + (Number(r.gross_profit)  || 0),
      qty:           a.qty           + (Number(r.qty)           || 0),
    }),
    { revenue_gross: 0, gross_profit: 0, qty: 0 },
  );
  return {
    product_name: 'Summe',
    revenue_gross: round2(t.revenue_gross),
    gross_profit: round2(t.gross_profit),
    margin_gross_pct: t.revenue_gross > 0 ? round1((t.gross_profit / t.revenue_gross) * 100) : 0,
    qty: t.qty,
  };
}

// Vollstaendiger CSV-Report (Header + Produktzeilen + Summenzeile).
function buildReportCsv(rows, opts = {}) {
  const sep = opts.sep || ';';
  const data = Array.isArray(rows) ? rows : [];
  const header = REPORT_FIELDS.map((f) => escapeCsvCell(f.label, sep)).join(sep);
  const body = data.map((row) =>
    REPORT_FIELDS.map((f) => escapeCsvCell(formatReportCell(f, row[f.key]), sep)).join(sep),
  );
  const totals = buildReportTotals(data);
  const totalsLine = REPORT_FIELDS.map((f) => escapeCsvCell(formatReportCell(f, totals[f.key]), sep)).join(sep);
  const csv = [header, ...body, totalsLine].join('\r\n');
  return (opts.bom === false ? '' : UTF8_BOM) + csv;
}

function buildReportFilename(from, to, ext = 'csv') {
  const base = from === to ? `guv-bericht-${from}` : `guv-bericht-${from}-bis-${to}`;
  return `${base}.${ext}`;
}

module.exports = {
  buildCsvExport,
  buildCsvFilename,
  REPORT_FIELDS,
  buildReportTotals,
  buildReportCsv,
  buildReportFilename,
  formatDeNumber,
};
