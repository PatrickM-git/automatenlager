'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  deriveProductStatus,
  buildPendingApprovals,
  buildUnknownProducts,
  buildProductOnboardingData,
} = require('../lib/product-onboarding.js');

const {
  buildOnboardingStartPayload,
  validateOnboardingStart,
  buildOnboardingStartAuditEntry,
} = require('../lib/onboarding-start.js');

// ── deriveProductStatus ───────────────────────────────────────────────────────

test('deriveProductStatus: product with active slot is verkaufsbereit', () => {
  const product = { alias_count: 2, nayax_alias_count: 1, active_slots: 1 };
  assert.equal(deriveProductStatus(product), 'verkaufsbereit');
});

test('deriveProductStatus: product with nayax alias but no active slot is slot_offen', () => {
  const product = { alias_count: 2, nayax_alias_count: 1, active_slots: 0 };
  assert.equal(deriveProductStatus(product), 'slot_offen');
});

test('deriveProductStatus: product with non-nayax alias and no slot is bereit_fur_moma', () => {
  const product = { alias_count: 1, nayax_alias_count: 0, active_slots: 0 };
  assert.equal(deriveProductStatus(product), 'bereit_fur_moma');
});

test('deriveProductStatus: product with no aliases and no slot is intern_erstellt', () => {
  const product = { alias_count: 0, nayax_alias_count: 0, active_slots: 0 };
  assert.equal(deriveProductStatus(product), 'intern_erstellt');
});

test('deriveProductStatus: active_slots > 1 still returns verkaufsbereit', () => {
  const product = { alias_count: 3, nayax_alias_count: 2, active_slots: 2 };
  assert.equal(deriveProductStatus(product), 'verkaufsbereit');
});

// ── buildPendingApprovals ─────────────────────────────────────────────────────

test('buildPendingApprovals: groups invoice items with missing product_id', () => {
  const rows = [
    { invoice_key: 'INV_001', invoice_number: 'R-2024-001', supplier_name: 'Haribo GmbH', invoice_date: '2024-01-15', product_id: null, line_number: 1 },
    { invoice_key: 'INV_001', invoice_number: 'R-2024-001', supplier_name: 'Haribo GmbH', invoice_date: '2024-01-15', product_id: null, line_number: 2 },
    { invoice_key: 'INV_002', invoice_number: 'R-2024-002', supplier_name: 'Mars GmbH',   invoice_date: '2024-01-20', product_id: 42,   line_number: 1 },
  ];
  const result = buildPendingApprovals(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].invoice_key, 'INV_001');
  assert.equal(result[0].invoice_number, 'R-2024-001');
  assert.equal(result[0].supplier_name, 'Haribo GmbH');
  assert.equal(result[0].invoice_date, '2024-01-15');
  assert.equal(result[0].open_items, 2);
});

test('buildPendingApprovals: returns empty array when all items have product_id', () => {
  const rows = [
    { invoice_key: 'INV_003', invoice_number: 'R-003', supplier_name: 'Test AG', invoice_date: '2024-02-01', product_id: 5, line_number: 1 },
  ];
  const result = buildPendingApprovals(rows);
  assert.deepEqual(result, []);
});

test('buildPendingApprovals: returns empty array for empty input', () => {
  assert.deepEqual(buildPendingApprovals([]), []);
});

test('buildPendingApprovals: invoice with mixed items (some resolved) is included', () => {
  const rows = [
    { invoice_key: 'INV_004', invoice_number: 'R-004', supplier_name: 'Vendor', invoice_date: '2024-03-01', product_id: 10,  line_number: 1 },
    { invoice_key: 'INV_004', invoice_number: 'R-004', supplier_name: 'Vendor', invoice_date: '2024-03-01', product_id: null, line_number: 2 },
  ];
  const result = buildPendingApprovals(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].open_items, 1);
});

// ── buildUnknownProducts ──────────────────────────────────────────────────────

test('buildUnknownProducts: groups orphan transactions by product_key', () => {
  const rows = [
    { product_key: 'SKU_UNKNOWN_A', tx_count: 3 },
    { product_key: 'SKU_UNKNOWN_B', tx_count: 7 },
  ];
  const result = buildUnknownProducts(rows);
  assert.equal(result.length, 2);
  assert.ok(result.some((r) => r.product_key === 'SKU_UNKNOWN_A' && r.tx_count === 3));
  assert.ok(result.some((r) => r.product_key === 'SKU_UNKNOWN_B' && r.tx_count === 7));
});

test('buildUnknownProducts: returns empty array when no orphans', () => {
  assert.deepEqual(buildUnknownProducts([]), []);
});

test('buildUnknownProducts: sorts by tx_count descending', () => {
  const rows = [
    { product_key: 'SKU_LOW', tx_count: 1 },
    { product_key: 'SKU_HIGH', tx_count: 99 },
    { product_key: 'SKU_MID', tx_count: 12 },
  ];
  const result = buildUnknownProducts(rows);
  assert.equal(result[0].product_key, 'SKU_HIGH');
  assert.equal(result[1].product_key, 'SKU_MID');
  assert.equal(result[2].product_key, 'SKU_LOW');
});

// ── buildProductOnboardingData ────────────────────────────────────────────────

test('buildProductOnboardingData: separates products into 4 status groups', () => {
  const productRows = [
    { product_id: 1, product_key: 'SKU_A', name: 'Produkt A', alias_count: 0, nayax_alias_count: 0, active_slots: 0 },
    { product_id: 2, product_key: 'SKU_B', name: 'Produkt B', alias_count: 1, nayax_alias_count: 0, active_slots: 0 },
    { product_id: 3, product_key: 'SKU_C', name: 'Produkt C', alias_count: 2, nayax_alias_count: 1, active_slots: 0 },
    { product_id: 4, product_key: 'SKU_D', name: 'Produkt D', alias_count: 1, nayax_alias_count: 1, active_slots: 1 },
  ];
  const invoiceRows = [];
  const orphanRows = [];
  const result = buildProductOnboardingData({ productRows, invoiceRows, orphanRows, totalInvoices: 5 });

  assert.equal(result.products_by_status.intern_erstellt.length, 1);
  assert.equal(result.products_by_status.bereit_fur_moma.length, 1);
  assert.equal(result.products_by_status.slot_offen.length, 1);
  assert.equal(result.products_by_status.verkaufsbereit.length, 1);
  assert.equal(result.total_invoices, 5);
  assert.deepEqual(result.pending_approvals, []);
  assert.deepEqual(result.unknown_products, []);
});

test('buildProductOnboardingData: includes product name and key in status groups', () => {
  const productRows = [
    { product_id: 1, product_key: 'SKU_X', name: 'Test Snickers', alias_count: 0, nayax_alias_count: 0, active_slots: 0 },
  ];
  const result = buildProductOnboardingData({ productRows, invoiceRows: [], orphanRows: [], totalInvoices: 0 });
  const p = result.products_by_status.intern_erstellt[0];
  assert.equal(p.product_key, 'SKU_X');
  assert.equal(p.name, 'Test Snickers');
});

test('buildProductOnboardingData: pending_approvals and unknown_products are populated', () => {
  const productRows = [];
  const invoiceRows = [
    { invoice_key: 'INV_999', invoice_number: 'R-999', supplier_name: 'Test', invoice_date: '2024-01-01', product_id: null, line_number: 1 },
  ];
  const orphanRows = [{ product_key: 'SKU_ORPHAN', tx_count: 5 }];
  const result = buildProductOnboardingData({ productRows, invoiceRows, orphanRows, totalInvoices: 1 });

  assert.equal(result.pending_approvals.length, 1);
  assert.equal(result.unknown_products.length, 1);
});

// ── HTTP integration: GET /api/v2/onboarding ─────────────────────────────────

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
    cwd: require('path').join(__dirname, '..'),
    env: {
      ...process.env,
      DASHBOARD_DEV_LOCAL_ADMIN: '1', // #27: lokaler Test = Admin-Notausgang
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
      N8N_API_KEY: 'test-key',
      DASHBOARD_V2_PG_URL: '',
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

test('GET /api/v2/onboarding returns 503 when PG not configured', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/onboarding');
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'PG_UNCONFIGURED');
});

test('GET /api/v2/onboarding returns is_admin false for guest (non-admin tailscale login)', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://fake:fake@127.0.0.1:5999/fake',
    DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
  });
  t.after(() => child.kill());

  // #128 (Stufe 3): Bei unerreichbarer DB ist das Mandanten-Verzeichnis NICHT bereit
  // ⇒ der effektive Mandant ist nicht auflösbar ⇒ technischer 503 (kein leeres
  // Resultat, das einen Ausfall maskiert). Die generische technische Fehlerform
  // trägt kein data.is_admin mehr (das Gast/Admin-Verhalten prüfen die Auth-Tests).
  const res = await request(port, '/api/v2/onboarding', { 'tailscale-user-login': 'guest@example.test' });
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error && body.error.code, 'technischer 503 trägt einen Fehlercode');
});

test('GET /api/v2/onboarding returns 503 when PG unreachable', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://fake:fake@127.0.0.1:5999/fake',
    DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
  });
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/onboarding', { 'tailscale-user-login': 'admin@example.test' });
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'PG_ERROR');
});

// ── buildOnboardingStartPayload ───────────────────────────────────────────────

const UNKNOWN_CASE = {
  case_id: 'unknown_HARIBO_GOLDB',
  case_type: 'unknown_product',
  product_key: 'HARIBO GOLDB',
  machine_id: 10001,
  mdb_code: 301,
  affected_tx_count: 5,
};

test('buildOnboardingStartPayload: builds payload with idempotent action_key', () => {
  const payload = buildOnboardingStartPayload(UNKNOWN_CASE);
  assert.equal(payload.action_key, 'ONBOARDING|HARIBO GOLDB');
  assert.equal(payload.product_key, 'HARIBO GOLDB');
  assert.equal(payload.case_id, 'unknown_HARIBO_GOLDB');
});

test('buildOnboardingStartPayload: includes machine_id and mdb_code', () => {
  const payload = buildOnboardingStartPayload(UNKNOWN_CASE);
  assert.equal(payload.machine_id, 10001);
  assert.equal(payload.mdb_code, 301);
});

test('buildOnboardingStartPayload: action_key is idempotent for same product_key', () => {
  const p1 = buildOnboardingStartPayload(UNKNOWN_CASE);
  const p2 = buildOnboardingStartPayload({ ...UNKNOWN_CASE, machine_id: 99999 });
  assert.equal(p1.action_key, p2.action_key);
});

test('buildOnboardingStartPayload: handles product_key with special characters', () => {
  const c = { ...UNKNOWN_CASE, product_key: 'Twix 50g / Riegel', case_id: 'unknown_TWIX' };
  const payload = buildOnboardingStartPayload(c);
  assert.equal(payload.action_key, 'ONBOARDING|Twix 50g / Riegel');
});

// ── validateOnboardingStart ───────────────────────────────────────────────────

test('validateOnboardingStart: valid when product_key present', () => {
  const result = validateOnboardingStart({ product_key: 'HARIBO GOLDB', case_id: 'unknown_HARIBO_GOLDB' });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateOnboardingStart: invalid when product_key missing', () => {
  const result = validateOnboardingStart({ case_id: 'unknown_HARIBO_GOLDB' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'product_key'));
});

test('validateOnboardingStart: invalid when product_key empty string', () => {
  const result = validateOnboardingStart({ product_key: '', case_id: 'unknown_HARIBO_GOLDB' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'product_key'));
});

// ── buildOnboardingStartAuditEntry ────────────────────────────────────────────

const VIEWER_ADMIN = { login: 'patrick@example.test', role: 'admin', canTriggerActions: true };

test('buildOnboardingStartAuditEntry: includes triggered_by and action_key', () => {
  const payload = buildOnboardingStartPayload(UNKNOWN_CASE);
  const result = { ok: true, message: 'Gestartet.' };
  const entry = buildOnboardingStartAuditEntry(VIEWER_ADMIN, payload, result);

  assert.equal(entry.triggered_by, 'patrick@example.test');
  assert.equal(entry.action_key, 'ONBOARDING|HARIBO GOLDB');
  assert.equal(entry.product_key, 'HARIBO GOLDB');
  assert.equal(entry.case_id, 'unknown_HARIBO_GOLDB');
  assert.equal(entry.ok, true);
  assert.ok(entry.triggered_at);
});

test('buildOnboardingStartAuditEntry: records failure correctly', () => {
  const payload = buildOnboardingStartPayload(UNKNOWN_CASE);
  const result = { ok: false, message: 'Webhook nicht erreichbar.' };
  const entry = buildOnboardingStartAuditEntry(VIEWER_ADMIN, payload, result);

  assert.equal(entry.ok, false);
  assert.ok(entry.message.includes('Webhook'));
});

// ── HTTP integration: POST /api/v2/onboarding/start ──────────────────────────

function postRequest(port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function startDashboardFull(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: {
      ...process.env,
      DASHBOARD_DEV_LOCAL_ADMIN: '1', // #27: lokaler Test = Admin-Notausgang
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

test('POST /api/v2/onboarding/start returns 403 for guest', async (t) => {
  const port = await getFreePort();
  const child = await startDashboardFull(port);
  t.after(() => child.kill());

  const res = await postRequest(
    port, '/api/v2/onboarding/start',
    { product_key: 'HARIBO GOLDB', case_id: 'unknown_HARIBO_GOLDB' },
    { 'tailscale-user-login': 'guest@example.test' },
  );
  assert.equal(res.status, 403);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'READ_ONLY_FORBIDDEN');
});

test('POST /api/v2/onboarding/start returns 400 when product_key missing', async (t) => {
  const port = await getFreePort();
  const child = await startDashboardFull(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  t.after(() => child.kill());

  const res = await postRequest(port, '/api/v2/onboarding/start', { case_id: 'unknown_TEST' });
  assert.equal(res.status, 400);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('POST /api/v2/onboarding/start returns 200 for admin without webhook (dry-run)', async (t) => {
  const port = await getFreePort();
  const child = await startDashboardFull(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  t.after(() => child.kill());

  const res = await postRequest(port, '/api/v2/onboarding/start', {
    product_key: 'HARIBO GOLDB',
    case_id: 'unknown_HARIBO_GOLDB',
    affected_tx_count: 5,
  });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.product_key, 'HARIBO GOLDB');
  assert.ok(body.action_key.startsWith('ONBOARDING|'));
});

test('POST /api/v2/onboarding/start is idempotent (same action_key for same product_key)', async (t) => {
  const port = await getFreePort();
  const child = await startDashboardFull(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  t.after(() => child.kill());

  const payload = { product_key: 'TWIX', case_id: 'unknown_TWIX' };
  const res1 = await postRequest(port, '/api/v2/onboarding/start', payload);
  const res2 = await postRequest(port, '/api/v2/onboarding/start', payload);

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res1.json().action_key, res2.json().action_key);
});

test('GET /api/v2/onboarding/started-keys returns a freshly started product_key', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const port = await getFreePort();
  // Eigenes, leeres Audit-Log pro Lauf: der Test darf NICHT von akkumuliertem
  // lokalem logs/onboarding-starts.jsonl abhängen (sonst grün im Dev-Checkout,
  // rot im frischen Worktree). Pfad via DASHBOARD_ONBOARDING_AUDIT_LOG isoliert.
  const auditLog = path.join(os.tmpdir(), `onboarding-starts-test-${process.pid}-${port}.jsonl`);
  fs.rmSync(auditLog, { force: true });

  // Kein PG konfiguriert ⇒ requireCaseAccess-Tor inaktiv (Dev/Test), der POST
  // hängt real an das Audit-Log an — so testet der Flow POST→GUI wirklich.
  const child = await startDashboardFull(port, {
    DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
    DASHBOARD_ONBOARDING_AUDIT_LOG: auditLog,
  });
  t.after(() => { child.kill(); fs.rmSync(auditLog, { force: true }); });

  const post = await postRequest(port, '/api/v2/onboarding/start', {
    product_key: 'RESOLVED_PRODUCT',
    case_id: 'unknown_RESOLVED_PRODUCT',
  });
  assert.equal(post.status, 200);

  const res = await request(port, '/api/v2/onboarding/started-keys');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.ok(body.ok);
  assert.ok(Array.isArray(body.started_keys));
  assert.ok(body.started_keys.includes('RESOLVED_PRODUCT'));
});

// ── Strukturtests: WF1/WF2-Referenzen ────────────────────────────────────────

test('server.js referenziert WF1 (invoice-intake) mit korrektem Workflow-Namen', () => {
  const fs = require('node:fs');
  const serverSrc = fs.readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
  assert.ok(serverSrc.includes("id: 'invoice-intake'"), 'WF1 action id invoice-intake muss vorhanden sein');
  assert.ok(serverSrc.includes('WF1 - Rechnungseingang automatisch mit Claude'), 'WF1 workflow name pattern muss vorhanden sein');
});

test('server.js referenziert WF2 (invoice-approval) mit korrektem Workflow-Namen', () => {
  const fs = require('node:fs');
  const serverSrc = fs.readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
  assert.ok(serverSrc.includes("id: 'invoice-approval'"), 'WF2 action id invoice-approval muss vorhanden sein');
  assert.ok(serverSrc.includes('WF2 - Smart Product Selection - Rechnungsvorschlaege freigeben'), 'WF2 workflow name pattern muss vorhanden sein');
});
