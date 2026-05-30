'use strict';

const SEVERITY_RANK = { critical: 0, error: 0, warning: 1, warn: 1, info: 2, ok: 3 };

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clean(v) { return String(v ?? '').trim(); }

function normalizeSeverity(row) {
  const s = clean(row.warning_severity || row.severity).toLowerCase();
  if (s === 'critical' || s === 'error') return 'critical';
  if (s === 'warning' || s === 'warn') return 'warning';
  if (row.warning_type === 'MHD_EXPIRED') return 'critical';
  if (row.warning_type === 'MHD_NEAR') return 'warning';
  return 'info';
}

function parseCard(row) {
  return {
    batch_id:       toNum(row.batch_id),
    batch_key:      clean(row.batch_key),
    product_id:     toNum(row.product_id),
    product_name:   clean(row.product_name) || String(row.product_id ?? ''),
    mhd_date:       clean(row.mhd_date),
    remaining_qty:  toNum(row.remaining_qty),
    severity:       normalizeSeverity(row),
    warning_type:   clean(row.warning_type),
    machine_id:     clean(row.machine_id),
    machine_name:   clean(row.machine_name),
    location_name:  clean(row.location_name),
    mdb_code:       clean(row.mdb_code),
    slow_mover_class: row.slow_mover_class != null ? clean(row.slow_mover_class) : null,
  };
}

function applyFilters(cards, filters) {
  return cards.filter(card => {
    if (filters.severity  && card.severity  !== filters.severity)             return false;
    if (filters.machine_id && card.machine_id !== String(filters.machine_id)) return false;
    if (filters.product_id && card.product_id !== Number(filters.product_id)) return false;
    return true;
  });
}

function buildLagerData(rows, filters = {}) {
  const allCards = (rows || []).map(parseCard);
  const cards = applyFilters(allCards, filters);
  return {
    cards,
    summary: {
      total:    cards.length,
      critical: cards.filter(c => c.severity === 'critical').length,
      warning:  cards.filter(c => c.severity === 'warning').length,
    },
  };
}

module.exports = { buildLagerData };
