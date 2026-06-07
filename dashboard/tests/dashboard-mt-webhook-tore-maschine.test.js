'use strict';

/**
 * Webhook-Tore (Maschine) — Stufe 4, Slice 2a (Issue #133).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Autorisierungs-Tor & Parent-Matrix"
 *
 * Die zwei bisher ungeschützten schreib-auslösenden Webhook-Endpunkte mit
 * Maschinen-Bezug bekommen ein Autorisierungs-Tor (requireMachineAccess) + den
 * Body-Tenant-Reject (#131), analog zu slot-change/confirm und nayax-apply.
 *   - POST /api/v2/refill/trigger
 *   - POST /api/v2/slot-assign-inline/confirm
 *
 * Drei Ebenen (wie #117/dashboard-auth-tenant-switch):
 *   A) Spawned-Server: Verkabelung beweisen — Body-Tenant-Reject (400), Tor läuft
 *      VOR dem Webhook (DB unerreichbar ⇒ 503 statt Webhook-Trigger).
 *   B) Unit: Break-Glass-Methodenriegel (zentral, deckt beide POST-Endpunkte).
 *   C) LIVE-Sandbox: nicht-vakuöser IDOR-Beweis über die echte Auflösungs-Kette
 *      (objectAccessAllowed ∘ machineTenant) — acme-Viewer auf globex-Maschine = deny.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { objectAccessAllowed, breakGlassDecision } = require('../lib/auth.js');
const { createTenantDirectory } = require('../lib/tenant-directory.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex } = require('./helpers/tenant-fixtures.js');

// ── Spawned-Server-Harness (wie dashboard-v2-refill.test.js) ──────────────────
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
  { path: '/api/v2/refill/trigger', valid: { machine_id: 'VM01', mdb_code: 1, product_id: 10, qty: 5 } },
  { path: '/api/v2/slot-assign-inline/confirm', valid: { machine_id: 'VM01', mdb_code: 1, product_id: 10, qty: 5, start_date: '2026-06-01' } },
];

// ── A) Spawned-Server: Body-Tenant-Reject (400) ───────────────────────────────

test('#133 Body-Tenant-Reject: tenant_id/mandant_id im Body ⇒ 400 (beide Endpunkte)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' });
  try {
    for (const ep of ENDPOINTS) {
      for (const dirty of [{ tenant_id: 'globex' }, { mandant_id: 'globex' }]) {
        const res = await request(port, ep.path, {
          method: 'POST', headers: ADMIN_HEADERS,
          body: JSON.stringify({ ...ep.valid, ...dirty }),
        });
        assert.equal(res.status, 400, `${ep.path} mit ${Object.keys(dirty)[0]} ⇒ 400`);
        assert.equal(res.json().error.code, 'TENANT_IN_BODY', `${ep.path}: klarer Fehlercode`);
      }
    }
  } finally { child.kill(); }
});

// ── A) Spawned-Server: Autorisierungs-Tor läuft VOR dem Webhook ───────────────

test('#133 requireMachineAccess verkabelt: ohne Mandanten-Auflösung ⇒ 503 (kein Webhook-Trigger)', async () => {
  // Ohne PG ist die Registry nicht bereit ⇒ das Tor liefert 503 TENANT_DIRECTORY_UNAVAILABLE,
  // BEVOR der n8n-Webhook ausgelöst würde (vorher hätte refill den Webhook getriggert ⇒ 502).
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' });
  try {
    for (const ep of ENDPOINTS) {
      const res = await request(port, ep.path, {
        method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify(ep.valid),
      });
      assert.equal(res.status, 503, `${ep.path}: Tor läuft (503 statt Webhook)`);
      assert.equal(res.json().error.code, 'TENANT_DIRECTORY_UNAVAILABLE', `${ep.path}: fail-closed`);
    }
  } finally { child.kill(); }
});

// ── B) Unit: Break-Glass-Methodenriegel (zentral, deckt beide POST-Endpunkte) ──

test('#133 Break-Glass: aktive Support-Sitzung + Schreibmethode ⇒ 403 SUPPORT_SESSION_READ_ONLY', () => {
  // refill/trigger und slot-assign-inline/confirm sind POST ⇒ der zentrale
  // Break-Glass-Riegel (server.js, breakGlassDecision) blockt sie unter aktiver
  // Support-Sitzung mit 403 + Audit break_glass_write_blocked.
  const ss = { requested: true, active: true, targetTenant: 'acme' };
  const viewer = { login: 'admin', tenantId: 'acme', supportSession: ss };
  const decision = breakGlassDecision(viewer, 'POST');
  assert.equal(decision.kind, 'block');
  assert.equal(decision.status, 403);
  assert.equal(decision.code, 'SUPPORT_SESSION_READ_ONLY');
  assert.equal(decision.auditEvent, 'break_glass_write_blocked');
});

// ── C) LIVE-Sandbox: nicht-vakuöser IDOR-Beweis (objectAccessAllowed ∘ machineTenant) ──

test('#133 LIVE-Sandbox IDOR: acme-Viewer auf globex-Maschine ⇒ deny; globex besitzt sie wirklich', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client); // vm_acme→acme, vm_globex→globex (machines)
    const registry = createTenantDirectory({ query: (sql, params) => client.query(sql, params) });
    await registry.init();

    const acmeViewer = { login: 'a@acme', tenantId: 'acme', supportSession: { active: false } };

    // Nicht-vakuös: globex BESITZT die Maschine wirklich (Registry löst real auf).
    const globexMachineTenant = await registry.machineTenant('vm_globex');
    assert.equal(globexMachineTenant, 'globex', 'globex besitzt vm_globex wirklich');

    // Exakt die Komposition, die requireMachineAccess intern anwendet:
    assert.equal(objectAccessAllowed(acmeViewer, globexMachineTenant), false,
      'acme-Viewer darf NICHT auf globex-Maschine (IDOR-Deny ⇒ 404)');

    // Gegenprobe: acme erreicht die eigene Maschine.
    const acmeMachineTenant = await registry.machineTenant('vm_acme');
    assert.equal(acmeMachineTenant, 'acme');
    assert.equal(objectAccessAllowed(acmeViewer, acmeMachineTenant), true,
      'acme-Viewer erreicht eigene Maschine (Owner nicht ausgesperrt)');
  });
});
