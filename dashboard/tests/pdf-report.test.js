'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildGuvPdf } = require('../lib/pdf-report.js');

const SAMPLE = {
  title:   'GuV-Bericht',
  period:  'Mai 2026',
  machine: 'Alle Automaten',
  today:   '04.06.2026',
  kpis: [
    { label: 'Umsatz (brutto)', value: '280,90 €' },
    { label: 'GuV (brutto)',    value: '120,50 €' },
    { label: 'Marge',          value: '42,9 %' },
    { label: 'Stück',          value: '214' },
  ],
  rows: [
    { product_name: 'Snickers',     revenue_gross: 123.45, gross_profit: 45.00, margin_gross_pct: 36.5, qty: 42 },
    { product_name: 'Twix',         revenue_gross:  89.00, gross_profit: 30.10, margin_gross_pct: 33.8, qty: 30 },
    { product_name: 'Ärger-Test',   revenue_gross:  68.45, gross_profit: 25.40, margin_gross_pct: 37.1, qty: 27 },
    { product_name: 'Müsli-Riegel', revenue_gross:  45.00, gross_profit: 15.00, margin_gross_pct: 33.3, qty: 15 },
  ],
};

test('buildGuvPdf returns a Buffer', () => {
  const pdf = buildGuvPdf(SAMPLE);
  assert.ok(Buffer.isBuffer(pdf), 'expected Buffer');
  assert.ok(pdf.length > 500);
});

test('PDF starts with %PDF-1.', () => {
  const pdf = buildGuvPdf(SAMPLE);
  assert.equal(pdf.slice(0, 7).toString('binary'), '%PDF-1.');
});

test('PDF ends with %%EOF', () => {
  const pdf = buildGuvPdf(SAMPLE);
  assert.ok(pdf.slice(-20).toString('binary').includes('%%EOF'));
});

test('PDF contains xref and startxref', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('xref\n'));
  assert.ok(str.includes('startxref\n'));
});

test('PDF trailer references Root object', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.match(str, /\/Root \d+ 0 R/);
});

test('PDF contains Catalog and Pages objects', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('/Type /Catalog'));
  assert.ok(str.includes('/Type /Pages'));
});

test('PDF contains Helvetica and WinAnsiEncoding', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('/BaseFont /Helvetica'));
  assert.ok(str.includes('/BaseFont /Helvetica-Bold'));
  assert.ok(str.includes('/WinAnsiEncoding'));
});

test('PDF contains report title', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('GuV-Bericht'));
});

test('German umlauts encoded as WinAnsi bytes', () => {
  // 'Ärger-Test' → Ä (0xC4); 'Müsli' → ü (0xFC)
  const pdf = buildGuvPdf(SAMPLE);
  assert.ok(pdf.indexOf(Buffer.from([0xC4])) > 0, 'Ä (0xC4) not found');
  assert.ok(pdf.indexOf(Buffer.from([0xFC])) > 0, 'ü (0xFC) not found');
});

test('PDF contains product names', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('Snickers'));
  assert.ok(str.includes('Twix'));
});

test('PDF contains period and machine labels', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('Mai 2026'));
  assert.ok(str.includes('Alle Automaten'));
});

test('PDF contains Summe row label', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('Summe'));
});

test('PDF contains column headers', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  assert.ok(str.includes('Produkt'));
  assert.ok(str.includes('Umsatz brutto'));
  assert.ok(str.includes('GuV brutto'));
  assert.ok(str.includes('Marge'));
});

test('Single page for small dataset', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  const pages = (str.match(/\/Type \/Page\b/g) || []).length;
  assert.equal(pages, 1);
});

test('Multiple pages for large dataset', () => {
  const manyRows = Array.from({ length: 60 }, (_, i) => ({
    product_name: `Produkt ${i + 1}`,
    revenue_gross: 10.0, gross_profit: 3.5, margin_gross_pct: 35.0, qty: 5,
  }));
  const str = buildGuvPdf({ ...SAMPLE, rows: manyRows }).toString('binary');
  const pages = (str.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages > 1, `expected >1 pages, got ${pages}`);
});

test('Handles empty rows gracefully', () => {
  const pdf = buildGuvPdf({ ...SAMPLE, rows: [] });
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.slice(0, 7).toString('binary').startsWith('%PDF-1.'));
});

test('Handles missing optional fields', () => {
  const pdf = buildGuvPdf({ rows: SAMPLE.rows });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.slice(0, 7).toString('binary'), '%PDF-1.');
});

test('xref entries are exactly 20 bytes (PDF spec compliance)', () => {
  const str = buildGuvPdf(SAMPLE).toString('binary');
  // Find first entry after the free-entry header line
  const xrefIdx = str.indexOf('\nxref\n') + 1;
  assert.ok(xrefIdx > 0, 'no xref block found');
  const xrefBlock = str.slice(xrefIdx + 'xref\n'.length);
  // Skip "0 N\n" header and free entry line
  const afterHeader = xrefBlock.indexOf('\n') + 1; // skip "0 N"
  const freeEntryEnd = xrefBlock.indexOf('\n', afterHeader) + 1; // skip "0000000000 65535 f\r\n"
  const entryStart  = freeEntryEnd;
  const entryEnd    = xrefBlock.indexOf('\n', entryStart) + 1; // includes \n of \r\n
  // Entry is "nnnnnnnnnn ggggg n\r\n" = 20 bytes; the \r before \n counts as 1
  const entryLen = entryEnd - entryStart;
  assert.equal(entryLen, 20, `expected 20-byte xref entries, got ${entryLen}`);
});
