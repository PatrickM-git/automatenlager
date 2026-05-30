'use strict';

const { resolvePeriod, formatProductName } = require('./economics.js');

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function parseWarningTypes(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(',').map(clean).filter(Boolean);
}

function daysUntil(dateText) {
  const raw = clean(dateText);
  if (!raw) return null;
  const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((date.getTime() - today) / 86400000);
}

function indicator(code, label, source, evidence) {
  return {
    code,
    label,
    source,
    evidence,
    isRecommendation: false,
  };
}

function buildIndicators(slot) {
  const indicators = [];
  if (slot.qty >= 30 || slot.turnover_count >= 20) {
    indicators.push(indicator('runner', 'Renner', 'kpi', `${slot.qty} Stk. / ${slot.turnover_count} Verkäufe`));
  }
  if ((slot.qty > 0 && slot.qty <= 2) || (slot.turnover_count > 0 && slot.turnover_count <= 2)) {
    indicators.push(indicator('slow_mover', 'Langsamdreher', 'kpi', `${slot.qty} Stk. / ${slot.turnover_count} Verkäufe`));
  }
  if (slot.db_net >= 20) {
    indicators.push(indicator('db_strong', 'DB-stark', 'kpi', `${slot.db_net.toLocaleString('de-DE')} EUR DB netto`));
  }
  if (slot.revenue_net > 0 && slot.margin_pct < 25) {
    indicators.push(indicator('margin_weak', 'Marge schwach', 'kpi', `${slot.margin_pct.toLocaleString('de-DE')} % Marge`));
  }
  if (slot.mhd_risk_qty > 0 || (slot.nearest_mhd_days != null && slot.nearest_mhd_days <= 30) || slot.warning_types.some((type) => type.startsWith('MHD'))) {
    indicators.push(indicator('mhd_risk', 'MHD-Risiko', 'stock', slot.nearest_mhd_date ? `naechstes MHD ${slot.nearest_mhd_date}` : 'offene MHD-Warnung'));
  }
  if (slot.value_per_product >= 75) {
    indicators.push(indicator('capital_tied', 'Kapitalbindung', 'stock', `${slot.value_per_product.toLocaleString('de-DE')} EUR Warenwert`));
  }
  if (slot.target_stock > 0 && slot.current_machine_qty < slot.target_stock) {
    indicators.push(indicator('refill_need', 'Nachfuellbedarf', 'stock', `${slot.current_machine_qty} / ${slot.target_stock} Zielbestand`));
  }
  return indicators;
}

function matchesFilters(slot, filters) {
  return (!filters.location || slot.location_id === filters.location || slot.location_name.toLowerCase().includes(filters.location.toLowerCase()))
    && (!filters.machine || slot.machine_id === filters.machine || slot.machine_name.toLowerCase().includes(filters.machine.toLowerCase()));
}

function parseSlotRow(row) {
  const current = toNum(row.current_machine_qty);
  const target = toNum(row.target_stock);
  const capacity = toNum(row.machine_capacity);
  const revenue = Math.round(toNum(row.revenue_net) * 100) / 100;
  const db = Math.round(toNum(row.db_net) * 100) / 100;
  const slot = {
    slot_assignment_id: toNum(row.slot_assignment_id),
    location_id: clean(row.location_id),
    location_name: clean(row.location_name),
    machine_id: clean(row.machine_id),
    machine_name: clean(row.machine_name),
    mdb_code: toNum(row.mdb_code),
    product_id: toNum(row.product_id),
    product_name: formatProductName(clean(row.product_name)) || String(row.product_id ?? ''),
    current_machine_qty: current,
    target_stock: target,
    machine_capacity: capacity,
    qty: toNum(row.qty),
    revenue_net: revenue,
    db_net: db,
    margin_pct: revenue > 0 ? round1((db / revenue) * 100) : 0,
    turnover_count: toNum(row.turnover_count),
    value_per_product: Math.round(toNum(row.value_per_product) * 100) / 100,
    nearest_mhd_date: clean(row.nearest_mhd_date) || null,
    nearest_mhd_days: daysUntil(row.nearest_mhd_date),
    mhd_risk_qty: toNum(row.mhd_risk_qty),
    warning_types: parseWarningTypes(row.warning_types),
    occupancy: {
      current_machine_qty: current,
      target_stock: target,
      machine_capacity: capacity,
      fill_pct: capacity > 0 ? Math.round((current / capacity) * 100) : 0,
      label: `${current} / ${capacity || target || 0} im Slot`,
    },
  };
  slot.indicators = buildIndicators(slot);
  return slot;
}

function buildAssortmentSlotsData(pgRows, query = {}) {
  const filters = {
    location: clean(query.location),
    machine: clean(query.machine),
  };
  const slots = (pgRows.slots || [])
    .map(parseSlotRow)
    .filter((slot) => matchesFilters(slot, filters))
    .sort((a, b) => a.location_name.localeCompare(b.location_name, 'de')
      || a.machine_name.localeCompare(b.machine_name, 'de')
      || a.mdb_code - b.mdb_code);

  return {
    slots,
    filters,
    recommendations: [],
    indicatorLegend: [
      { code: 'runner', label: 'Renner', source: 'kpi' },
      { code: 'slow_mover', label: 'Langsamdreher', source: 'kpi' },
      { code: 'db_strong', label: 'DB-stark', source: 'kpi' },
      { code: 'margin_weak', label: 'Marge schwach', source: 'kpi' },
      { code: 'mhd_risk', label: 'MHD-Risiko', source: 'stock' },
      { code: 'capital_tied', label: 'Kapitalbindung', source: 'stock' },
      { code: 'refill_need', label: 'Nachfuellbedarf', source: 'stock' },
    ],
  };
}

async function queryAssortmentSlotsPg(pgUrl, query = {}) {
  const { Client } = require('pg');
  const locationFilter = clean(query.location);
  const machineFilter = clean(query.machine);
  const { from, to } = resolvePeriod(query);
  const dateFrom = `${from}-01`;
  const dateTo = `${to}-01`;

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const result = await client.query(
      `WITH sales AS (
         SELECT machine_id,
                mdb_code,
                product_id,
                SUM(quantity_sold)::int AS qty,
                SUM(revenue_net) AS revenue_net,
                SUM(gross_profit) AS db_net
           FROM automatenlager.guv_daily
          WHERE source != 'historic_backfill'
            AND date_trunc('month', posting_date) >= $3::date
            AND date_trunc('month', posting_date) <= $4::date
          GROUP BY machine_id, mdb_code, product_id
       ),
       turnover AS (
         SELECT machine_id,
                mdb_code,
                SUM(turnover_count)::int AS turnover_count
           FROM automatenlager.v_slot_turnover
          WHERE month >= $3::date
            AND month <= $4::date
          GROUP BY machine_id, mdb_code
       ),
       batch_status AS (
         SELECT product_id,
                MIN(mhd_date) FILTER (WHERE mhd_date IS NOT NULL AND status NOT IN ('depleted', 'expired')) AS nearest_mhd_date,
                SUM(remaining_qty) FILTER (WHERE mhd_date <= CURRENT_DATE + INTERVAL '30 days' AND status NOT IN ('depleted', 'expired'))::int AS mhd_risk_qty
           FROM automatenlager.stock_batches
          GROUP BY product_id
       ),
       warning_status AS (
         SELECT product_id,
                slot_assignment_id,
                ARRAY_AGG(DISTINCT warning_type) FILTER (WHERE warning_type IS NOT NULL) AS warning_types
           FROM automatenlager.v_warnings_open
          GROUP BY product_id, slot_assignment_id
       )
       SELECT sa.slot_assignment_id,
              l.location_key AS location_id,
              l.name AS location_name,
              m.machine_key AS machine_id,
              m.name AS machine_name,
              sa.mdb_code,
              p.product_id,
              p.name AS product_name,
              sa.current_machine_qty,
              sa.target_stock,
              sa.machine_capacity,
              COALESCE(s.qty, 0) AS qty,
              COALESCE(s.revenue_net, 0) AS revenue_net,
              COALESCE(s.db_net, 0) AS db_net,
              COALESCE(t.turnover_count, 0) AS turnover_count,
              COALESCE(iv.value_per_product, 0) AS value_per_product,
              bs.nearest_mhd_date,
              COALESCE(bs.mhd_risk_qty, 0) AS mhd_risk_qty,
              COALESCE(ws.warning_types, ARRAY[]::text[]) AS warning_types
         FROM automatenlager.slot_assignments sa
         JOIN automatenlager.products p ON p.product_id = sa.product_id
         JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
         JOIN automatenlager.locations l ON l.location_id = m.location_id
         LEFT JOIN sales s
           ON s.machine_id = sa.machine_id
          AND s.mdb_code = sa.mdb_code
          AND s.product_id = sa.product_id
         LEFT JOIN turnover t
           ON t.machine_id = sa.machine_id
          AND t.mdb_code = sa.mdb_code
         LEFT JOIN automatenlager.mv_inventory_value_daily iv ON iv.product_id = sa.product_id
         LEFT JOIN batch_status bs ON bs.product_id = sa.product_id
         LEFT JOIN warning_status ws
           ON ws.product_id = sa.product_id
          AND (ws.slot_assignment_id = sa.slot_assignment_id OR ws.slot_assignment_id IS NULL)
        WHERE sa.active = TRUE
          AND ($1 = '' OR l.location_key = $1 OR l.name ILIKE '%' || $1 || '%')
          AND ($2 = '' OR m.machine_key = $2 OR m.name ILIKE '%' || $2 || '%')
        ORDER BY l.name, m.name, sa.mdb_code`,
      [locationFilter, machineFilter, dateFrom, dateTo],
    );
    return { slots: result.rows };
  } finally {
    await client.end();
  }
}

module.exports = { buildAssortmentSlotsData, queryAssortmentSlotsPg };
