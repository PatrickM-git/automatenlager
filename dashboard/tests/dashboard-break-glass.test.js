'use strict';

// Issue #118 — Break-Glass Support-Sitzung (X-Support-Tenant), Stufe 2.
// Zwei Ebenen:
//   A) Unit (auth.js): resolveViewer-Support-Sitzung (Wirksamkeit/Negativregeln,
//      Capability-Stripping, nicht-klebrig) + breakGlassDecision (Statuscodes).
//   B) Spawned-Server: End-to-End-Audit — ein ignorierter Nicht-Admin-Override
//      schreibt einen vollständigen Audit-Eintrag und blockiert NICHT (Heimat).

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { resolveViewer, breakGlassDecision } = require('../lib/auth.js');

const ADMIN = 'patrickmatthes2609@gmail.com';
const FALTRIX = 't_faltrix';
const env = { DASHBOARD_ADMIN_LOGIN: ADMIN };
// Registry-Stub: ADMIN ist Plattform-Admin; Mandanten t_faltrix + acme existieren.
const dir = {
  loginTenant: (l) => {
    const x = String(l).toLowerCase();
    if (x === ADMIN) return FALTRIX;
    if (x === 'gast@extern.test') return null;
    return null;
  },
  isPlatformAdmin: (l) => String(l).toLowerCase() === ADMIN,
  tenantExists: (t) => t === FALTRIX || t === 'acme',
};

// ── A) Unit: resolveViewer-Support-Sitzung ─────────────────────────────────────

test('#118 Admin + Override auf existierenden Mandanten -> aktiv, Ziel-Mandant, read-only', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env, directory: dir, supportTenant: 'acme' });
  assert.equal(v.supportSession.active, true);
  assert.equal(v.supportSession.targetTenant, 'acme');
  assert.equal(v.tenantId, 'acme', 'effektiver Mandant = Ziel');
  assert.equal(v.homeTenantId, FALTRIX, 'Heimat-Mandant bleibt sichtbar');
  // Capability-Stripping: nur *.lesen, keine Schreibrechte.
  assert.equal(v.can('betrieb.lesen'), true);
  assert.equal(v.can('finanzen.lesen'), true);
  assert.equal(v.can('bestand.schreiben'), false);
  assert.equal(v.can('nayax.schreiben'), false);
  assert.equal(v.can('system.verwalten'), false);
  assert.equal(v.canTriggerActions, false);
});

test('#118 Admin + Override auf EIGENEN Mandanten -> trotzdem read-only', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env, directory: dir, supportTenant: FALTRIX });
  assert.equal(v.supportSession.active, true);
  assert.equal(v.tenantId, FALTRIX);
  assert.equal(v.can('bestand.schreiben'), false, 'auch auf eigenem Mandanten read-only');
});

test('#118 Admin + Override auf NICHT existierenden Mandanten -> inaktiv, denyReason tenant_not_found', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env, directory: dir, supportTenant: 'ghost' });
  assert.equal(v.supportSession.active, false);
  assert.equal(v.supportSession.denyReason, 'tenant_not_found');
  assert.equal(v.tenantId, FALTRIX, 'fällt auf Heimat-Mandant zurück');
  assert.equal(v.can('system.verwalten'), true, 'keine Strippung bei inaktivem Override');
});

test('#118 Nicht-Admin + Override -> ignoriert (Heimat), denyReason not_admin, kein Strippen', () => {
  const v = resolveViewer({ login: 'gast@extern.test', remoteAddress: '127.0.0.1', env, directory: dir, supportTenant: 'acme' });
  assert.equal(v.supportSession.requested, true);
  assert.equal(v.supportSession.active, false);
  assert.equal(v.supportSession.denyReason, 'not_admin');
  assert.equal(v.tenantId, v.homeTenantId, 'arbeitet auf Heimat-Mandant');
});

test('#118 Override über untrauten Identity-Pfad -> ignoriert, denyReason untrusted_path', () => {
  const v = resolveViewer({
    login: ADMIN, remoteAddress: '172.20.0.5',
    env: { ...env, DASHBOARD_INTERNAL_PEER_CIDR: '172.20.0.0/16' },
    directory: dir, supportTenant: 'acme',
  });
  assert.equal(v.supportSession.active, false);
  assert.equal(v.supportSession.denyReason, 'untrusted_path');
});

test('#118 Admin ohne Override -> normaler Heimat-Mandant, volle Rechte', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env, directory: dir });
  assert.equal(v.supportSession.requested, false);
  assert.equal(v.supportSession.active, false);
  assert.equal(v.tenantId, FALTRIX);
  assert.equal(v.can('system.verwalten'), true);
});

test('#118 nicht klebrig: ohne Header (Folge-Request) sofort wieder Heimat-Mandant', () => {
  const withOverride = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env, directory: dir, supportTenant: 'acme' });
  const withoutOverride = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env, directory: dir });
  assert.equal(withOverride.tenantId, 'acme');
  assert.equal(withoutOverride.tenantId, FALTRIX, 'kein serverseitiger Sitzungs-Zustand');
});

// ── breakGlassDecision (Statuscode-Mapping) ────────────────────────────────────

function viewerWith(supportTenant, login = ADMIN, remoteAddress = '127.0.0.1') {
  return resolveViewer({ login, remoteAddress, env, directory: dir, supportTenant });
}

test('#118 breakGlassDecision: aktiver Override + GET -> allow', () => {
  const d = breakGlassDecision(viewerWith('acme'), 'GET');
  assert.equal(d.kind, 'allow');
  assert.equal(d.outcome, 'allow');
});

test('#118 breakGlassDecision: aktiver Override + POST/PUT/PATCH/DELETE -> 403', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const d = breakGlassDecision(viewerWith('acme'), m);
    assert.equal(d.kind, 'block', m);
    assert.equal(d.status, 403, m);
    assert.equal(d.code, 'SUPPORT_SESSION_READ_ONLY', m);
    assert.equal(d.outcome, 'denied', m);
  }
});

test('#118 breakGlassDecision: nicht-existenter Ziel-Mandant -> 404 + denied', () => {
  const d = breakGlassDecision(viewerWith('ghost'), 'GET');
  assert.equal(d.kind, 'block');
  assert.equal(d.status, 404);
  assert.equal(d.code, 'NOT_FOUND');
  assert.equal(d.outcome, 'denied');
});

test('#118 breakGlassDecision: Nicht-Admin-Header -> ignore (kein hartes 403) + denied-Audit', () => {
  const d = breakGlassDecision(viewerWith('acme', 'gast@extern.test'), 'POST');
  assert.equal(d.kind, 'ignore');
  assert.equal(d.outcome, 'denied');
});

test('#118 breakGlassDecision: kein Override -> none', () => {
  const d = breakGlassDecision(viewerWith(null), 'POST');
  assert.equal(d.kind, 'none');
});

// ── B) Spawned-Server: End-to-End-Audit der ignorierten Override-Attacke ────────
function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET', headers: opts.headers || {} },
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
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

test('#118 Spawned: Nicht-Admin-Override-Versuch wird auditiert (alle Pflichtfelder) und NICHT blockiert', async () => {
  const port = await getFreePort();
  const auditPath = path.join(os.tmpdir(), `bg-audit-${process.pid}-${port}.jsonl`);
  try { fs.rmSync(auditPath, { force: true }); } catch { /* egal */ }
  // Ohne PG ist die Registry nicht anwendbar -> kein Plattform-Admin -> Override
  // wird ignoriert (denyReason not_admin), aber auditiert.
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test', DASHBOARD_AUDIT_LOG: auditPath });
  try {
    const res = await request(port, '/', {
      headers: { 'tailscale-user-login': 'admin@example.test', 'x-support-tenant': 'acme' },
    });
    assert.notEqual(res.status, 403, 'ignorierter Header blockiert nicht');
    assert.notEqual(res.status, 404, 'kein hartes 404 beim ignorierten Versuch');

    const lines = fs.readFileSync(auditPath, 'utf8').trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
    const bg = lines.find((e) => e.event === 'break_glass_ignored');
    assert.ok(bg, 'break_glass_ignored-Audit-Eintrag vorhanden');
    // SPEC-Pflichtfelder vollständig:
    for (const field of ['timestamp', 'login', 'homeTenant', 'targetTenant', 'endpoint', 'method', 'outcome', 'sourceAddress', 'requestId']) {
      assert.ok(Object.prototype.hasOwnProperty.call(bg, field), `Pflichtfeld ${field} im Audit`);
    }
    assert.equal(bg.outcome, 'denied');
    assert.equal(bg.targetTenant, 'acme');
    assert.equal(bg.method, 'GET');
    assert.equal(bg.endpoint, '/');
    assert.ok(bg.requestId, 'requestId gesetzt');
  } finally {
    child.kill();
    try { fs.rmSync(auditPath, { force: true }); } catch { /* egal */ }
  }
});
