'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  WRITE_OFF_STATUS,
  WRITE_OFF_REASONS,
  validateWriteOff,
  canWriteOff,
  buildWriteOffAuditEntry,
} = require('../lib/write-off.js');

// ── reine Logik ───────────────────────────────────────────────────────────────

test('WRITE_OFF_STATUS ist "ausgesondert" (vorhandener Modellwert)', () => {
  assert.equal(WRITE_OFF_STATUS, 'ausgesondert');
});

test('WRITE_OFF_REASONS enthält "MHD abgelaufen"', () => {
  assert.ok(WRITE_OFF_REASONS.includes('MHD abgelaufen'));
});

test('validateWriteOff: batch_key + Grund erforderlich', () => {
  assert.equal(validateWriteOff({ batch_key: 'B1', reason: 'MHD abgelaufen' }).valid, true);
  assert.equal(validateWriteOff({ batch_key: '', reason: 'x' }).valid, false);
  assert.equal(validateWriteOff({ batch_key: 'B1', reason: '   ' }).valid, false);
  const r = validateWriteOff({ batch_key: ' B1 ', reason: ' Bruch ' });
  assert.equal(r.batch_key, 'B1');
  assert.equal(r.reason, 'Bruch');
});

test('canWriteOff: verfügbare Charge mit Bestand darf ausgebucht werden', () => {
  const r = canWriteOff({ status: 'aktiv', remaining_qty: 21 });
  assert.equal(r.ok, true);
  assert.equal(r.remaining_qty, 21);
});

test('canWriteOff: reserve-Charge (Pick Up) darf ausgebucht werden', () => {
  assert.equal(canWriteOff({ status: 'reserve', remaining_qty: 22 }).ok, true);
});

test('canWriteOff: fehlende Charge -> NOT_FOUND', () => {
  assert.deepEqual(canWriteOff(null), { ok: false, code: 'NOT_FOUND' });
});

test('canWriteOff: bereits ausgesondert -> ALREADY_WRITTEN_OFF (idempotent)', () => {
  assert.equal(canWriteOff({ status: 'ausgesondert', remaining_qty: 5 }).code, 'ALREADY_WRITTEN_OFF');
});

test('canWriteOff: leere Charge -> EMPTY', () => {
  assert.equal(canWriteOff({ status: 'aktiv', remaining_qty: 0 }).code, 'EMPTY');
});

test('canWriteOff: erwartete Menge weicht ab -> DRIFT (optimistic lock)', () => {
  const r = canWriteOff({ status: 'aktiv', remaining_qty: 21 }, 15);
  assert.equal(r.code, 'DRIFT');
  assert.equal(r.remaining_qty, 21);
});

test('canWriteOff: passende erwartete Menge -> ok', () => {
  assert.equal(canWriteOff({ status: 'aktiv', remaining_qty: 21 }, 21).ok, true);
});

test('buildWriteOffAuditEntry: Pflichtfelder + ISO-Zeitstempel', () => {
  const viewer = { login: 'admin@example.test' };
  const entry = buildWriteOffAuditEntry(
    viewer,
    { batch_key: 'B_NICK_NACKS_20260502_1', reason: 'MHD abgelaufen' },
    { ok: true, product_id: 43, written_off_qty: 21 },
  );
  assert.equal(entry.actor, 'admin@example.test');
  assert.equal(entry.action, 'inventory_write_off');
  assert.equal(entry.batch_key, 'B_NICK_NACKS_20260502_1');
  assert.equal(entry.product_id, 43);
  assert.equal(entry.written_off_qty, 21);
  assert.equal(entry.ok, true);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry.timestamp));
});

// ── HTTP: Read-Only-Schutz ──────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET', headers: opts.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
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

test('POST /api/v2/inventory/write-off liefert 403 für Gäste', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/inventory/write-off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'gast@example.test' },
      body: JSON.stringify({ batch_key: 'B1', reason: 'MHD abgelaufen' }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().ok, false);
  } finally {
    child.kill();
  }
});

test('POST /api/v2/inventory/write-off: Admin ohne PG -> nicht 403 (kein Read-Only-Block)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/inventory/write-off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body: JSON.stringify({ batch_key: 'B1', reason: 'MHD abgelaufen' }),
    });
    assert.notEqual(res.status, 403);
  } finally {
    child.kill();
  }
});
