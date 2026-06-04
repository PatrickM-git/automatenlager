'use strict';

const { formatProductName } = require('./economics.js');
const { availableBatchStatusSqlList } = require('./stock-status.js');
const { loadEffectiveConfig, DEFAULT_MANDANT } = require('./category-config.js'); // #34: MHD-Fenster aus Settings

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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toIsoDate(value) {
  // node-pg liefert DATE-Spalten als JS-Date zur LOKALEN Mitternacht. toISOString()
  // würde in Zeitzonen mit positivem UTC-Offset (z. B. Europe/Berlin = Prod) auf den
  // Vortag rutschen (DB 2026-05-27 -> '2026-05-26'). Daher die LOKALEN Datumsteile.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  const str = clean(value);
  if (!str) return '';
  // Bereits ein ISO-Datum ('YYYY-MM-DD…')? Direkt übernehmen, kein TZ-Reparse.
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return str.slice(0, 10);
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
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
    const mhdDays = (await loadEffectiveConfig(client, DEFAULT_MANDANT)).mhdRiskDays; // #34: eine Quelle
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
            AND sb.mhd_date <= CURRENT_DATE + INTERVAL '${mhdDays} days'
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

    // Chargen nach Produkt + MHD-Datum gruppieren: gleiche Ware mit gleichem
    // Ablaufdatum erscheint als eine Zeile mit summierter Menge. Damit werden
    // Doppeleinträge aus mehreren Rechnungen (unterschiedliche batch_key,
    // gleicher product_id + mhd_date) zu einer übersichtlichen Zeile zusammen-
    // gefasst. MIN(batch_key) dient als Anker für den Aussortieren-Button.
    // machine_qty: verlässlicher Nayax-Abgleich-Wert (current_machine_qty aus
    // slot_assignments, via #17 aktuell gehalten). Zeigt den echten Automatenbestand
    // unabhängig von der driftenden stock_batches.remaining_qty (#87).
    const allBatchesResult = await client.query(
      `SELECT p.product_id,
              p.name                               AS product_name,
              sb.mhd_date,
              SUM(sb.remaining_qty)::int           AS remaining_qty,
              COUNT(*)::int                        AS batch_count,
              MIN(sb.batch_key)                    AS batch_key,
              MIN(sb.purchase_date)                AS purchase_date,
              (sb.mhd_date::date - CURRENT_DATE)::int AS days_until_mhd,
              MAX(COALESCE(sa_agg.machine_qty, 0))::int AS machine_qty
         FROM automatenlager.stock_batches sb
         JOIN automatenlager.products p ON p.product_id = sb.product_id
         LEFT JOIN (
           SELECT product_id, SUM(current_machine_qty)::int AS machine_qty
             FROM automatenlager.slot_assignments
            WHERE active = TRUE
            GROUP BY product_id
         ) sa_agg ON sa_agg.product_id = sb.product_id
        WHERE sb.status IN (${availableBatchStatusSqlList()})
          AND sb.remaining_qty > 0
        GROUP BY p.product_id, p.name, sb.mhd_date,
                 (sb.mhd_date::date - CURRENT_DATE)::int
        ORDER BY sb.mhd_date ASC NULLS LAST, p.name`,
    );

    return {
      mhdRisks: mhdResult.rows,
      lowStock: lowStockResult.rows,
      allBatches: allBatchesResult.rows,
    };
  } finally {
    await client.end();
  }
}

module.exports = { buildInventoryMhdData, queryInventoryMhdPg, toIsoDate };
