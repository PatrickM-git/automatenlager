'use strict';

const assert = require('node:assert/strict');
const http   = require('node:http');
const { spawn } = require('node:child_process');
const test   = require('node:test');

const {
  buildSlotAssignPreview,
  validateSlotAssign,
  buildSlotAssignPayload,
  buildSlotAssignAuditEntry,
} = require('../lib/slot-assign-inline.js');

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
      DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
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

// ── fixtures ──────────────────────────────────────────────────────────────────

const PRODUCT_ROW = {
  product_id:  42,
  product_key: 'SKU_SNICKERS',
  name:        'Snickers',
};

const MACHINES = [
  { machine_id: 'VM01', label: 'EG · Snack · links', area: 'EG' },
  { machine_id: 'VM02', label: 'EG · Getränke · rechts', area: 'EG' },
];

// ═════════════════════════════════════════════════════════════════════════════
// AC1: buildSlotAssignPreview – Produkt + Maschinen-Liste
// ═════════════════════════════════════════════════════════════════════════════

test('AC1: buildSlotAssignPreview returns product info', () => {
  const result = buildSlotAssignPreview(PRODUCT_ROW, MACHINES);
  assert.equal(result.product.product_id,  42);
  assert.equal(result.product.name,        'Snickers');
  assert.equal(result.product.product_key, 'SKU_SNICKERS');
});

test('AC1: buildSlotAssignPreview returns machines list', () => {
  const result = buildSlotAssignPreview(PRODUCT_ROW, MACHINES);
  assert.equal(result.machines.length, 2);
  assert.equal(result.machines[0].machine_id, 'VM01');
  assert.equal(result.machines[0].label,      'EG · Snack · links');
  assert.equal(result.machines[0].area,       'EG');
});

test('AC1: buildSlotAssignPreview handles empty machines list', () => {
  const result = buildSlotAssignPreview(PRODUCT_ROW, []);
  assert.deepEqual(result.machines, []);
  assert.equal(result.product.product_id, 42);
});

// ═════════════════════════════════════════════════════════════════════════════
// AC2: validateSlotAssign – Pflichtfelder + Regeln
// ═════════════════════════════════════════════════════════════════════════════

test('AC2: validateSlotAssign accepts valid params', () => {
  const result = validateSlotAssign({ machine_id: 'VM01', mdb_code: 5, qty: 10, start_date: '2026-06-01' });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('AC2: validateSlotAssign accepts zero qty', () => {
  const result = validateSlotAssign({ machine_id: 'VM01', mdb_code: 5, qty: 0, start_date: '2026-06-01' });
  assert.equal(result.valid, true);
});

test('AC2: validateSlotAssign rejects missing machine_id', () => {
  const result = validateSlotAssign({ mdb_code: 5, qty: 10, start_date: '2026-06-01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'machine_id'));
});

test('AC2: validateSlotAssign rejects missing mdb_code', () => {
  const result = validateSlotAssign({ machine_id: 'VM01', qty: 10, start_date: '2026-06-01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'mdb_code'));
});

test('AC2: validateSlotAssign rejects missing qty', () => {
  const result = validateSlotAssign({ machine_id: 'VM01', mdb_code: 5, start_date: '2026-06-01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'qty'));
});

test('AC2: validateSlotAssign rejects negative qty', () => {
  const result = validateSlotAssign({ machine_id: 'VM01', mdb_code: 5, qty: -1, start_date: '2026-06-01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'qty'));
});

test('AC2: validateSlotAssign rejects missing start_date', () => {
  const result = validateSlotAssign({ machine_id: 'VM01', mdb_code: 5, qty: 0 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'start_date'));
});

// ═════════════════════════════════════════════════════════════════════════════
// AC3: buildSlotAssignPayload – idempotenter assign_key
// ═════════════════════════════════════════════════════════════════════════════

test('AC3: buildSlotAssignPayload returns idempotent assign_key', () => {
  const params = { machine_id: 'VM01', mdb_code: 5, qty: 10, start_date: '2026-06-01' };
  const p1 = buildSlotAssignPayload(PRODUCT_ROW, params);
  const p2 = buildSlotAssignPayload(PRODUCT_ROW, params);
  assert.ok(typeof p1.assign_key === 'string' && p1.assign_key.length > 0);
  assert.equal(p1.assign_key, p2.assign_key, 'gleiche Eingaben → gleicher Key');
});

test('AC3: buildSlotAssignPayload assign_key encodes product + machine + mdb', () => {
  const payload = buildSlotAssignPayload(PRODUCT_ROW, { machine_id: 'VM01', mdb_code: 5, qty: 10, start_date: '2026-06-01' });
  assert.ok(payload.assign_key.includes('42'),   'enthält product_id');
  assert.ok(payload.assign_key.includes('VM01'), 'enthält machine_id');
  assert.ok(payload.assign_key.includes('5'),    'enthält mdb_code');
});

test('AC3: different machine produces different assign_key', () => {
  const p1 = buildSlotAssignPayload(PRODUCT_ROW, { machine_id: 'VM01', mdb_code: 5, qty: 0, start_date: '2026-06-01' });
  const p2 = buildSlotAssignPayload(PRODUCT_ROW, { machine_id: 'VM02', mdb_code: 5, qty: 0, start_date: '2026-06-01' });
  assert.notEqual(p1.assign_key, p2.assign_key);
});

test('AC3: buildSlotAssignPayload contains all required fields', () => {
  const payload = buildSlotAssignPayload(PRODUCT_ROW, { machine_id: 'VM01', mdb_code: 5, qty: 8, start_date: '2026-06-01' });
  assert.equal(payload.product_id,  42);
  assert.equal(payload.product_key, 'SKU_SNICKERS');
  assert.equal(payload.machine_id,  'VM01');
  assert.equal(payload.mdb_code,    5);
  assert.equal(payload.qty,         8);
  assert.equal(payload.start_date,  '2026-06-01');
});

// ═════════════════════════════════════════════════════════════════════════════
// AC3: buildSlotAssignAuditEntry
// ═════════════════════════════════════════════════════════════════════════════

test('AC3: buildSlotAssignAuditEntry contains viewer login and timestamp', () => {
  const viewer  = { login: 'admin@example.test', canTriggerActions: true };
  const payload = buildSlotAssignPayload(PRODUCT_ROW, { machine_id: 'VM01', mdb_code: 5, qty: 8, start_date: '2026-06-01' });
  const result  = { ok: true, status_ref: 'sa-xyz', message: 'ok' };
  const entry   = buildSlotAssignAuditEntry(viewer, payload, result);
  assert.equal(entry.triggered_by, 'admin@example.test');
  assert.ok(typeof entry.triggered_at === 'string');
  assert.equal(entry.ok, true);
  assert.equal(entry.status_ref, 'sa-xyz');
  assert.ok(entry.assign_key);
});

// ═════════════════════════════════════════════════════════════════════════════
// AC4: GET /api/v2/slot-assign-inline/preview – 503 ohne PG
// ═════════════════════════════════════════════════════════════════════════════

test('AC4: GET /api/v2/slot-assign-inline/preview returns 503 when PG not configured', async () => {
  const port  = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res  = await request(port, '/api/v2/slot-assign-inline/preview?product_id=42');
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
  } finally {
    child.kill();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AC4: POST /api/v2/slot-assign-inline/confirm – 403 für Gäste
// ═════════════════════════════════════════════════════════════════════════════

test('AC4: POST /api/v2/slot-assign-inline/confirm returns 403 for guest', async () => {
  const port  = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/slot-assign-inline/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'guest@example.test' },
      body:    JSON.stringify({ product_id: 42, machine_id: 'VM01', mdb_code: 5, qty: 10, start_date: '2026-06-01' }),
    });
    assert.equal(res.status, 403);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'READ_ONLY_FORBIDDEN');
  } finally {
    child.kill();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AC4: POST /api/v2/slot-assign-inline/confirm – 400 bei fehlenden Feldern
// ═════════════════════════════════════════════════════════════════════════════

test('AC4: POST /api/v2/slot-assign-inline/confirm returns 400 for missing fields', async () => {
  const port  = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/slot-assign-inline/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body:    JSON.stringify({ product_id: 42 }),  // fehlt: machine_id, mdb_code, qty, start_date
    });
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.ok(['MISSING_FIELDS', 'VALIDATION_ERROR'].includes(body.error.code));
  } finally {
    child.kill();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AC4: kein direktes Raw-Edit-Endpoint
// ═════════════════════════════════════════════════════════════════════════════

test('AC4: no raw table edit endpoint (PUT /api/v2/slot-assign-inline/raw is 404)', async () => {
  const port  = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/slot-assign-inline/raw', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    child.kill();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AC5: Zähler sinkt nach Slot-Zuweisung (unit-test über buildProductOnboardingData)
// ═════════════════════════════════════════════════════════════════════════════

const { buildProductOnboardingData, deriveProductStatus } = require('../lib/product-onboarding.js');

test('AC5: product moves from slot_offen to verkaufsbereit once it has an active slot', () => {
  const before = { alias_count: 2, nayax_alias_count: 1, active_slots: 0 };
  const after  = { alias_count: 2, nayax_alias_count: 1, active_slots: 1 };
  assert.equal(deriveProductStatus(before), 'slot_offen',     'vor Zuweisung: slot_offen');
  assert.equal(deriveProductStatus(after),  'verkaufsbereit', 'nach Zuweisung: verkaufsbereit');
});

test('AC5: slot_offen count in onboarding data decreases after successful assignment', () => {
  const productRows = [
    { product_id: 1, product_key: 'A', name: 'Alpha', alias_count: 1, nayax_alias_count: 1, active_slots: 0 },
    { product_id: 2, product_key: 'B', name: 'Beta',  alias_count: 1, nayax_alias_count: 1, active_slots: 0 },
  ];
  const before = buildProductOnboardingData({ productRows, invoiceRows: [], orphanRows: [], totalInvoices: 0 });
  assert.equal(before.products_by_status.slot_offen.length, 2);

  const rowsAfter = [
    { product_id: 1, product_key: 'A', name: 'Alpha', alias_count: 1, nayax_alias_count: 1, active_slots: 1 }, // assigned
    { product_id: 2, product_key: 'B', name: 'Beta',  alias_count: 1, nayax_alias_count: 1, active_slots: 0 },
  ];
  const after = buildProductOnboardingData({ productRows: rowsAfter, invoiceRows: [], orphanRows: [], totalInvoices: 0 });
  assert.equal(after.products_by_status.slot_offen.length,     1, 'slot_offen sinkt um 1');
  assert.equal(after.products_by_status.verkaufsbereit.length, 1, 'verkaufsbereit steigt um 1');
});
