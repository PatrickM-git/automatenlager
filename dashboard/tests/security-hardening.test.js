'use strict';

/**
 * Pre-Go-Live-Sicherheitshärtung (Audit 2026-06-12) — Regressionsschutz.
 * Schreibt die neuen Sicherheits-Invarianten fest, damit sie nicht versehentlich
 * zurückgebaut werden. Spawned der echte server.js.
 *
 *  - C1: SUPABASE_URL in der Prozess-Umgebung ⇒ Tailscale-Header wird IGNORIERT
 *        (kein Header-Spoofing-Admin im Cloud-Kontext), auch ohne DASHBOARD_AUTH_MODE.
 *  - H1: 500-Antworten enthalten KEINEN Stack-Trace / keine internen Pfade.
 *  - M2: Security-Header (nosniff, X-Frame-Options DENY, HSTS, Referrer-Policy)
 *        auf jeder Antwort.
 *  - M3: /api/v2/status ist anonym nur eine grobe Ampel (keine Job-Internas).
 *  - DoS: übergroßer JSON-Body wird abgewiesen, nicht akkumuliert.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ADMIN = 'admin@example.test';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET', headers: opts.headers || {} },
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function startDashboard(port, envOverrides = {}) {
  // Hermetisch: SUPABASE_URL/AUTH_MODE explizit kontrollieren (nicht aus der
  // Test-Shell/.env.local erben), damit der Auth-Modus deterministisch ist.
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'k',
      DASHBOARD_V2_PG_URL: '', DASHBOARD_V2_APP_PG_URL: '',
      SUPABASE_URL: '', DASHBOARD_AUTH_MODE: '', DASHBOARD_ADMIN_LOGIN: ADMIN,
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); } });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

test('#C1 Spawned: SUPABASE_URL gesetzt ⇒ Tailscale-Header-Spoofing wirkungslos (Gast)', async () => {
  const port = await getFreePort();
  // Cloud-Kontext simulieren: SUPABASE_URL gesetzt, aber DASHBOARD_AUTH_MODE NICHT.
  const child = await startDashboard(port, { SUPABASE_URL: 'https://x.supabase.co', DASHBOARD_AUTH_MODE: '' });
  try {
    const spoof = await request(port, '/api/v2/viewer', { headers: { 'tailscale-user-login': ADMIN } });
    const viewer = JSON.parse(spoof.body).viewer;
    assert.equal(viewer.role, 'guest', 'gefälschter Tailscale-Header darf im Cloud-Kontext NICHT zum Admin werden');
    assert.equal(viewer.canTriggerActions, false);
  } finally { child.kill(); }
});

test('#C1 Spawned: ohne SUPABASE_URL (Mini) bleibt der Tailscale-Header gültig', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {}); // kein SUPABASE_URL ⇒ tailscale-Mode
  try {
    const ok = await request(port, '/api/v2/viewer', { headers: { 'tailscale-user-login': ADMIN } });
    assert.equal(JSON.parse(ok.body).viewer.role, 'admin', 'Mini-Pfad (Tailscale-Header) unverändert');
  } finally { child.kill(); }
});

test('#M2 Spawned: Security-Header auf jeder Antwort', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {});
  try {
    const r = await request(port, '/health');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(r.headers['referrer-policy'] || '', /strict-origin/);
    assert.match(r.headers['strict-transport-security'] || '', /max-age=\d+/);
  } finally { child.kill(); }
});

test('#M3 Spawned: /api/v2/status anonym liefert NUR die Ampel (keine Job-Internas)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {});
  try {
    const r = await request(port, '/api/v2/status');
    const body = JSON.parse(r.body);
    assert.ok(['ok', 'degraded', 'down'].includes(body.overall), 'overall-Ampel vorhanden');
    assert.equal(body.components, undefined, 'KEINE Job-/Komponenten-Details für Anonyme');
    assert.equal(Array.isArray(body.jobs), false, 'keine Job-Liste für Anonyme');
  } finally { child.kill(); }
});

test('#H1 Spawned: 500-Antworten leaken keinen Stack-Trace', async () => {
  // Wir können hier keinen garantierten 500 provozieren (Endpunkte sind robust);
  // stattdessen das STRUKTURELLE Versprechen prüfen: der Quelltext sendet im
  // 500-Pfad keinen `stack` mehr nach außen.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  assert.ok(!/sendJson\(res,\s*500,\s*\{\s*error:\s*error\.message,\s*stack:\s*error\.stack/.test(src),
    'der alte Stack-Leak (stack: error.stack im 500-Body) darf nicht zurückkommen');
  assert.match(src, /INTERNAL_ERROR/, 'generische 500-Antwort vorhanden');
});

test('#DoS Spawned: übergroßer JSON-Body wird abgewiesen (nicht akkumuliert)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {});
  try {
    // 2 MB Body (> 1 MB Limit) an einen JSON-POST-Endpunkt. Erwartung: KEIN
    // 200/Erfolg, KEIN Absturz (Server antwortet weiter auf /health).
    const huge = JSON.stringify({ x: 'A'.repeat(2 * 1024 * 1024) });
    const res = await request(port, '/api/v2/refill/trigger', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: huge,
    });
    assert.notEqual(res.status, 200, 'übergroßer Body darf nicht als Erfolg durchgehen');
    const health = await request(port, '/health');
    assert.equal(health.status, 200, 'Server lebt nach dem Flooding-Versuch weiter');
  } finally { child.kill(); }
});
