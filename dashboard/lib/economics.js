'use strict';

const VALID_SORT_FIELDS = new Set(['revenue_net', 'db_net', 'margin_pct', 'qty']);

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function marginPct(db, revenue) {
  return revenue > 0 ? round1((db / revenue) * 100) : 0;
}

function isBackfill(row) {
  return row.source === 'historic_backfill';
}

function formatProductName(name) {
  if (name == null) return null;
  if (/^SKU_[A-Z0-9_]+$/.test(name)) {
    return name
      .replace(/^SKU_/, '')
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return name;
}

function currentBerlinMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date()).slice(0, 7);
}

function resolvePeriod(query = {}) {
  const current = currentBerlinMonth();
  const validMonth = /^\d{4}-\d{2}$/;
  const from = validMonth.test(query.from || '') ? query.from : current;
  const to = validMonth.test(query.to || '') ? query.to : current;
  return { from, to };
}

function parseProductRow(row) {
  const revenue = round2(toNum(row.revenue_net));
  const db = round2(toNum(row.db_net));
  return {
    product_id: toNum(row.product_id),
    product_name: formatProductName(row.product_name) ?? String(toNum(row.product_id)),
    month: row.month,
    revenue_net: revenue,
    db_net: db,
    qty: toNum(row.qty),
    margin_pct: marginPct(db, revenue),
  };
}

function parseSlotRow(row) {
  return {
    machine_id: String(row.machine_id),
    mdb_code: toNum(row.mdb_code),
    month: row.month,
    revenue_net: round2(toNum(row.revenue_net)),
    db_net: round2(toNum(row.db_net)),
    qty: toNum(row.qty),
  };
}

function parseInventoryRow(row) {
  return {
    product_id: toNum(row.product_id),
    value_per_product: round2(toNum(row.value_per_product)),
    total_value: round2(toNum(row.total_value)),
  };
}

function sortRows(rows, sortBy, sortOrder) {
  const field = VALID_SORT_FIELDS.has(sortBy) ? sortBy : 'revenue_net';
  const dir = sortOrder === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[field] ?? 0;
    const bv = b[field] ?? 0;
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
}

function buildEconomicsData(pgRows, query = {}) {
  const sortBy = query.sort || 'revenue_net';
  const sortOrder = query.order === 'asc' ? 'asc' : 'desc';
  const machineFilter = query.machine || null;
  const period = resolvePeriod(query);

  const byProduct = sortRows(
    (pgRows.byProduct || []).filter((r) => !isBackfill(r)).map(parseProductRow),
    sortBy,
    sortOrder,
  );

  const bySlot = sortRows(
    (pgRows.bySlot || []).filter((r) => !isBackfill(r)).map(parseSlotRow),
    sortBy,
    sortOrder,
  );

  const inventoryValue = (pgRows.inventoryValue || []).map(parseInventoryRow);

  const totals = byProduct.reduce(
    (acc, r) => ({
      revenue_net: round2(acc.revenue_net + r.revenue_net),
      db_net: round2(acc.db_net + r.db_net),
      qty: acc.qty + r.qty,
    }),
    { revenue_net: 0, db_net: 0, qty: 0 },
  );

  return {
    byProduct,
    bySlot,
    inventoryValue,
    totals,
    period,
    sortBy,
    sortOrder,
    machineFilter,
  };
}

async function queryEconomicsPg(pgUrl, query = {}) {
  const { Client } = require('pg');
  const machineFilter = (query.machine || '').trim() || null;
  const { from, to } = resolvePeriod(query);
  const dateFrom = `${from}-01`;
  const dateTo = `${to}-01`;

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    let productRows, slotRows;

    if (machineFilter) {
      const [pr, sr] = await Promise.all([
        client.query(
          `SELECT g.product_id,
                  p.name                                     AS product_name,
                  date_trunc('month', g.posting_date)::DATE  AS month,
                  SUM(g.quantity_sold)::int                  AS qty,
                  SUM(g.revenue_net)                         AS revenue_net,
                  SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
             FROM automatenlager.guv_daily g
             LEFT JOIN automatenlager.products p ON p.product_id = g.product_id
            WHERE g.source != 'historic_backfill'
              AND g.machine_id = $1
              AND date_trunc('month', g.posting_date) >= $2::date
              AND date_trunc('month', g.posting_date) <= $3::date
            GROUP BY g.product_id, p.name, date_trunc('month', g.posting_date)::DATE`,
          [machineFilter, dateFrom, dateTo],
        ),
        client.query(
          `SELECT * FROM automatenlager.mv_db_per_slot_monthly
            WHERE machine_id = $1
              AND month >= $2::date
              AND month <= $3::date`,
          [machineFilter, dateFrom, dateTo],
        ),
      ]);
      productRows = pr.rows;
      slotRows = sr.rows;
    } else {
      const [pr, sr] = await Promise.all([
        client.query(
          `SELECT g.product_id,
                  p.name                                     AS product_name,
                  date_trunc('month', g.posting_date)::DATE  AS month,
                  SUM(g.quantity_sold)::int                  AS qty,
                  SUM(g.revenue_net)                         AS revenue_net,
                  SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
             FROM automatenlager.guv_daily g
             LEFT JOIN automatenlager.products p ON p.product_id = g.product_id
            WHERE g.source != 'historic_backfill'
              AND date_trunc('month', g.posting_date) >= $1::date
              AND date_trunc('month', g.posting_date) <= $2::date
            GROUP BY g.product_id, p.name, date_trunc('month', g.posting_date)::DATE`,
          [dateFrom, dateTo],
        ),
        client.query(
          `SELECT * FROM automatenlager.mv_db_per_slot_monthly
            WHERE month >= $1::date
              AND month <= $2::date`,
          [dateFrom, dateTo],
        ),
      ]);
      productRows = pr.rows;
      slotRows = sr.rows;
    }

    const inventoryResult = await client.query(
      `SELECT * FROM automatenlager.mv_inventory_value_daily`,
    );

    return {
      byProduct: productRows,
      bySlot: slotRows,
      inventoryValue: inventoryResult.rows,
    };
  } finally {
    await client.end();
  }
}

module.exports = { buildEconomicsData, queryEconomicsPg, resolvePeriod, formatProductName };

