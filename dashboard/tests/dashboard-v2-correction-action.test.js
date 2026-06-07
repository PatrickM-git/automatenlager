'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  buildProductSuggestion,
  validateCorrectionAction,
  buildCorrectionActionPayload,
  buildCorrectionActionAuditEntry,
} = require('../lib/correction-action.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_PRODUCTS = [
  { product_id: 7, name: 'Snickers' },
  { product_id: 8, name: 'Mars' },
  { product_id: 9, name: 'Haribo Goldbären' },
];

const CASE_MDB_PROPOSAL = {
  case_id: 'proposal_1',
  case_type: 'mdb_proposal',
  machine_id: 10001,
  mdb_code: 102,
  product_id: 7,
  slot_assignment_id: 55,
  suggested_product_id: 8,
  suggested_product_name: 'Mars',
};

const CASE_UNKNOWN = {
  case_id: 'unknown_HARIBO_SOUR_APPLE',
  case_type: 'unknown_product',
  machine_id: 10001,
  mdb_code: 301,
  product_id: null,
  slot_assignment_id: null,
  suggested_product_id: null,
  suggested_product_name: null,
};

const CASE_WARNING = {
  case_id: 'warning_99',
  case_type: 'correction_warning',
  machine_id: 10001,
  mdb_code: 205,
  product_id: 3,
  slot_assignment_id: 55,
  suggested_product_id: null,
  suggested_product_name: null,
};

const VIEWER_ADMIN = { login: 'patrick@example.test', role: 'admin', canTriggerActions: true };
const VIEWER_GUEST = { login: 'guest@example.test', role: 'guest', canTriggerActions: false };

// ── buildProductSuggestion ────────────────────────────────────────────────────

test('AC1a: buildProductSuggestion returns payload suggestion for mdb_proposal', () => {
  const result = buildProductSuggestion(CASE_MDB_PROPOSAL, ALL_PRODUCTS);

  assert.deepEqual(result.suggestion, { product_id: 8, name: 'Mars' });
  assert.ok(Array.isArray(result.products), 'products should be an array');
  assert.ok(result.products.length > 0, 'products list should not be empty');
});

test('AC1b: buildProductSuggestion returns null suggestion for unknown_product without alias match', () => {
  const result = buildProductSuggestion(CASE_UNKNOWN, ALL_PRODUCTS);

  assert.equal(result.suggestion, null);
  assert.ok(Array.isArray(result.products));
  assert.equal(result.products.length, ALL_PRODUCTS.length);
});

test('AC1c: buildProductSuggestion returns product_id-based suggestion for correction_warning', () => {
  const result = buildProductSuggestion(CASE_WARNING, ALL_PRODUCTS);

  assert.equal(result.suggestion, null, 'no suggestion when no suggested_product_id in payload');
  assert.ok(Array.isArray(result.products));
});

test('AC1d: buildProductSuggestion products list always contains all products', () => {
  const result = buildProductSuggestion(CASE_MDB_PROPOSAL, ALL_PRODUCTS);

  assert.equal(result.products.length, ALL_PRODUCTS.length);
  const ids = result.products.map((p) => p.product_id);
  assert.ok(ids.includes(7));
  assert.ok(ids.includes(8));
  assert.ok(ids.includes(9));
});

// ── validateCorrectionAction ──────────────────────────────────────────────────

test('AC2a: validateCorrectionAction passes when confirmed_product_id is set', () => {
  const result = validateCorrectionAction({ confirmed_product_id: 8 });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('AC2b: validateCorrectionAction fails when confirmed_product_id is missing', () => {
  const result = validateCorrectionAction({});

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'confirmed_product_id'));
});

// ── buildCorrectionActionPayload ──────────────────────────────────────────────

test('AC3a: buildCorrectionActionPayload produces idempotent action_key', () => {
  const payload1 = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 8 });
  const payload2 = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 8 });

  assert.equal(payload1.action_key, payload2.action_key);
  assert.ok(payload1.action_key.startsWith('CORR|'));
});

test('AC3b: buildCorrectionActionPayload changes action_key when product changes', () => {
  const payload1 = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 8 });
  const payload2 = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 9 });

  assert.notEqual(payload1.action_key, payload2.action_key);
});

test('AC3c: buildCorrectionActionPayload contains all required fields', () => {
  const payload = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 8 });

  assert.ok(typeof payload.action_key === 'string' && payload.action_key.length > 0);
  assert.equal(payload.case_id, 'proposal_1');
  assert.equal(payload.case_type, 'mdb_proposal');
  assert.equal(payload.machine_id, 10001);
  assert.equal(payload.mdb_code, 102);
  assert.equal(payload.old_product_id, 7);
  assert.equal(payload.confirmed_product_id, 8);
  assert.equal(payload.slot_assignment_id, 55);
});

// ── buildCorrectionActionAuditEntry ──────────────────────────────────────────

test('AC4a: buildCorrectionActionAuditEntry on success contains all audit fields', () => {
  const payload = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 8 });
  const result = { ok: true, status_ref: 'ref-123', message: 'Webhook erfolgreich.' };
  const entry = buildCorrectionActionAuditEntry(VIEWER_ADMIN, payload, result);

  assert.equal(entry.triggered_by, 'patrick@example.test');
  assert.ok(typeof entry.triggered_at === 'string');
  assert.equal(entry.action_key, payload.action_key);
  assert.equal(entry.case_id, 'proposal_1');
  assert.equal(entry.confirmed_product_id, 8);
  assert.equal(entry.ok, true);
  assert.equal(entry.status_ref, 'ref-123');
});

test('AC4b: buildCorrectionActionAuditEntry on failure marks ok=false', () => {
  const payload = buildCorrectionActionPayload(CASE_MDB_PROPOSAL, { confirmed_product_id: 8 });
  const result = { ok: false, status_ref: null, message: 'Webhook nicht erreichbar.' };
  const entry = buildCorrectionActionAuditEntry(VIEWER_ADMIN, payload, result);

  assert.equal(entry.ok, false);
  assert.equal(entry.status_ref, null);
  assert.ok(entry.message.includes('nicht erreichbar'));
});

// ── HTTP endpoint: suggest ────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, urlPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, path: urlPath, method, headers };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DASHBOARD_DEV_LOCAL_ADMIN: '1', // #27: lokaler Test = Admin-Notausgang
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
      N8N_API_KEY: 'test-key',
      DASHBOARD_ADMIN_LOGIN: 'patrick@example.test',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.resume();
    child.on('exit', (code) => {
      if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`exit ${code}`)); }
    });
  });
}

test('AC5: GET /api/v2/correction-action/suggest returns 200 with suggestion and products', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-action/suggest?case_id=proposal_1');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.ok(typeof body.ok === 'boolean');
  assert.ok('suggestion' in body, 'body.suggestion should exist');
  assert.ok(Array.isArray(body.products), 'body.products should be an array');
});

test('AC6: GET /api/v2/correction-action/suggest returns 400 when case_id missing', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-action/suggest');
  assert.equal(res.status, 400);
});

// ── HTTP endpoint: confirm ────────────────────────────────────────────────────

test('AC7: POST /api/v2/correction-action/confirm returns 403 for guest', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-action/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'tailscale-user-login': 'guest@nowhere.example',
    },
    body: { case_id: 'proposal_1', confirmed_product_id: 8 },
  });
  assert.equal(res.status, 403);
});

test('AC8: POST /api/v2/correction-action/confirm returns 200 for admin (no webhook configured)', async (t) => {
  const port = await getFreePort();
  // #134: ohne PG ist das Case-Tor inaktiv (kein Mandanten-Datenbestand) — dieser Test
  // prüft Payload/Status-Verhalten, NICHT die Case-Eigentümerschaft (separat in
  // dashboard-mt-webhook-tore-case.test.js). Hermetisch, ohne Mini-Abhängigkeit.
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' });
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-action/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { case_id: 'proposal_1', case_type: 'mdb_proposal', machine_id: 10001, mdb_code: 102, old_product_id: 7, slot_assignment_id: 55, confirmed_product_id: 8 },
  });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(typeof body.action_key === 'string');
  assert.ok(typeof body.status_ref === 'string');
});

test('AC9: POST /api/v2/correction-action/confirm returns 400 when confirmed_product_id missing', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-action/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { case_id: 'proposal_1' },
  });
  assert.equal(res.status, 400);
});

test('AC10: POST /api/v2/correction-action/confirm returns 502 when webhook fails', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, {
    CORRECTION_ACTION_WEBHOOK_URL: 'http://127.0.0.1:1/unreachable',
    DASHBOARD_V2_PG_URL: '', // #134: Case-Tor inaktiv ohne PG — Test prüft Webhook-Fehlerpfad
  });
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-action/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { case_id: 'proposal_1', case_type: 'mdb_proposal', machine_id: 10001, mdb_code: 102, old_product_id: 7, slot_assignment_id: 55, confirmed_product_id: 8 },
  });
  assert.equal(res.status, 502);
  const body = res.json();
  assert.equal(body.ok, false);
});

test('AC11: action_key is idempotent - same confirm produces same action_key', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' }); // #134: Case-Tor inaktiv ohne PG
  t.after(() => child.kill());

  const confirmBody = { case_id: 'proposal_1', case_type: 'mdb_proposal', machine_id: 10001, mdb_code: 102, old_product_id: 7, slot_assignment_id: 55, confirmed_product_id: 8 };
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: confirmBody };

  const [r1, r2] = await Promise.all([
    request(port, '/api/v2/correction-action/confirm', opts),
    request(port, '/api/v2/correction-action/confirm', opts),
  ]);

  assert.equal(r1.json().action_key, r2.json().action_key);
});

test('AC12: Strukturtest – WF4 ID korrekt in CORRECTION_ACTION_WF4_ID oder server.js', () => {
  const serverSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server.js'),
    'utf8',
  );
  assert.ok(
    serverSrc.includes('6tOZnWsxBNzHaVqA'),
    'server.js must reference WF4 ID 6tOZnWsxBNzHaVqA',
  );
});
