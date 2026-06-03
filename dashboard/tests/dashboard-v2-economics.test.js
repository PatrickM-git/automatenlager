const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { buildEconomicsData } = require('../lib/economics.js');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
      N8N_API_KEY: 'test-key',
      DASHBOARD_ADMIN_LOGIN: 'patrick@example.test',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

const PRODUCT_ROWS = [
  { product_id: 1, month: '2026-05-01', revenue_net: '120.50', db_net: '45.20', qty: '12' },
  { product_id: 2, month: '2026-05-01', revenue_net: '80.00', db_net: '10.00', qty: '8' },
];

const SLOT_ROWS = [
  { machine_id: 'VM01', mdb_code: 1, month: '2026-05-01', revenue_net: '80.00', db_net: '30.00', qty: '8' },
  { machine_id: 'VM01', mdb_code: 2, month: '2026-05-01', revenue_net: '40.50', db_net: '15.20', qty: '4' },
];

const INVENTORY_ROWS = [
  { product_id: 1, value_per_product: '55.00', total_value: '200.00' },
  { product_id: 2, value_per_product: '145.00', total_value: '200.00' },
];

test('AC1: byProduct exposes revenue_net, db_net, margin_pct and qty as numbers', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    {},
  );

  assert.equal(result.byProduct.length, 2);
  const row = result.byProduct[0];
  assert.equal(typeof row.product_id, 'number');
  assert.equal(typeof row.revenue_net, 'number');
  assert.equal(typeof row.db_net, 'number');
  assert.equal(typeof row.qty, 'number');
  assert.equal(typeof row.margin_pct, 'number');
});

test('AC1: bySlot exposes machine_id, mdb_code, revenue_net, db_net, qty', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    {},
  );

  assert.equal(result.bySlot.length, 2);
  const row = result.bySlot[0];
  assert.equal(typeof row.machine_id, 'string');
  assert.equal(typeof row.mdb_code, 'number');
  assert.equal(typeof row.revenue_net, 'number');
  assert.equal(typeof row.db_net, 'number');
  assert.equal(typeof row.qty, 'number');
});

test('AC1: inventoryValue exposes product_id, value_per_product, total_value as numbers', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    {},
  );

  assert.equal(result.inventoryValue.length, 2);
  const row = result.inventoryValue[0];
  assert.equal(typeof row.product_id, 'number');
  assert.equal(typeof row.value_per_product, 'number');
  assert.equal(typeof row.total_value, 'number');
});

test('AC1: totals aggregate revenue_net, db_net, qty across all products', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    {},
  );

  assert.equal(result.totals.revenue_net, 200.50);
  assert.equal(result.totals.db_net, 55.20);
  assert.equal(result.totals.qty, 20);
});

test('AC1: margin_pct is computed as db_net / revenue_net * 100, rounded to 1 decimal', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: [], inventoryValue: [] },
    {},
  );

  const p1 = result.byProduct.find((r) => r.product_id === 1);
  assert.equal(p1.margin_pct, 37.5);

  const p2 = result.byProduct.find((r) => r.product_id === 2);
  assert.equal(p2.margin_pct, 12.5);
});

test('AC2: byProduct is sorted by revenue_net descending by default', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    {},
  );

  assert.equal(result.byProduct[0].revenue_net, 120.50);
  assert.equal(result.byProduct[1].revenue_net, 80.00);
  assert.equal(result.sortBy, 'revenue_net');
  assert.equal(result.sortOrder, 'desc');
});

test('AC2: byProduct can be sorted by db_net ascending', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    { sort: 'db_net', order: 'asc' },
  );

  assert.equal(result.byProduct[0].db_net, 10.00);
  assert.equal(result.byProduct[1].db_net, 45.20);
  assert.equal(result.sortBy, 'db_net');
  assert.equal(result.sortOrder, 'asc');
});

test('AC2: byProduct can be sorted by margin_pct descending', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: [], inventoryValue: [] },
    { sort: 'margin_pct', order: 'desc' },
  );

  assert.equal(result.byProduct[0].margin_pct, 37.5);
  assert.equal(result.byProduct[1].margin_pct, 12.5);
  assert.equal(result.sortBy, 'margin_pct');
});

test('AC2: byProduct can be sorted by qty', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: [], inventoryValue: [] },
    { sort: 'qty', order: 'desc' },
  );

  assert.equal(result.byProduct[0].qty, 12);
  assert.equal(result.byProduct[1].qty, 8);
});

test('AC3: machine filter is reflected in result metadata', () => {
  // machineFilter ist seit der Standort-/Automaten-Mehrfachauswahl eine Liste.
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    { machine: 'VM01' },
  );

  assert.deepEqual(result.machineFilter, ['VM01']);
});

test('AC3: machines-Mehrfachauswahl landet als Liste in den Metadaten', () => {
  const result = buildEconomicsData(
    { byProduct: PRODUCT_ROWS, bySlot: SLOT_ROWS, inventoryValue: INVENTORY_ROWS },
    { machines: 'VM01,VM02' },
  );

  assert.deepEqual(result.machineFilter, ['VM01', 'VM02']);
});

test('AC5: historic_backfill rows are excluded from byProduct', () => {
  const rowsWithBackfill = [
    ...PRODUCT_ROWS,
    { product_id: 3, month: '2026-01-01', revenue_net: '999.00', db_net: '500.00', qty: '100', source: 'historic_backfill' },
  ];

  const result = buildEconomicsData(
    { byProduct: rowsWithBackfill, bySlot: [], inventoryValue: [] },
    {},
  );

  assert.equal(result.byProduct.length, 2);
  assert.ok(!result.byProduct.some((r) => r.product_id === 3));
});

test('AC5: historic_backfill rows are excluded from bySlot', () => {
  const rowsWithBackfill = [
    ...SLOT_ROWS,
    { machine_id: 'VM01', mdb_code: 9, month: '2026-01-01', revenue_net: '999.00', db_net: '500.00', qty: '50', source: 'historic_backfill' },
  ];

  const result = buildEconomicsData(
    { byProduct: [], bySlot: rowsWithBackfill, inventoryValue: [] },
    {},
  );

  assert.equal(result.bySlot.length, 2);
});

test('AC-HTTP: /api/v2/economics returns PG_ERROR when connection fails', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const response = await request(port, '/api/v2/economics');
  assert.equal(response.status, 503);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.area, 'economics');
  assert.equal(body.source, 'postgres');
  assert.equal(body.error.code, 'PG_ERROR');
});

test('AC-HTTP: /api/v2/economics response envelope matches v2 contract', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const response = await request(port, '/api/v2/economics');
  const body = response.json();
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.generatedAtDisplay, /\bMESZ\b|\bMEZ\b/);
  assert.equal(body.data, null);
});

// ── UI structure tests (static file checks) ─────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');

// ── Issue #38: Produktnamen, Zeitfilter, Zeitraum-Label ──────────────────────

test('AC-Name: parseProductRow propagates product_name from DB row', () => {
  const rows = [
    { product_id: 7, product_name: 'Snickers', month: '2026-05-01', revenue_net: '10.00', db_net: '4.00', qty: '5' },
  ];
  const result = buildEconomicsData({ byProduct: rows, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.byProduct[0].product_name, 'Snickers');
});

test('AC-Name: parseProductRow falls back to product_id string when product_name is absent', () => {
  const rows = [
    { product_id: 42, month: '2026-05-01', revenue_net: '10.00', db_net: '4.00', qty: '3' },
  ];
  const result = buildEconomicsData({ byProduct: rows, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.byProduct[0].product_name, '42');
});

test('AC-Name: SKU-coded product_name gets formatted for display (strip prefix, title case)', () => {
  const rows = [
    { product_id: 3, product_name: 'SKU_SNICKERS', month: '2026-05-01', revenue_net: '10.00', db_net: '4.00', qty: '5' },
    { product_id: 4, product_name: 'SKU_7_DAYS_CROISSANT', month: '2026-05-01', revenue_net: '8.00', db_net: '3.00', qty: '4' },
    { product_id: 5, product_name: 'SKU_KITKAT_CHUNKY', month: '2026-05-01', revenue_net: '6.00', db_net: '2.00', qty: '3' },
  ];
  const result = buildEconomicsData({ byProduct: rows, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.byProduct.find((r) => r.product_id === 3).product_name, 'Snickers');
  assert.equal(result.byProduct.find((r) => r.product_id === 4).product_name, '7 Days Croissant');
  assert.equal(result.byProduct.find((r) => r.product_id === 5).product_name, 'Kitkat Chunky');
});

test('AC-Name: non-SKU product_name is kept unchanged', () => {
  const rows = [
    { product_id: 6, product_name: 'Red Bull', month: '2026-05-01', revenue_net: '10.00', db_net: '4.00', qty: '5' },
  ];
  const result = buildEconomicsData({ byProduct: rows, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.byProduct[0].product_name, 'Red Bull');
});

test('AC-Period: buildEconomicsData result includes period with from and to', () => {
  const result = buildEconomicsData(
    { byProduct: [], bySlot: [], inventoryValue: [] },
    { from: '2026-04', to: '2026-05' },
  );
  assert.deepEqual(result.period, { from: '2026-04', to: '2026-05' });
});

test('AC-Period: buildEconomicsData defaults period to current YYYY-MM when query is empty', () => {
  const result = buildEconomicsData({ byProduct: [], bySlot: [], inventoryValue: [] }, {});
  assert.ok(result.period, 'period must exist');
  assert.match(result.period.from, /^\d{4}-\d{2}$/, 'from must be YYYY-MM');
  assert.match(result.period.to, /^\d{4}-\d{2}$/, 'to must be YYYY-MM');
  assert.equal(result.period.from, result.period.to, 'default from and to must be the same month');
});

test('AC-Period: buildEconomicsData ignores invalid from/to and uses current month', () => {
  const result = buildEconomicsData(
    { byProduct: [], bySlot: [], inventoryValue: [] },
    { from: 'not-a-month', to: '' },
  );
  assert.match(result.period.from, /^\d{4}-\d{2}$/);
  assert.match(result.period.to, /^\d{4}-\d{2}$/);
});

// ── Issue #53: Brutto-Anzeige (wie altes Dashboard) ──────────────────────────

const GROSS_ROWS = [
  { product_id: 1, month: '2026-05-01', revenue_net: '100.00', revenue_gross: '107.00', gross_profit: '40.00', db_net: '37.38', qty: '10' },
  { product_id: 2, month: '2026-05-01', revenue_net: '50.00', revenue_gross: '53.50', gross_profit: '15.00', db_net: '14.02', qty: '5' },
];

test('AC53: byProduct exposes revenue_gross and gross_profit as numbers', () => {
  const result = buildEconomicsData({ byProduct: GROSS_ROWS, bySlot: [], inventoryValue: [] }, {});
  const row = result.byProduct[0];
  assert.equal(row.revenue_gross, 107.00);
  assert.equal(row.gross_profit, 40.00);
  assert.equal(typeof row.margin_gross_pct, 'number');
});

test('AC53: totals aggregate revenue_gross and gross_profit across products', () => {
  const result = buildEconomicsData({ byProduct: GROSS_ROWS, bySlot: [], inventoryValue: [] }, {});
  assert.equal(result.totals.revenue_gross, 160.50);
  assert.equal(result.totals.gross_profit, 55.00);
});

test('AC53: bySlot exposes revenue_gross and gross_profit', () => {
  const slotGross = [
    { machine_id: 'VM01', mdb_code: 1, month: '2026-05-01', revenue_net: '80.00', revenue_gross: '85.60', gross_profit: '30.00', db_net: '28.04', qty: '8' },
  ];
  const result = buildEconomicsData({ byProduct: [], bySlot: slotGross, inventoryValue: [] }, {});
  assert.equal(result.bySlot[0].revenue_gross, 85.60);
  assert.equal(result.bySlot[0].gross_profit, 30.00);
});
