'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  buildSlotChangePreview,
  validateSlotChange,
  buildSlotChangePayload,
  buildSlotChangeAuditEntry,
} = require('../lib/slot-change.js');

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
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

const SLOT_ROW = {
  slot_assignment_id: 42,
  machine_id: 'VM01',
  machine_label: 'Snack-Automat Eingang',
  mdb_code: 5,
  product_id: 10,
  product_name: 'Snickers',
  current_machine_qty: 8,
  target_stock: 20,
  machine_capacity: 20,
  location_name: 'Standort A',
};

const PRODUCTS = [
  { product_id: 10, name: 'Snickers' },
  { product_id: 11, name: 'KitKat' },
  { product_id: 12, name: 'Twix' },
];

// ── AC1: buildSlotChangePreview zeigt aktuellen Slot + verfügbare Produkte ───

test('AC1: buildSlotChangePreview returns current slot info', () => {
  const result = buildSlotChangePreview(SLOT_ROW, PRODUCTS);
  assert.equal(result.current_slot.slot_assignment_id, 42);
  assert.equal(result.current_slot.product_name, 'Snickers');
  assert.equal(result.current_slot.current_machine_qty, 8);
  assert.equal(result.current_slot.machine_label, 'Snack-Automat Eingang');
});

test('AC1: buildSlotChangePreview returns available products excluding current', () => {
  const result = buildSlotChangePreview(SLOT_ROW, PRODUCTS);
  const ids = result.products.map((p) => p.product_id);
  assert.ok(!ids.includes(10), 'current product should be excluded');
  assert.ok(ids.includes(11));
  assert.ok(ids.includes(12));
});

test('AC1: buildSlotChangePreview includes occupancy info', () => {
  const result = buildSlotChangePreview(SLOT_ROW, PRODUCTS);
  assert.equal(result.current_slot.machine_capacity, 20);
  assert.equal(result.current_slot.target_stock, 20);
});

// ── AC2: validateSlotChange prüft Pflichtfelder und Regeln ───────────────────

test('AC2: validateSlotChange accepts valid params', () => {
  const result = validateSlotChange({ new_product_id: 11, new_qty: 10, start_date: '2026-06-01' });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('AC2: validateSlotChange rejects missing product', () => {
  const result = validateSlotChange({ new_qty: 5, start_date: '2026-06-01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'new_product_id'));
});

test('AC2: validateSlotChange rejects missing date', () => {
  const result = validateSlotChange({ new_product_id: 11, new_qty: 5 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'start_date'));
});

test('AC2: validateSlotChange rejects negative qty', () => {
  const result = validateSlotChange({ new_product_id: 11, new_qty: -1, start_date: '2026-06-01' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'new_qty'));
});

test('AC2: validateSlotChange accepts zero qty', () => {
  const result = validateSlotChange({ new_product_id: 11, new_qty: 0, start_date: '2026-06-01' });
  assert.equal(result.valid, true);
});

// ── AC3+AC4: buildSlotChangePayload baut idempotente Payload ────────────────

test('AC4: buildSlotChangePayload returns idempotent change_key', () => {
  const payload = buildSlotChangePayload(SLOT_ROW, { new_product_id: 11, new_qty: 10, start_date: '2026-06-01' });
  assert.ok(typeof payload.change_key === 'string' && payload.change_key.length > 0);
  const payload2 = buildSlotChangePayload(SLOT_ROW, { new_product_id: 11, new_qty: 10, start_date: '2026-06-01' });
  assert.equal(payload.change_key, payload2.change_key, 'same inputs produce same key');
});

test('AC4: buildSlotChangePayload contains required fields for slot history', () => {
  const payload = buildSlotChangePayload(SLOT_ROW, { new_product_id: 11, new_qty: 10, start_date: '2026-06-01' });
  assert.equal(payload.machine_id, 'VM01');
  assert.equal(payload.mdb_code, 5);
  assert.equal(payload.old_product_id, 10);
  assert.equal(payload.new_product_id, 11);
  assert.equal(payload.new_qty, 10);
  assert.equal(payload.start_date, '2026-06-01');
  assert.ok(payload.slot_assignment_id != null);
});

test('AC4: different new_product_id produces different change_key', () => {
  const p1 = buildSlotChangePayload(SLOT_ROW, { new_product_id: 11, new_qty: 10, start_date: '2026-06-01' });
  const p2 = buildSlotChangePayload(SLOT_ROW, { new_product_id: 12, new_qty: 10, start_date: '2026-06-01' });
  assert.notEqual(p1.change_key, p2.change_key);
});

// ── AC6: buildSlotChangeAuditEntry ──────────────────────────────────────────

test('AC6: buildSlotChangeAuditEntry contains viewer login and timestamp', () => {
  const viewer = { login: 'admin@example.test', canTriggerActions: true };
  const payload = buildSlotChangePayload(SLOT_ROW, { new_product_id: 11, new_qty: 5, start_date: '2026-06-01' });
  const result = { ok: true, status_ref: 'sc-abc123', message: 'ok' };
  const entry = buildSlotChangeAuditEntry(viewer, payload, result);
  assert.equal(entry.triggered_by, 'admin@example.test');
  assert.ok(typeof entry.triggered_at === 'string');
  assert.equal(entry.ok, true);
  assert.equal(entry.status_ref, 'sc-abc123');
  assert.ok(entry.change_key);
});

// ── AC6: GET /api/v2/slot-change/preview — no PG configured → 503 ───────────

test('AC6: GET /api/v2/slot-change/preview returns 503 when PG not configured', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/slot-change/preview?slot_assignment_id=1');
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
  } finally {
    child.kill();
  }
});

// ── AC6: POST /api/v2/slot-change/confirm — 403 for guest ───────────────────

test('AC6: POST /api/v2/slot-change/confirm returns 403 for guest user', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/slot-change/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'tailscale-user-login': 'guest@example.test',
      },
      body: JSON.stringify({ slot_assignment_id: '1', machine_id: 'VM01', mdb_code: 5, new_product_id: 11, new_qty: 10, start_date: '2026-06-01' }),
    });
    assert.equal(res.status, 403);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'READ_ONLY_FORBIDDEN');
  } finally {
    child.kill();
  }
});

// ── AC6: POST /api/v2/slot-change/confirm — 400 for missing fields ───────────

test('AC6: POST /api/v2/slot-change/confirm returns 400 for missing fields', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/slot-change/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'tailscale-user-login': 'admin@example.test',
      },
      body: JSON.stringify({ machine_id: 'VM01' }),
    });
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MISSING_FIELDS');
  } finally {
    child.kill();
  }
});

// ── AC5: Keine direkte Tabellenbearbeitung — Endpunkt existiert nicht ────────

test('AC5: no raw table edit endpoint exists (PUT /api/v2/slot-change/raw is 404)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/slot-change/raw', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
  } finally {
    child.kill();
  }
});
