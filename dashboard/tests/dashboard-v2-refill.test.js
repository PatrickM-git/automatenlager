'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { searchRefillTargets, buildRefillDetails, validateRefillQty, buildRefillAuditEntry } = require('../lib/refill.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET';
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: opts.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
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
      DASHBOARD_V2_PG_URL: '',
      DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
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
      if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); }
    });
  });
}

// ── AC6: Read-Only 403 ────────────────────────────────────────────────────────

test('AC6: POST /api/v2/refill/trigger returns 403 for guest user', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/refill/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'tailscale-user-login': 'freund@example.test',
      },
      body: JSON.stringify({ machine_id: 'VM01', mdb_code: 1, product_id: 1, qty: 5 }),
    });
    assert.equal(res.status, 403);
    const body = res.json();
    assert.equal(body.ok, false);
  } finally {
    child.kill();
  }
});

// ── AC1: searchRefillTargets ──────────────────────────────────────────────────

const SLOT_ROWS = [
  { machine_id: 'VM01', machine_label: 'Automat 1', mdb_code: 1, product_id: 10, product_name: 'Snickers', location_name: 'Büro A', current_machine_qty: 5, target_stock: 10, capacity: 12 },
  { machine_id: 'VM01', machine_label: 'Automat 1', mdb_code: 2, product_id: 11, product_name: 'Haribo Goldbären', location_name: 'Büro A', current_machine_qty: 0, target_stock: 8, capacity: 10 },
  { machine_id: 'VM02', machine_label: 'Automat 2', mdb_code: 5, product_id: 12, product_name: 'Bueno', location_name: 'Büro B', current_machine_qty: 3, target_stock: 6, capacity: 8 },
];

test('AC1: searchRefillTargets matches by product name (case-insensitive)', () => {
  const results = searchRefillTargets('snick', SLOT_ROWS);
  assert.equal(results.length, 1);
  assert.equal(results[0].product_name, 'Snickers');
});

test('AC1: searchRefillTargets matches by machine_id', () => {
  const results = searchRefillTargets('VM02', SLOT_ROWS);
  assert.equal(results.length, 1);
  assert.equal(results[0].machine_id, 'VM02');
});

test('AC1: searchRefillTargets matches by MDB code (string)', () => {
  const results = searchRefillTargets('2', SLOT_ROWS);
  const mdbMatch = results.find((r) => r.mdb_code === 2);
  assert.ok(mdbMatch, 'Should find slot with MDB code 2');
});

test('AC1: searchRefillTargets returns empty array for no match', () => {
  const results = searchRefillTargets('DOES_NOT_EXIST_XYZ', SLOT_ROWS);
  assert.equal(results.length, 0);
});

test('AC1: searchRefillTargets returns all slots for empty query', () => {
  const results = searchRefillTargets('', SLOT_ROWS);
  assert.equal(results.length, SLOT_ROWS.length);
});

// ── AC2: buildRefillDetails ───────────────────────────────────────────────────

const TODAY = new Date('2026-05-27');

const BATCH_ROWS = [
  { batch_key: 'B1', product_id: 10, remaining_qty: 6, mhd_date: '2026-06-10', status: 'active', unit_cost_net: '0.50' },
  { batch_key: 'B2', product_id: 10, remaining_qty: 2, mhd_date: '2026-05-30', status: 'active', unit_cost_net: '0.50' },
  { batch_key: 'B3', product_id: 10, remaining_qty: 4, mhd_date: null, status: 'active', unit_cost_net: '0.50' },
];

test('AC2: buildRefillDetails returns slot info with free_capacity', () => {
  const result = buildRefillDetails(SLOT_ROWS[0], BATCH_ROWS, TODAY);
  assert.equal(result.slot.current_machine_qty, 5);
  assert.equal(result.slot.capacity, 12);
  assert.equal(result.slot.free_capacity, 7);
});

test('AC2: buildRefillDetails liefert Lager-Backstock im Gesamt-Modell (#36)', () => {
  // remaining_qty führt den Gesamtbestand (Maschine+Lager). Backstock =
  // GREATEST(SUM(remaining) − current_machine_qty, 0). 6+2+4=12, Maschine 5 → 7.
  const result = buildRefillDetails(SLOT_ROWS[0], BATCH_ROWS, TODAY);
  assert.equal(result.backstock.total_qty, 7);
  assert.equal(result.backstock.batches_count, 3);
});

test('AC1/#36: Backstock zieht Maschinen-Bestand ab und wird nie negativ', () => {
  const batches = [{ batch_key: 'G1', product_id: 10, remaining_qty: 30, mhd_date: null, status: 'active', unit_cost_net: '0.50' }];
  // Maschine 10 von 30 gesamt → 20 im Lager.
  assert.equal(buildRefillDetails({ ...SLOT_ROWS[0], current_machine_qty: 10 }, batches, TODAY).backstock.total_qty, 20);
  // Maschine >= Gesamt → 0 (kein negativer Backstock).
  assert.equal(buildRefillDetails({ ...SLOT_ROWS[0], current_machine_qty: 40 }, batches, TODAY).backstock.total_qty, 0);
  // Maschine 0 → ganzer Gesamtbestand ist Lager.
  assert.equal(buildRefillDetails({ ...SLOT_ROWS[0], current_machine_qty: 0 }, batches, TODAY).backstock.total_qty, 30);
});

// Regression Pick-Up-Drift (Session 31): 'reserve'-Chargen sind echter Bestand
// und muessen mitgezaehlt werden. Vorher filterte refill nur 'aktiv'/'active' →
// 22 Stk. Pick Up erschienen faelschlich als Backstock 0.
test('AC2: buildRefillDetails zaehlt reserve-Chargen als Backstock', () => {
  const reserveBatch = [
    { batch_key: 'B_PICK_UP', product_id: 66, remaining_qty: 22, mhd_date: '2026-09-01', status: 'reserve', unit_cost_net: '0.50' },
  ];
  // current_machine_qty:0 isoliert hier bewusst das Zähl-Verhalten (reserve zählt),
  // unabhängig vom Maschinen-Abzug des Gesamt-Modells.
  const slot = { ...SLOT_ROWS[0], product_id: 66, product_name: 'Pick Up', current_machine_qty: 0 };
  const result = buildRefillDetails(slot, reserveBatch, TODAY);
  assert.equal(result.backstock.total_qty, 22);
  assert.equal(result.backstock.batches_count, 1);
});

// Gegenprobe: ausgesonderte/leere Chargen bleiben unsichtbar.
test('AC2: buildRefillDetails ignoriert ausgesondert/leer', () => {
  const batches = [
    { batch_key: 'X1', product_id: 10, remaining_qty: 9, mhd_date: null, status: 'ausgesondert', unit_cost_net: '0.50' },
    { batch_key: 'X2', product_id: 10, remaining_qty: 0, mhd_date: null, status: 'leer', unit_cost_net: '0.50' },
    { batch_key: 'X3', product_id: 10, remaining_qty: 3, mhd_date: null, status: 'aktiv', unit_cost_net: '0.50' },
  ];
  // current_machine_qty:0 isoliert das Status-Filtern (nur 'aktiv' zählt),
  // unabhängig vom Maschinen-Abzug des Gesamt-Modells.
  const result = buildRefillDetails({ ...SLOT_ROWS[0], current_machine_qty: 0 }, batches, TODAY);
  assert.equal(result.backstock.total_qty, 3);
  assert.equal(result.backstock.batches_count, 1);
});

test('AC2: buildRefillDetails lists only batches with mhd_date in mhd_batches with days_until_mhd', () => {
  const result = buildRefillDetails(SLOT_ROWS[0], BATCH_ROWS, TODAY);
  assert.equal(result.mhd_batches.length, 2); // only B1 and B2 have mhd_date
  const b2 = result.mhd_batches.find((b) => b.batch_key === 'B2');
  assert.ok(b2, 'B2 should be in mhd_batches');
  assert.equal(b2.days_until_mhd, 3); // 2026-05-30 - 2026-05-27 = 3 days
});

test('AC2: buildRefillDetails sorts mhd_batches by mhd_date ascending', () => {
  const result = buildRefillDetails(SLOT_ROWS[0], BATCH_ROWS, TODAY);
  const dates = result.mhd_batches.map((b) => b.mhd_date);
  assert.deepEqual(dates, [...dates].sort());
});

// ── AC3: validateRefillQty ────────────────────────────────────────────────────

function makeDetails(currentQty, capacity, backstockQty) {
  return {
    slot: { current_machine_qty: currentQty, capacity, target_stock: capacity, free_capacity: capacity - currentQty },
    backstock: { total_qty: backstockQty, batches_count: backstockQty > 0 ? 1 : 0 },
    mhd_batches: [],
  };
}

test('AC3: validateRefillQty returns valid for reasonable qty', () => {
  const result = validateRefillQty(makeDetails(3, 10, 8), 5);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('AC3: validateRefillQty returns error for qty <= 0', () => {
  const result = validateRefillQty(makeDetails(3, 10, 8), 0);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('AC3: validateRefillQty returns warning when qty exceeds free capacity', () => {
  const result = validateRefillQty(makeDetails(8, 10, 15), 5);
  assert.equal(result.valid, true); // not blocking
  assert.ok(result.warnings.some((w) => /kapazit/i.test(w)), 'Should warn about capacity');
});

test('AC3: validateRefillQty returns warning when backstock is zero', () => {
  const result = validateRefillQty(makeDetails(3, 10, 0), 3);
  assert.equal(result.valid, true); // not blocking
  assert.ok(result.warnings.some((w) => /backstock/i.test(w)), 'Should warn about no backstock');
});

test('AC3: validateRefillQty returns warning when qty exceeds available backstock', () => {
  const result = validateRefillQty(makeDetails(3, 10, 4), 6);
  assert.equal(result.valid, true); // not blocking
  assert.ok(result.warnings.some((w) => /backstock/i.test(w)), 'Should warn about exceeding backstock');
});

// ── AC5: buildRefillAuditEntry ────────────────────────────────────────────────

test('AC5: buildRefillAuditEntry contains required fields', () => {
  const viewer = { login: 'admin@example.test', role: 'admin' };
  const input = { machine_id: 'VM01', mdb_code: 1, product_id: 10, qty: 5 };
  const result_data = { ok: true, status_ref: 'wf7-run-123' };
  const entry = buildRefillAuditEntry(viewer, input, result_data);

  assert.ok(entry.timestamp, 'timestamp required');
  assert.equal(entry.actor, viewer.login);
  assert.equal(entry.action, 'refill_trigger');
  assert.deepEqual(entry.input, input);
  assert.deepEqual(entry.result, result_data);
  assert.ok('status_ref' in entry, 'status_ref required');
});

test('AC5: buildRefillAuditEntry timestamp is ISO 8601', () => {
  const viewer = { login: 'admin@example.test', role: 'admin' };
  const entry = buildRefillAuditEntry(viewer, {}, {});
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry.timestamp), 'ISO timestamp expected');
});

// ── AC1 HTTP: GET /api/v2/refill/search ──────────────────────────────────────

test('AC1 HTTP: GET /api/v2/refill/search returns 200 with results array', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {
    DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
    DASHBOARD_V2_PG_URL: '',
  });
  try {
    const res = await request(port, '/api/v2/refill/search?q=a', {
      headers: { 'tailscale-user-login': 'admin@example.test' },
    });
    assert.ok([200, 503].includes(res.status), `Expected 200 or 503, got ${res.status}`);
    if (res.status === 200) {
      const body = res.json();
      assert.ok(Array.isArray(body.results), 'results must be an array');
    }
  } finally {
    child.kill();
  }
});

// ── AC2 HTTP: GET /api/v2/refill/details ─────────────────────────────────────

test('AC2 HTTP: GET /api/v2/refill/details returns 200 or 503 (no PG in test)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {
    DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
    DASHBOARD_V2_PG_URL: '',
  });
  try {
    const res = await request(port, '/api/v2/refill/details?machine_id=VM01&mdb_code=1', {
      headers: { 'tailscale-user-login': 'admin@example.test' },
    });
    assert.ok([200, 404, 503].includes(res.status), `Expected 200/404/503, got ${res.status}`);
  } finally {
    child.kill();
  }
});

// ── AC4: POST /api/v2/refill/trigger (admin) ─────────────────────────────────

test('AC4: POST /api/v2/refill/trigger as admin does not return 403', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/refill/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'tailscale-user-login': 'admin@example.test',
      },
      body: JSON.stringify({ machine_id: 'VM01', mdb_code: 1, product_id: 10, qty: 5 }),
    });
    assert.notEqual(res.status, 403, 'Admin must not receive 403');
  } finally {
    child.kill();
  }
});
