'use strict';

// Issue #218 — CORS-Verdrahtung im echten server.js (Spawned).
//  - OPTIONS-Preflight von erlaubter Origin ⇒ 204 + Access-Control-Allow-Origin
//  - GET von erlaubter Origin ⇒ Echo-Header; von fremder Origin ⇒ keine Header
//  - ohne DASHBOARD_CORS_ORIGINS (Mini) ⇒ CORS inert (keine Header, OPTIONS != 204-Spezialfall)

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ALLOWED = 'https://app.faltrix-solutions.de';

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
    env: { ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'k', DASHBOARD_V2_PG_URL: '', DASHBOARD_V2_APP_PG_URL: '', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); } });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

test('#218 Spawned: Preflight + Echo für erlaubte Origin, Default-Deny für fremde', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_CORS_ORIGINS: ALLOWED });
  try {
    // Preflight von erlaubter Origin ⇒ 204 + Allow-Origin.
    const pre = await request(port, '/api/v2/viewer', { method: 'OPTIONS', headers: { origin: ALLOWED, 'access-control-request-method': 'GET' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ALLOWED);
    assert.match(pre.headers['access-control-allow-headers'], /authorization/i);
    assert.equal(pre.headers['access-control-allow-credentials'], undefined, 'keine Cookie-Credentials');

    // GET von erlaubter Origin ⇒ Echo-Header.
    const ok = await request(port, '/api/v2/viewer', { headers: { origin: ALLOWED } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], ALLOWED);

    // GET von FREMDER Origin ⇒ keine CORS-Header (Default-Deny).
    const evil = await request(port, '/api/v2/viewer', { headers: { origin: 'https://boese.example.com' } });
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
  } finally { child.kill(); }
});

test('#218 Spawned: ohne DASHBOARD_CORS_ORIGINS (Mini) ist CORS inert', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, {});
  try {
    const r = await request(port, '/api/v2/viewer', { headers: { origin: ALLOWED } });
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'keine CORS-Header ohne Allowlist');
    // OPTIONS ohne Allowlist fällt NICHT in den 204-Preflight-Zweig (kein Spezialverhalten).
    const opt = await request(port, '/api/v2/viewer', { method: 'OPTIONS', headers: { origin: ALLOWED, 'access-control-request-method': 'GET' } });
    assert.notEqual(opt.status, 204);
  } finally { child.kill(); }
});
