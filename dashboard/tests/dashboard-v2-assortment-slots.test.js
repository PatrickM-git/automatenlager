const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { buildAssortmentSlotsData } = require('../lib/assortment-slots.js');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
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
      if (String(chunk).includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.resume();
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Exit ${code}`));
      }
    });
  });
}

const SLOT_ROWS = [
  {
    slot_assignment_id: 10,
    location_id: 'LOC1',
    location_name: 'Kantine',
    machine_id: 'VM01',
    machine_name: 'Faltrix Mini',
    mdb_code: 11,
    product_id: 1,
    product_name: 'Snickers',
    current_machine_qty: '2',
    target_stock: '10',
    machine_capacity: '12',
    qty: '42',
    revenue_net: '96.00',
    db_net: '44.00',
    turnover_count: '31',
    value_per_product: '18.50',
    nearest_mhd_date: '2026-06-08',
    mhd_risk_qty: '4',
    warning_types: ['LOW_BATCH'],
  },
  {
    slot_assignment_id: 11,
    location_id: 'LOC2',
    location_name: 'Werkstatt',
    machine_id: 'VM02',
    machine_name: 'Nebenautomat',
    mdb_code: 12,
    product_id: 2,
    product_name: 'Proteinriegel',
    current_machine_qty: '9',
    target_stock: '9',
    machine_capacity: '12',
    qty: '1',
    revenue_net: '3.00',
    db_net: '0.30',
    turnover_count: '1',
    value_per_product: '88.00',
    nearest_mhd_date: null,
    mhd_risk_qty: '0',
    warning_types: [],
  },
];

test('AC1: assortment slots expose transparent indicators from KPI and stock data', () => {
  const result = buildAssortmentSlotsData({ slots: SLOT_ROWS }, {});
  const slot = result.slots.find((row) => row.product_name === 'Snickers');

  assert.ok(slot.indicators.some((item) => item.code === 'runner' && item.source === 'kpi'));
  assert.ok(slot.indicators.some((item) => item.code === 'db_strong' && item.source === 'kpi'));
  assert.ok(slot.indicators.some((item) => item.code === 'refill_need' && item.source === 'stock'));
  assert.ok(slot.indicators.some((item) => item.code === 'mhd_risk' && item.source === 'stock'));
});

test('AC2: indicators are explicitly separate from recommendations', () => {
  const result = buildAssortmentSlotsData({ slots: SLOT_ROWS }, {});
  const allIndicators = result.slots.flatMap((slot) => slot.indicators);

  assert.ok(allIndicators.length > 0);
  assert.ok(allIndicators.every((item) => item.isRecommendation === false));
  assert.ok(allIndicators.every((item) => !('action' in item)));
  assert.equal(result.recommendations.length, 0);
});

test('AC3: location and machine filters are applied to assortment slots', () => {
  const result = buildAssortmentSlotsData(
    { slots: SLOT_ROWS },
    { location: 'LOC1', machine: 'VM01' },
  );

  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].location_id, 'LOC1');
  assert.equal(result.slots[0].machine_id, 'VM01');
  assert.deepEqual(result.filters, { location: 'LOC1', machine: 'VM01' });
});

test('AC4: current slot occupancy is visible and understandable', () => {
  const result = buildAssortmentSlotsData({ slots: SLOT_ROWS }, {});
  const slot = result.slots.find((row) => row.product_name === 'Snickers');

  assert.deepEqual(slot.occupancy, {
    current_machine_qty: 2,
    target_stock: 10,
    machine_capacity: 12,
    fill_pct: 17,
    label: '2 / 12 im Slot',
  });
});

test('AC-machine-ref: slot exposes internal machine_ref (sa.machine_id) for write operations', () => {
  // Die Anzeige nutzt machine_id (= machine_key), Schreib-/Refill-Endpunkte
  // brauchen aber die interne sa.machine_id. Diese muss als machine_ref
  // zusätzlich durchgereicht werden.
  const rows = [{
    slot_assignment_id: 47,
    machine_id: '457107528', // machine_key (Anzeige)
    machine_ref: '1',        // interne sa.machine_id (für Writes)
    machine_name: 'Snackautomat',
    location_name: 'Standort',
    mdb_code: 10,
    product_id: 66,
    product_name: 'Pick Up',
    current_machine_qty: '12',
    machine_capacity: '12',
  }];
  const result = buildAssortmentSlotsData({ slots: rows }, {});
  assert.equal(result.slots[0].machine_id, '457107528');
  assert.equal(result.slots[0].machine_ref, '1');
});

test('AC-HTTP: /api/v2/assortment-slots returns PG_ERROR when connection fails', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const response = await request(port, '/api/v2/assortment-slots?location=LOC1&machine=VM01');
  assert.equal(response.status, 503);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.area, 'assortment-slots');
  assert.equal(body.source, 'postgres');
  assert.equal(body.error.code, 'PG_ERROR');
});

test('AC-UI: assortment panel exposes location and machine filters plus slot list containers', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.html'), 'utf8');

  assert.match(html, /id="assortmentLocationFilter"/, 'missing location filter');
  assert.match(html, /id="assortmentMachineFilter"/, 'missing machine filter');
  assert.match(html, /id="assortmentSlotList"/, 'missing slot list');
  assert.match(html, /id="assortmentIndicatorLegend"/, 'missing indicator legend');
  assert.doesNotMatch(html, /api\/v2\/actions\/assortment/, 'assortment panel must not expose mutating action triggers');
});

test('AC-UI: v2.js fetches /api/v2/assortment-slots with location and machine query params', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.js'), 'utf8');

  assert.match(js, /\/api\/v2\/assortment-slots/, 'v2.js must fetch assortment endpoint');
  assert.match(js, /location=/, 'v2.js must include location param');
  assert.match(js, /machine=/, 'v2.js must include machine param');
  assert.match(js, /indicators/, 'v2.js must render indicator data');
});

test('AC-UI: v2.css defines compact assortment and indicator styles', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.css'), 'utf8');

  assert.match(css, /\.v2-assortment-list/, 'missing assortment list style');
  assert.match(css, /\.v2-indicator-chip/, 'missing indicator chip style');
  assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.v2-assortment-row/, 'missing mobile assortment row rules');
});
