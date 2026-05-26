const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { buildInventoryMhdData } = require('../lib/inventory-mhd.js');

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

const MHD_ROWS = [
  {
    batch_id: 11,
    batch_key: 'BATCH_LATE_WARNING',
    product_id: 2,
    product_name: 'Kitkat Chunky',
    mhd_date: '2026-06-20',
    remaining_qty: '9',
    warning_type: 'MHD_NEAR',
    warning_severity: 'warning',
    warning_message: 'MHD bald erreicht',
    machine_id: 'VM01',
    machine_name: 'Faltrix Mini',
    location_id: 'LOC1',
    location_name: 'Kantine',
    mdb_code: 12,
  },
  {
    batch_id: 10,
    batch_key: 'BATCH_EXPIRED',
    product_id: 1,
    product_name: 'Snickers',
    mhd_date: '2026-05-20',
    remaining_qty: '3',
    warning_type: 'MHD_EXPIRED',
    warning_severity: 'critical',
    warning_message: 'MHD überschritten',
    machine_id: 'VM01',
    machine_name: 'Faltrix Mini',
    location_id: 'LOC1',
    location_name: 'Kantine',
    mdb_code: 10,
  },
  {
    batch_id: 12,
    batch_key: 'BATCH_SOON_INFO',
    product_id: 3,
    product_name: 'Red Bull',
    mhd_date: '2026-05-28',
    remaining_qty: '6',
    warning_type: 'MHD_NEAR',
    warning_severity: 'info',
    warning_message: 'MHD in zwei Tagen',
    machine_id: 'VM01',
    machine_name: 'Faltrix Mini',
    location_id: 'LOC1',
    location_name: 'Kantine',
    mdb_code: 14,
  },
];

test('AC1: MHD risks are sorted by severity and nearest date by default', () => {
  const result = buildInventoryMhdData({ mhdRisks: MHD_ROWS, lowStock: [] }, {});

  assert.deepEqual(
    result.mhdRisks.map((row) => row.batch_key),
    ['BATCH_EXPIRED', 'BATCH_SOON_INFO', 'BATCH_LATE_WARNING'],
  );
  assert.deepEqual(
    result.mhdRisks.map((row) => row.severity),
    ['critical', 'info', 'warning'],
  );
  assert.equal(result.sortBy, 'mhd_date');
  assert.equal(result.sortOrder, 'asc');
});

test('AC2: low stock rows are sorted by urgency with understandable refill gap', () => {
  const lowStockRows = [
    {
      product_id: 2,
      product_name: 'Kitkat Chunky',
      current_machine_qty: '5',
      target_stock: '8',
      backstock_qty: '2',
      machine_id: 'VM01',
      machine_name: 'Faltrix Mini',
      location_id: 'LOC1',
      location_name: 'Kantine',
      mdb_code: 12,
    },
    {
      product_id: 1,
      product_name: 'Snickers',
      current_machine_qty: '1',
      target_stock: '10',
      backstock_qty: '12',
      machine_id: 'VM01',
      machine_name: 'Faltrix Mini',
      location_id: 'LOC1',
      location_name: 'Kantine',
      mdb_code: 10,
    },
    {
      product_id: 3,
      product_name: 'Red Bull',
      current_machine_qty: '0',
      target_stock: '4',
      backstock_qty: '0',
      machine_id: 'VM01',
      machine_name: 'Faltrix Mini',
      location_id: 'LOC1',
      location_name: 'Kantine',
      mdb_code: 14,
    },
  ];

  const result = buildInventoryMhdData({ mhdRisks: [], lowStock: lowStockRows }, {});

  assert.deepEqual(
    result.lowStock.map((row) => row.product_name),
    ['Snickers', 'Red Bull', 'Kitkat Chunky'],
  );
  assert.deepEqual(
    result.lowStock.map((row) => row.refill_gap),
    [9, 4, 3],
  );
  assert.equal(result.lowStock[1].urgency_label, 'leer, kein Backstock');
});

test('AC3: location and machine filters are applied to MHD and low-stock rows', () => {
  const result = buildInventoryMhdData(
    {
      mhdRisks: [
        ...MHD_ROWS,
        { ...MHD_ROWS[0], batch_key: 'OTHER_MACHINE', machine_id: 'VM02', location_id: 'LOC2' },
      ],
      lowStock: [
        {
          product_id: 1,
          product_name: 'Snickers',
          current_machine_qty: '1',
          target_stock: '10',
          backstock_qty: '12',
          machine_id: 'VM01',
          location_id: 'LOC1',
        },
        {
          product_id: 4,
          product_name: 'Bifi',
          current_machine_qty: '1',
          target_stock: '10',
          backstock_qty: '12',
          machine_id: 'VM02',
          location_id: 'LOC2',
        },
      ],
    },
    { location: 'LOC1', machine: 'VM01' },
  );

  assert.ok(result.mhdRisks.every((row) => row.location_id === 'LOC1' && row.machine_id === 'VM01'));
  assert.ok(result.lowStock.every((row) => row.location_id === 'LOC1' && row.machine_id === 'VM01'));
  assert.deepEqual(result.filters, { location: 'LOC1', machine: 'VM01' });
});

test('AC-HTTP: /api/v2/inventory-mhd returns PG_ERROR when connection fails', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const response = await request(port, '/api/v2/inventory-mhd?location=LOC1&machine=VM01');
  assert.equal(response.status, 503);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.area, 'inventory-mhd');
  assert.equal(body.source, 'postgres');
  assert.equal(body.error.code, 'PG_ERROR');
});

test('AC-UI: inventory panel exposes location and machine filters without action trigger buttons', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.html'), 'utf8');

  assert.match(html, /id="inventoryLocationFilter"/, 'missing location filter');
  assert.match(html, /id="inventoryMachineFilter"/, 'missing machine filter');
  assert.match(html, /id="inventoryMhdList"/, 'missing MHD list container');
  assert.match(html, /id="inventoryLowStockList"/, 'missing low-stock list container');
  assert.doesNotMatch(html, /api\/v2\/actions\/inventory/, 'inventory panel must not expose mutating action triggers');
});

test('AC-UI: v2.js fetches /api/v2/inventory-mhd with location and machine query params', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.js'), 'utf8');

  assert.match(js, /\/api\/v2\/inventory-mhd/, 'v2.js must fetch inventory-mhd endpoint');
  assert.match(js, /location=/, 'v2.js must include location param');
  assert.match(js, /machine=/, 'v2.js must include machine param');
});

test('AC-UI: mobile inventory uses compact list styling instead of horizontal tables', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.css'), 'utf8');

  assert.match(css, /\.v2-inventory-list/, 'missing compact inventory list style');
  assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.v2-inventory-row/, 'missing mobile inventory row rules');
});
