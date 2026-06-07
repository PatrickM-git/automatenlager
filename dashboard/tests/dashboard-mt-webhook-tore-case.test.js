'use strict';

/**
 * Webhook-Tore (Case/Produkt) — Stufe 4, Slice 2b (Issue #134).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Autorisierungs-Tor & Parent-Matrix"
 *
 * Die zwei verbleibenden ungeschützten Webhook-Endpunkte bekommen ein Tor — NICHT
 * über die Maschine, sondern über die Case-Zugehörigkeit (Korrektur-Cases sind
 * konstruiert: proposal_/unknown_/warning_, tenant-gefiltert via queryCorrectionCasesPg).
 *   - POST /api/v2/correction-action/confirm  (Parent: case_id)
 *   - POST /api/v2/onboarding/start           (mit case_id ⇒ Mitgliedschaft; sonst Viewer-Mandant)
 *
 * Ebenen (wie #133):
 *   A) Spawned-Server: Body-Tenant-Reject (400); Tor läuft VOR dem Webhook und
 *      fail-closed bei unerreichbarer DB (503).
 *   B) Unit: Break-Glass-Methodenriegel (zentral, deckt beide POST-Endpunkte).
 *   C) LIVE-Sandbox: nicht-vakuöse Case-Mitgliedschaft (acme-Case nicht in globex-Liste).
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { breakGlassDecision } = require('../lib/auth.js');
const { buildCorrectionCases, queryCorrectionCasesPg } = require('../lib/correction-cases.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');

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
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) })); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'test-key', DASHBOARD_V2_PG_URL: '', DASHBOARD_ADMIN_LOGIN: 'admin@example.test', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); } });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

const ADMIN_HEADERS = { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' };
const ENDPOINTS = [
  { path: '/api/v2/correction-action/confirm', valid: { case_id: 'proposal_1', confirmed_product_id: 8 } },
  { path: '/api/v2/onboarding/start', valid: { product_key: 'HARIBO', case_id: 'unknown_HARIBO' } },
];

// ── A) Spawned-Server: Body-Tenant-Reject (400) ───────────────────────────────

test('#134 Body-Tenant-Reject: tenant_id/mandant_id im Body ⇒ 400 (beide Endpunkte)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' });
  try {
    for (const ep of ENDPOINTS) {
      for (const dirty of [{ tenant_id: 'globex' }, { mandant_id: 'globex' }]) {
        const res = await request(port, ep.path, {
          method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ ...ep.valid, ...dirty }),
        });
        assert.equal(res.status, 400, `${ep.path} mit ${Object.keys(dirty)[0]} ⇒ 400`);
        assert.equal(res.json().error.code, 'TENANT_IN_BODY', `${ep.path}: klarer Fehlercode`);
      }
    }
  } finally { child.kill(); }
});

// ── A) Spawned-Server: Tor läuft VOR dem Webhook, fail-closed bei DB-Unerreichbarkeit ──

test('#134 Tor verkabelt: konfiguriertes, aber unerreichbares PG ⇒ 503 (kein Webhook-Trigger)', async () => {
  // PG konfiguriert aber unerreichbar ⇒ Registry nicht bereit ⇒ das Case-Tor liefert
  // 503, BEVOR der n8n-Webhook ausgelöst würde (Beweis der Verkabelung + fail-closed).
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: 'postgresql://nouser:nopass@127.0.0.1:59999/nodb' });
  try {
    for (const ep of ENDPOINTS) {
      const res = await request(port, ep.path, {
        method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify(ep.valid),
      });
      assert.equal(res.status, 503, `${ep.path}: Tor läuft (503 statt Webhook)`);
    }
  } finally { child.kill(); }
});

// ── B) Unit: Break-Glass-Methodenriegel (zentral, deckt beide POST-Endpunkte) ──

test('#134 Break-Glass: aktive Support-Sitzung + Schreibmethode ⇒ 403 SUPPORT_SESSION_READ_ONLY', () => {
  const viewer = { login: 'admin', tenantId: 'acme', supportSession: { requested: true, active: true, targetTenant: 'acme' } };
  const decision = breakGlassDecision(viewer, 'POST');
  assert.equal(decision.kind, 'block');
  assert.equal(decision.status, 403);
  assert.equal(decision.code, 'SUPPORT_SESSION_READ_ONLY');
  assert.equal(decision.auditEvent, 'break_glass_write_blocked');
});

// ── C) LIVE-Sandbox: nicht-vakuöse Case-Mitgliedschaft (exakt die Tor-Komposition) ──

test('#134 LIVE-Sandbox Case-Mitgliedschaft: acme-Case NICHT in globex-Liste (und umgekehrt)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // Qualifizierenden Case je Mandant erzeugen (offene UNMATCHED_PRODUCT-Warnung ⇒ warning_<id>).
    const mkWarn = async (tid, machineId, productId) => {
      const r = await client.query(
        `INSERT INTO automatenlager.warnings (warning_key, warning_type, message, source_workflow, machine_id, product_id, tenant_id, resolved)
           VALUES ($1, 'UNMATCHED_PRODUCT', $2, 'wf4', $3, $4, $5, FALSE) RETURNING warning_id`,
        [`uw_${tid}`, `Unmatched ${tid}`, machineId, productId, tid]);
      return `warning_${r.rows[0].warning_id}`;
    };
    const acmeCaseId = await mkWarn('acme', acme.machineId, acme.productId);
    const globexCaseId = await mkWarn('globex', globex.machineId, globex.productId);

    const door = doorForClient(client);
    const caseIds = async (tid) => (buildCorrectionCases(await queryCorrectionCasesPg(door, tid))).cases.map((c) => c.case_id);
    const acmeCases = await caseIds('acme');
    const globexCases = await caseIds('globex');

    // nicht-vakuös: jeder Mandant HAT seinen Case wirklich
    assert.ok(acmeCases.includes(acmeCaseId), 'acme hat seinen Case');
    assert.ok(globexCases.includes(globexCaseId), 'globex hat seinen Case');
    // Isolation: der jeweils fremde Case ist NICHT in der Liste ⇒ requireCaseAccess ⇒ 404
    assert.ok(!acmeCases.includes(globexCaseId), 'acme sieht globex-Case NICHT (⇒ 404)');
    assert.ok(!globexCases.includes(acmeCaseId), 'globex sieht acme-Case NICHT (⇒ 404)');
  });
});
