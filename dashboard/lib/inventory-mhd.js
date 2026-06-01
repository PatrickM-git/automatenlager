'use strict';

const { formatProductName } = require('./economics.js');
const { availableBatchStatusSqlList } = require('./stock-status.js');

const SEVERITY_RANK = {
  critical: 0,
  error: 0,
  warning: 1,
  warn: 1,
  info: 2,
  ok: 3,
};

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clean(value) {
  return String(value ?? '').trim();
}

function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const str = clean(value);
  if (!str) return '';
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function normalizeSeverity(row) {
  const explicit = clean(row.warning_severity || row.severity).toLowerCase();
  if (explicit) return explicit === 'warn' ? 'warning' : explicit;
  if (row.warning_type === 'MHD_EXPIRED') return 'critical';
  if (row.warning_type === 'MHD_NEAR') return 'warning';
  return 'info';
}

function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? 2;
}

function parseDateKey(value) {
  const parsed = new Date(`${clean(value)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? Number.MAX_SAFE_INTEGER : parsed.getTime();
}

function parseMhdRiskRow(row) {
  return {
    batch_id: toNum(row.batch_id),
    batch_key: clean(row.batch_key),
    product_id: toNum(row.product_id),
    product_name: formatProductName(clean(row.product_name)) || String(row.product_id ?? ''),
    mhd_date: toIsoDate(row.mhd_date),
    remaining_qty: toNum(row.remaining_qty),
    severity: normalizeSeverity(row),
    warning_type: clean(row.warning_type),
    message: clean(row.warning_message || row.message),
    machine_id: clean(row.machine_id),
    machine_name: clean(row.machine_name),
    location_id: clean(row.location_id),
    location_name: clean(row.location_name),
    mdb_code: toNum(row.mdb_code),
  };
}

function urgencyLabel(currentMachineQty, backstockQty) {
  if (currentMachineQty <= 0 && backstockQty <= 0) return 'leer, kein Backstock';
  if (currentMachineQty <= 0) return 'leer';
  if (backstockQty <= 0) return 'knapp, kein Backstock';
  return 'nachfüllen';
}

function parseLowStockRow(row) {
  const currentMachineQty = toNum(row.current_machine_qty);
  const targetStock = toNum(row.target_stock);
  const backstockQty = toNum(row.backstock_qty);
  const refillGap = Math.max(0, targetStock - currentMachineQty);
  return {
    product_id: toNum(row.product_id),
    product_name: formatProductName(clean(row.product_name)) || String(row.product_id ?? ''),
    current_machine_qty: currentMachineQty,
    target_stock: targetStock,
    backstock_qty: backstockQty,
    refill_gap: refillGap,
    urgency_label: urgencyLabel(currentMachineQty, backstockQty),
    machine_id: clean(row.machine_id),
    machine_name: clean(row.machine_name),
    location_id: clean(row.location_id),
    location_name: clean(row.location_name),
    mdb_code: toNum(row.mdb_code),
  };
}

function sortMhdRisks(rows) {
  return [...rows].sort((a, b) => {
    const dateDelta = parseDateKey(a.mhd_date) - parseDateKey(b.mhd_date);
    if (dateDelta !== 0) return dateDelta;
    const severityDelta = severityRank(a.severity) - severityRank(b.severity);
    if (severityDelta !== 0) return severityDelta;
    return a.product_name.localeCompare(b.product_name, 'de');
  });
}

function sortLowStock(rows) {
  return [...rows].sort((a, b) => {
    if (b.refill_gap !== a.refill_gap) return b.refill_gap - a.refill_gap;
    if (a.current_machine_qty !== b.current_machine_qty) {
      return a.current_machine_qty - b.current_machine_qty;
    }
    return a.product_name.localeCompare(b.product_name, 'de');
  });
}

function matchesFilter(row, filters) {
  const location = clean(filters.location);
  const machine = clean(filters.machine);
  return (!location || row.location_id === location || row.location_name === location)
    && (!machine || row.machine_id === machine || row.machine_name === machine);
}

function buildInventoryMhdData(pgRows = {}, query = {}) {
  const sortBy = query.sort || 'mhd_date';
  const sortOrder = query.order === 'desc' ? 'desc' : 'asc';
  const filters = {
    location: clean(query.location),
    machine: clean(query.machine),
  };
  const mhdRisks = sortMhdRisks((pgRows.mhdRisks || [])
    .map(parseMhdRiskRow)
    .filter((row) => matchesFilter(row, filters)));

  if (sortOrder === 'desc') {
    mhdRisks.reverse();
  }

  return {
    mhdRisks,
    lowStock: sortLowStock((pgRows.lowStock || [])
      .map(parseLowStockRow)
      .filter((row) => row.current_machine_qty === 0 && matchesFilter(row, filters))),
    filters,
    sortBy,
    sortOrder,
  };
}

async function queryInventoryMhdPg(pgUrl, query = {}) {
  const { Client } = require('pg');
  const locationFilter = clean(query.location);
  const machineFilter = clean(query.machine);
  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const params = [locationFilter, machineFilter];
    const [mhdResult, lowStockResult] = await Promise.all([
      client.query(
        `SELECT sb.batch_id,
                sb.batch_key,
                p.product_id,
                p.name AS product_name,
                sb.mhd_date,
                sb.remaining_qty,
                w.warning_type,
                w.warning_severity,
                w.warning_message,
                m.machine_key AS machine_id,
                m.name AS machine_name,
                l.location_key AS location_id,
                l.name AS location_name,
                sa.mdb_code
           FROM automatenlager.stock_batches sb
           JOIN automatenlager.products p ON p.product_id = sb.product_id
           LEFT JOIN automatenlager.slot_assignments sa
             ON sa.product_id = p.product_id AND sa.active = TRUE
           LEFT JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
           LEFT JOIN automatenlager.locations l ON l.location_id = m.location_id
           LEFT JOIN LATERAL (
             SELECT w2.warning_type,
                    w2.severity AS warning_severity,
                    w2.message AS warning_message
               FROM automatenlager.warnings w2
              WHERE w2.product_id = p.product_id
                AND w2.resolved = FALSE
                AND w2.warning_type IN ('MHD_NEAR', 'MHD_EXPIRED')
              ORDER BY CASE WHEN w2.warning_type = 'MHD_EXPIRED' THEN 0 ELSE 1 END,
                       w2.created_at DESC
              LIMIT 1
           ) w ON TRUE
          WHERE sb.status IN (${availableBatchStatusSqlList()})
            AND sb.remaining_qty > 0
            AND sb.mhd_date IS NOT NULL
            AND sb.mhd_date <= CURRENT_DATE + INTERVAL '30 days'
            AND ($1 = '' OR l.location_key = $1 OR l.name ILIKE '%' || $1 || '%')
            AND ($2 = '' OR m.machine_key = $2 OR m.name ILIKE '%' || $2 || '%')
          ORDER BY sb.mhd_date ASC`,
        params,
      ),
      client.query(
        `WITH batch_totals AS (
           SELECT product_id, SUM(remaining_qty)::int AS total_qty
             FROM automatenlager.stock_batches
            WHERE status IN (${availableBatchStatusSqlList()})
            GROUP BY product_id
         )
         SELECT p.product_id,
                p.name AS product_name,
                sa.current_machine_qty,
                sa.target_stock,
                GREATEST(COALESCE(bt.total_qty, 0) - sa.current_machine_qty, 0)::int AS backstock_qty,
                m.machine_key AS machine_id,
                m.name AS machine_name,
                l.location_key AS location_id,
                l.name AS location_name,
                sa.mdb_code
           FROM automatenlager.slot_assignments sa
           JOIN automatenlager.products p ON p.product_id = sa.product_id
           JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
           JOIN automatenlager.locations l ON l.location_id = m.location_id
           LEFT JOIN batch_totals bt ON bt.product_id = p.product_id
          WHERE sa.active = TRUE
            AND sa.current_machine_qty = 0
            AND ($1 = '' OR l.location_key = $1 OR l.name ILIKE '%' || $1 || '%')
            AND ($2 = '' OR m.machine_key = $2 OR m.name ILIKE '%' || $2 || '%')`,
        params,
      ),
    ]);

    return {
      mhdRisks: mhdResult.rows,
      lowStock: lowStockResult.rows,
    };
  } finally {
    await client.end();
  }
}

module.exports = { buildInventoryMhdData, queryInventoryMhdPg };
