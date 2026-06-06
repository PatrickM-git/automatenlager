'use strict';

// Issue #117 — Atomare Ablösung der Konstante TENANT_OWNER (Stufe 2).
// Drei Ebenen:
//   A) Unit (auth.js + Registry-Stub): resolveViewer leitet den realen Mandanten ab,
//      bleibt synchron, fällt NIE auf einen Default zurück; objectAccessAllowed deny.
//   B) LIVE-Sandbox (ROLLBACK): Regressions-Guard „Owner nicht ausgesperrt" + Fremd-
//      Mandant-Deny über die echte Auflösungs-Kette (resolveViewer + tenant-directory
//      + objectAccessAllowed) — exakt die Komposition, die der IDOR-Hook nutzt.
//   C) Spawned-Server: Health-Check + IDOR fail-closed (503, kein Default) bei
//      unerreichbarer DB; Health 200 ohne PG (Dev/Test).

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { resolveViewer, objectAccessAllowed } = require('../lib/auth.js');
const { createTenantDirectory } = require('../lib/tenant-directory.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

const ADMIN = 'patrickmatthes2609@gmail.com';
const FALTRIX = 't_faltrix';
const dir = {
  loginTenant: (l) => (String(l).toLowerCase() === ADMIN ? FALTRIX : null),
  isPlatformAdmin: (l) => String(l).toLowerCase() === ADMIN,
  tenantExists: (t) => t === FALTRIX,
};

// ── A) Unit ──────────────────────────────────────────────────────────────────

test('#117 resolveViewer: gemappter Login -> realer Mandant; resolveViewer bleibt synchron', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN }, directory: dir });
  assert.equal(v.homeTenantId, FALTRIX);
  assert.equal(v.tenantId, FALTRIX);
  assert.equal(v.isPlatformAdmin, true);
  assert.ok(!(v instanceof Promise), 'resolveViewer ist synchron (kein Promise)');
});

test('#117 resolveViewer: nicht gemappter Login -> tenantId null (deny, kein Default)', () => {
  const v = resolveViewer({ login: 'fremd@example.com', remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN }, directory: dir });
  assert.equal(v.tenantId, null);
  assert.equal(v.homeTenantId, null);
  assert.equal(objectAccessAllowed(v, FALTRIX), false, 'unmapped Login darf nicht auf Faltrix-Objekte');
});

test('#117 resolveViewer: ohne Registry -> tenantId null (kein TENANT_OWNER-Default)', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN } });
  assert.equal(v.tenantId, null, 'ohne directory KEIN Default-Mandant mehr');
});

test('#117 resolveViewer: Dev-Local-Admin (Loopback + Flag) -> t_faltrix (Lockout-Recovery)', () => {
  const v = resolveViewer({
    login: '', remoteAddress: '127.0.0.1',
    env: { DASHBOARD_ADMIN_LOGIN: ADMIN, DASHBOARD_DEV_LOCAL_ADMIN: '1' },
    directory: dir,
  });
  assert.equal(v.roleKey, 'eigentuemer');
  assert.equal(v.tenantId, FALTRIX, 'Dev-Notausgang löst über den Admin-Login auf t_faltrix auf');
});

test('#117 resolveViewer: technischer Lookup liefert null -> kein Default (Anti catch=>default)', () => {
  // Simuliert einen „Miss" der Registry (z. B. Login nicht (mehr) geladen): tenantId
  // bleibt null statt auf t_faltrix/eigentuemer zu fallen.
  const dirMiss = { loginTenant: () => null, isPlatformAdmin: () => false, tenantExists: () => false };
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN }, directory: dirMiss });
  assert.equal(v.tenantId, null);
  assert.notEqual(v.tenantId, FALTRIX);
  assert.notEqual(v.tenantId, 'eigentuemer');
});

test('#117 resolveViewer: requestId wird durchgereicht (Audit-Korrelation)', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN }, directory: dir, requestId: 'req-abc' });
  assert.equal(v.requestId, 'req-abc');
});

// ── B) LIVE-Sandbox: Regressions-Guard über die echte Auflösungs-Kette ──────────
async function setup(client) {
  for (let n = 7; n <= 18; n++) await applyMigration(client, n);
}

test('#117 LIVE-Sandbox: Owner nicht ausgesperrt — eigene Maschine über die echten Hooks erlaubt', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client); // 0018 seedet ADMIN -> t_faltrix in tenant_users
    const ctx = await client.query(`
      SELECT (SELECT machine_key FROM automatenlager.machines WHERE tenant_id='t_faltrix' LIMIT 1) mk,
             (SELECT location_id FROM automatenlager.locations WHERE tenant_id='t_faltrix' LIMIT 1) lid`);
    let { mk } = ctx.rows[0];
    const { lid } = ctx.rows[0];
    const registry = createTenantDirectory({ query: (sql, params) => client.query(sql, params) });
    await registry.init();

    // Eigentümer-Viewer (Header-Login = geseedeter Admin) löst auf t_faltrix auf.
    const owner = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN }, directory: registry });
    assert.equal(owner.tenantId, 't_faltrix', 'Owner-Mandant real aufgelöst (nicht ausgesperrt)');

    // Falls keine Faltrix-Maschine existiert: eine anlegen, damit der Guard greift.
    if (!mk) {
      mk = 'TSWITCH_OWN';
      await client.query(`INSERT INTO automatenlager.machines (machine_key, name, location_id, tenant_id, active) VALUES ('${mk}','T',${lid},'t_faltrix',TRUE)`);
    }
    // Exakt die Komposition des IDOR-Hooks: objectAccessAllowed(viewer, await machineTenant(key)).
    const objTenant = await registry.machineTenant(mk);
    assert.equal(objectAccessAllowed(owner, objTenant), true, 'Owner erreicht eigene Maschine über die echten Hooks');
  });
});

test('#117 LIVE-Sandbox: fremder Mandant -> deny (IDOR wird erstmals real wirksam)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Zweiter realer Mandant — Owner ist Faltrix und darf NICHT auf fremde Objekte.
    await client.query(`SELECT automatenlager.fn_create_tenant('acme','Acme',NULL)`);
    const registry = createTenantDirectory({ query: (sql, params) => client.query(sql, params) });
    await registry.init();
    const owner = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: { DASHBOARD_ADMIN_LOGIN: ADMIN }, directory: registry });
    assert.equal(owner.tenantId, 't_faltrix');
    assert.equal(registry.tenantExists('acme'), true, 'acme ist ein realer zweiter Mandant');
    // Ein acme-Objekt (objectTenantId='acme') wird dem Faltrix-Owner verweigert.
    assert.equal(objectAccessAllowed(owner, 'acme'), false, 'Faltrix-Owner darf NICHT auf acme-Objekte (IDOR)');
  });
});

// ── C) Spawned-Server: Health + IDOR fail-closed ───────────────────────────────
function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET', headers: opts.headers || {} },
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

test('#117 Endpoint: /health 200 ohne PG (Registry nicht anwendbar, Dev/Test)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' });
  try {
    const res = await request(port, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json().ok, true);
  } finally { child.kill(); }
});

test('#117 Endpoint: /health 503 bei unerreichbarer DB (fail-closed sichtbar)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_V2_PG_URL: 'postgresql://nouser:nopass@127.0.0.1:59999/nodb' });
  try {
    const res = await request(port, '/health');
    assert.equal(res.status, 503, 'Registry nicht bereit -> unhealthy');
    assert.equal(res.json().tenantDirectoryReady, false);
  } finally { child.kill(); }
});

test('#117 Endpoint: slot-change/confirm bei unerreichbarer DB -> 503 (kein Default-Fallback)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://nouser:nopass@127.0.0.1:59999/nodb',
    DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
  });
  try {
    const res = await request(port, '/api/v2/slot-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body: JSON.stringify({ slot_assignment_id: '1', machine_id: 'VM01', mdb_code: 5, new_product_id: 11, new_qty: 10, start_date: '2026-06-01' }),
    });
    assert.equal(res.status, 503, 'fail-closed: ohne Mandanten-Auflösung kein Schreibzugriff');
    assert.equal(res.json().error.code, 'TENANT_DIRECTORY_UNAVAILABLE');
  } finally { child.kill(); }
});
