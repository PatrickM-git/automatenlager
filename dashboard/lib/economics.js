'use strict';

const VALID_SORT_FIELDS = new Set(['revenue_net', 'db_net', 'margin_pct', 'qty', 'revenue_gross', 'gross_profit', 'margin_gross_pct']);

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

// Robuster Monatsschlüssel 'YYYY-MM'. PostgreSQL liefert date_trunc('month')::DATE
// als Berlin-Mitternacht, das JSON-serialisiert als UTC-Vortag erscheint
// (z. B. '2026-04-30T22:00:00.000Z' = Mai). Reine 'YYYY-MM[-DD]'-Strings ohne
// Zeitanteil werden direkt zugeschnitten; alles mit Zeit wird in Europe/Berlin
// interpretiert, damit der fachliche Monat stimmt.
function monthKeyBerlin(value) {
  if (value == null) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value) && value.indexOf('T') === -1) {
    return value.slice(0, 7);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).format(d).slice(0, 7);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function resolvePeriod(query = {}) {
  const current = currentBerlinMonth();
  const validMonth = /^\d{4}-\d{2}$/;
  const year = parseInt(query.year, 10);

  if (query.mode === 'quarter' && Number.isInteger(year)) {
    const q = parseInt(query.quarter, 10);
    if (q >= 1 && q <= 4) {
      const startMonth = (q - 1) * 3 + 1;
      return { from: `${year}-${pad2(startMonth)}`, to: `${year}-${pad2(startMonth + 2)}` };
    }
  }

  if (query.mode === 'year' && Number.isInteger(year)) {
    return { from: `${year}-01`, to: `${year}-12` };
  }

  const from = validMonth.test(query.from || '') ? query.from : current;
  const to = validMonth.test(query.to || '') ? query.to : current;
  return { from, to };
}

function parseProductRow(row) {
  const revenue = round2(toNum(row.revenue_net));
  const db = round2(toNum(row.db_net));
  const revenueGross = round2(toNum(row.revenue_gross));
  const dbGross = round2(toNum(row.gross_profit));
  return {
    product_id: toNum(row.product_id),
    product_name: formatProductName(row.product_name) ?? String(toNum(row.product_id)),
    month: row.month,
    revenue_net: revenue,
    db_net: db,
    revenue_gross: revenueGross,
    gross_profit: dbGross,
    qty: toNum(row.qty),
    margin_pct: marginPct(db, revenue),
    margin_gross_pct: marginPct(dbGross, revenueGross),
  };
}

function parseSlotRow(row) {
  return {
    machine_id: String(row.machine_id),
    mdb_code: toNum(row.mdb_code),
    month: row.month,
    revenue_net: round2(toNum(row.revenue_net)),
    db_net: round2(toNum(row.db_net)),
    revenue_gross: round2(toNum(row.revenue_gross)),
    gross_profit: round2(toNum(row.gross_profit)),
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

const VALID_MODES = new Set(['month', 'quarter', 'year', 'custom']);

// Verdichtet die (bereits geparsten) Produktzeilen zu einer Monats-Zeitreihe
// für die Diagramme – aufsteigend nach Monat, je Monat brutto/netto + Marge.
function buildSeries(productRows) {
  const byMonth = new Map();
  for (const r of productRows) {
    const month = monthKeyBerlin(r.month);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const acc = byMonth.get(month) ||
      { month, revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 };
    acc.revenue_net += r.revenue_net;
    acc.db_net += r.db_net;
    acc.revenue_gross += r.revenue_gross;
    acc.gross_profit += r.gross_profit;
    acc.qty += r.qty;
    byMonth.set(month, acc);
  }
  return [...byMonth.values()]
    .map((m) => ({
      month: m.month,
      revenue_net: round2(m.revenue_net),
      db_net: round2(m.db_net),
      revenue_gross: round2(m.revenue_gross),
      gross_profit: round2(m.gross_profit),
      qty: m.qty,
      margin_pct: marginPct(m.db_net, m.revenue_net),
      margin_gross_pct: marginPct(m.gross_profit, m.revenue_gross),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

function buildEconomicsData(pgRows, query = {}) {
  const sortBy = query.sort || 'revenue_net';
  const sortOrder = query.order === 'asc' ? 'asc' : 'desc';
  const machineFilter = query.machine || null;
  const mode = VALID_MODES.has(query.mode) ? query.mode : 'month';
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
      revenue_gross: round2(acc.revenue_gross + r.revenue_gross),
      gross_profit: round2(acc.gross_profit + r.gross_profit),
      qty: acc.qty + r.qty,
    }),
    { revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 },
  );

  const series = buildSeries(byProduct);

  return {
    byProduct,
    bySlot,
    inventoryValue,
    totals,
    series,
    period,
    mode,
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
                  SUM(g.revenue_gross)                       AS revenue_gross,
                  SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
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
          `SELECT g.machine_id,
                  g.mdb_code,
                  date_trunc('month', g.posting_date)::DATE  AS month,
                  SUM(g.quantity_sold)::int                  AS qty,
                  SUM(g.revenue_net)                         AS revenue_net,
                  SUM(g.revenue_gross)                       AS revenue_gross,
                  SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
                  SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
             FROM automatenlager.guv_daily g
            WHERE g.source != 'historic_backfill'
              AND g.machine_id = $1
              AND date_trunc('month', g.posting_date) >= $2::date
              AND date_trunc('month', g.posting_date) <= $3::date
            GROUP BY g.machine_id, g.mdb_code, date_trunc('month', g.posting_date)::DATE`,
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
                  SUM(g.revenue_gross)                       AS revenue_gross,
                  SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
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
          `SELECT g.machine_id,
                  g.mdb_code,
                  date_trunc('month', g.posting_date)::DATE  AS month,
                  SUM(g.quantity_sold)::int                  AS qty,
                  SUM(g.revenue_net)                         AS revenue_net,
                  SUM(g.revenue_gross)                       AS revenue_gross,
                  SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
                  SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
             FROM automatenlager.guv_daily g
            WHERE g.source != 'historic_backfill'
              AND date_trunc('month', g.posting_date) >= $1::date
              AND date_trunc('month', g.posting_date) <= $2::date
            GROUP BY g.machine_id, g.mdb_code, date_trunc('month', g.posting_date)::DATE`,
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

