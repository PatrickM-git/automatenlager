'use strict';
// #30: /api/config nur mit system.verwalten; maskierte Rückgaben; kein Secret im Log.
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const SECRET = 'SECRET-n8n-key-ABCDEF1234567890';

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function start(port, auditPath, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: SECRET,
      DASHBOARD_ADMIN_LOGIN: 'patrick@example.test', DASHBOARD_AUDIT_LOG: auditPath, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { child.kill(); reject(new Error('no start')); }, 10000);
    child.stdout.on('data', (c) => { if (String(c).includes(`http://localhost:${port}`)) { clearTimeout(to); resolve(child); } });
    child.stderr.resume();
    child.on('exit', (code) => { if (code) { clearTimeout(to); reject(new Error('exit ' + code)); } });
  });
}
// Unter paralleler Test-Last bricht eine einzelne Verbindung gelegentlich mit
// ECONNRESET ab (fetch failed). Solche transienten Netzwerkfehler einige Male
// wiederholen, damit der Test stabil bleibt (kein Logikfehler, reine Flakiness).
async function req(port, pathname, { method = 'GET', headers = {} } = {}, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}

test('#30 GET /api/config ohne system.verwalten (Gast) → 403, kein Secret', async (t) => {
  const audit = path.join(os.tmpdir(), `cfg-audit-${Date.now()}-a.jsonl`);
  const port = await freePort();
  const child = await start(port, audit);
  t.after(() => { child.kill(); fs.rmSync(audit, { force: true }); });
  const res = await req(port, '/api/config', { headers: { 'Tailscale-User-Login': 'gast@example.test' } });
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes(SECRET));
});

test('#30 POST /api/config ohne system.verwalten (Gast) → 403 (Schreib-Lücke geschlossen)', async (t) => {
  const audit = path.join(os.tmpdir(), `cfg-audit-${Date.now()}-b.jsonl`);
  const port = await freePort();
  const child = await start(port, audit);
  t.after(() => { child.kill(); fs.rmSync(audit, { force: true }); });
  const res = await req(port, '/api/config', { method: 'POST', headers: { 'Tailscale-User-Login': 'gast@example.test', 'Content-Type': 'application/json' } });
  assert.equal(res.status, 403);
});

test('#30 GET /api/config als Admin → maskiert, NIE Klartext-Secret; Secret nicht im Log', async (t) => {
  const audit = path.join(os.tmpdir(), `cfg-audit-${Date.now()}-c.jsonl`);
  const port = await freePort();
  const child = await start(port, audit, { DASHBOARD_DEV_LOCAL_ADMIN: '1' });
  t.after(() => { child.kill(); fs.rmSync(audit, { force: true }); });
  const res = await req(port, '/api/config'); // loopback + dev-flag → Eigentümer
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(SECRET), 'Klartext-Secret darf NICHT in der Antwort sein');
  const body = JSON.parse(text);
  assert.equal(body.hasApiKey, true);
  assert.ok(body.apiKeyMasked && body.apiKeyMasked.includes('•'), 'maskiert');
  // Audit-Log darf das Secret nie enthalten.
  if (fs.existsSync(audit)) { assert.ok(!fs.readFileSync(audit, 'utf8').includes(SECRET)); }
});
