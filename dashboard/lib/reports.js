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

module.exports = { buildCsvExport, buildCsvFilename };
