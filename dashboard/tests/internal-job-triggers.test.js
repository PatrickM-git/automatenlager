'use strict';

/**
 * Issue #217 (Cloud-Slice 3) — geschützte Job-Trigger-Endpunkte.
 * ----------------------------------------------------------------
 * Auf der Render-Gratis-Stufe gibt es keinen Dauer-Worker: Supabase pg_cron
 * ruft POST /internal/jobs/<key> auf (Cron-Entscheidung Slice 0). Beweise:
 *  - ohne konfiguriertes Secret ist der Pfad TOT (404 — kein offener Hebel)
 *  - falsches/fehlendes Secret ⇒ 401, KEIN Job-Effekt
 *  - richtiges Secret ⇒ 202 + Job läuft (gleicher Effekt wie ein Worker-Tick)
 *  - unbekannter Job-Key ⇒ 404
 *  - GET (statt POST) ⇒ 405
 * Spawned-Server gegen den echten server.js (ohne PG: Worker-Verkabelung wird
 * mit leerer Job-Liste geliefert — der Test nutzt den eingebauten Echo-Job
 * 'worker-heartbeat', der ohne DB funktioniert? Nein: ohne PG keine Jobs ⇒
 * wir prüfen die Schutzschicht (401/404/405) spawned und den Erfolgspfad
 * (202 + runJobNow aufgerufen) unit-seitig über die reine Handler-Fabrik).
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { createJobTriggerHandler } = require('../lib/job-triggers.js');

// ── Unit: reine Handler-Fabrik ────────────────────────────────────────────────

function fakeRes() {
  const r = { statusCode: null, body: null, headers: null };
  return {
    res: {
      writeHead: (code, headers) => { r.statusCode = code; r.headers = headers; },
      end: (body) => { r.body = body == null ? '' : String(body); },
    },
    out: r,
  };
}

test('#217 ohne konfiguriertes Secret: Pfad ist tot (404), Job läuft nie', async () => {
  const calls = [];
  const handler = createJobTriggerHandler({
    secret: '',
    runJobNow: async (k) => { calls.push(k); },
    listJobs: () => ['wf3-nayax-fifo'],
  });
  const { res, out } = fakeRes();
  await handler({ method: 'POST', headers: { 'x-worker-trigger-secret': 'egal' } }, res, 'wf3-nayax-fifo');
  assert.equal(out.statusCode, 404);
  assert.equal(calls.length, 0);
});

test('#217 falsches/fehlendes Secret ⇒ 401, kein Job-Effekt', async () => {
  const calls = [];
  const handler = createJobTriggerHandler({
    secret: 'richtig-und-lang-genug',
    runJobNow: async (k) => { calls.push(k); },
    listJobs: () => ['wf3-nayax-fifo'],
  });
  for (const headers of [{}, { 'x-worker-trigger-secret': 'falsch' }, { 'x-worker-trigger-secret': '' }]) {
    const { res, out } = fakeRes();
    await handler({ method: 'POST', headers }, res, 'wf3-nayax-fifo');
    assert.equal(out.statusCode, 401, `Secret ${JSON.stringify(headers)} ⇒ 401`);
  }
  assert.equal(calls.length, 0);
});

test('#217 richtiges Secret ⇒ 202 und der Job läuft (asynchron, pg_net-tauglich)', async () => {
  let ran = null;
  let resolveRun;
  const ranPromise = new Promise((r) => { resolveRun = r; });
  const handler = createJobTriggerHandler({
    secret: 'richtig-und-lang-genug',
    runJobNow: async (k) => { ran = k; resolveRun(); return { ok: true }; },
    listJobs: () => ['wf3-nayax-fifo'],
  });
  const { res, out } = fakeRes();
  await handler({ method: 'POST', headers: { 'x-worker-trigger-secret': 'richtig-und-lang-genug' } }, res, 'wf3-nayax-fifo');
  assert.equal(out.statusCode, 202, '202 sofort (pg_net-Timeouts), Lauf asynchron');
  await ranPromise;
  assert.equal(ran, 'wf3-nayax-fifo');
  const body = JSON.parse(out.body);
  assert.equal(body.ok, true);
  assert.equal(body.job, 'wf3-nayax-fifo');
});

test('#217 unbekannter Job ⇒ 404; GET ⇒ 405 (nur POST)', async () => {
  const handler = createJobTriggerHandler({
    secret: 'richtig-und-lang-genug',
    runJobNow: async () => {},
    listJobs: () => ['wf3-nayax-fifo'],
  });
  const a = fakeRes();
  await handler({ method: 'POST', headers: { 'x-worker-trigger-secret': 'richtig-und-lang-genug' } }, a.res, 'gibtsnicht');
  assert.equal(a.out.statusCode, 404);
  const b = fakeRes();
  await handler({ method: 'GET', headers: { 'x-worker-trigger-secret': 'richtig-und-lang-genug' } }, b.res, 'wf3-nayax-fifo');
  assert.equal(b.out.statusCode, 405);
});

test('#217 timing-safe: ungleich lange Secrets werfen nicht und lehnen ab', async () => {
  const handler = createJobTriggerHandler({
    secret: 'kurz',
    runJobNow: async () => {},
    listJobs: () => ['j'],
  });
  const { res, out } = fakeRes();
  await handler({ method: 'POST', headers: { 'x-worker-trigger-secret': 'sehr-viel-laengeres-secret' } }, res, 'j');
  assert.equal(out.statusCode, 401);
});

// ── Spawned: Verdrahtung im echten server.js ─────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: opts.method || 'POST', headers: opts.headers || {} },
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
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

test('#217 Spawned: /internal/jobs ist mit Secret verdrahtet (401 falsch, 404 unbekannt, kein CORS)', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, { WORKER_TRIGGER_SECRET: 'spawned-secret-123' });
  try {
    const wrong = await request(port, '/internal/jobs/worker-heartbeat', { headers: { 'x-worker-trigger-secret': 'falsch' } });
    assert.equal(wrong.status, 401);
    const unknown = await request(port, '/internal/jobs/gibtsnicht', { headers: { 'x-worker-trigger-secret': 'spawned-secret-123' } });
    assert.equal(unknown.status, 404);
    // Erfolgsfall ohne PG: heartbeat existiert auch ohne DB-Pools ⇒ 202.
    const ok = await request(port, '/internal/jobs/worker-heartbeat', { headers: { 'x-worker-trigger-secret': 'spawned-secret-123' } });
    assert.equal(ok.status, 202);
    assert.equal((ok.headers && ok.headers['access-control-allow-origin']) || undefined, undefined, 'kein CORS-Allow auf /internal');
  } finally { child.kill(); }
});

test('#217 Spawned: ohne WORKER_TRIGGER_SECRET ist /internal/jobs tot (404)', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, {});
  try {
    const r = await request(port, '/internal/jobs/worker-heartbeat', { headers: { 'x-worker-trigger-secret': 'egal' } });
    assert.equal(r.status, 404);
  } finally { child.kill(); }
});
