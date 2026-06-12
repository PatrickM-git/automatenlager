'use strict';

/**
 * Etappe 3 (Audit H2/M1) — Verdrahtung im echten server.js (Spawned).
 *  - Default (kein CF_ORIGIN_SECRET): Origin-Schutz INERT — API normal erreichbar.
 *  - CF_ORIGIN_SECRET gesetzt: ohne Header ⇒ 403, mit Header ⇒ durch; /health
 *    bleibt IMMER erreichbar (Render-Healthcheck).
 *  - Rate-Limit: über dem Limit ⇒ 429; /health nie limitiert; Server lebt weiter.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');

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
    req.end();
  });
}
function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'k',
      DASHBOARD_V2_PG_URL: '', DASHBOARD_V2_APP_PG_URL: '', SUPABASE_URL: '', DASHBOARD_AUTH_MODE: '',
      CF_ORIGIN_SECRET: '', RATE_LIMIT_MAX: '', RATE_LIMIT_WINDOW_MS: '',
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

test('#H2 Spawned: ohne CF_ORIGIN_SECRET ist der Origin-Schutz inert (API erreichbar)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {});
  try {
    const r = await request(port, '/api/v2/viewer');
    assert.equal(r.status, 200, 'inert ⇒ kein 403');
  } finally { child.kill(); }
});

test('#H2 Spawned: mit CF_ORIGIN_SECRET ⇒ ohne Header 403, mit Header durch, /health immer offen', async () => {
  const port = await getFreePort();
  const SECRET = 'cf-origin-secret-spawned-1';
  const child = await startDashboard(port, { CF_ORIGIN_SECRET: SECRET });
  try {
    const direct = await request(port, '/api/v2/viewer');
    assert.equal(direct.status, 403, 'Direktzugriff (kein Cloudflare-Header) ⇒ 403');

    const viaCf = await request(port, '/api/v2/viewer', { headers: { 'x-cf-origin-secret': SECRET } });
    assert.equal(viaCf.status, 200, 'mit korrektem Origin-Header ⇒ durch');

    const health = await request(port, '/health');
    assert.equal(health.status, 200, '/health bleibt IMMER offen (Render-Healthcheck)');
  } finally { child.kill(); }
});

test('#M1 Spawned: über dem Rate-Limit ⇒ 429; /health nie limitiert; Server lebt', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000' });
  try {
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await request(port, '/api/v2/auth/config');
      if (r.status === 429) { got429 = true; assert.ok(r.headers['retry-after'], 'Retry-After-Header gesetzt'); break; }
    }
    assert.ok(got429, 'nach genug Requests greift das Limit (429)');

    // /health darf trotz ausgeschöpftem Limit weiter antworten (eigene Ausnahme).
    let healthOk = 0;
    for (let i = 0; i < 8; i++) { const h = await request(port, '/health'); if (h.status === 200) healthOk++; }
    assert.ok(healthOk >= 8, '/health wird NIE limitiert');
  } finally { child.kill(); }
});
