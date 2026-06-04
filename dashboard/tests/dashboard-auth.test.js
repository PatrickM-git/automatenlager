const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function getFreePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startMockN8n() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });

    if (req.url.startsWith('/api/v1/workflows')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        data: [
          {
            id: 'wf1',
            name: 'WF1 - Rechnungseingang automatisch mit Claude',
            active: true,
            updatedAt: '2026-05-23T10:00:00.000Z',
            nodes: [
              {
                name: 'Dashboard Webhook',
                type: 'n8n-nodes-base.webhook',
                parameters: {
                  path: 'dashboard-test-wf1',
                  httpMethod: 'POST',
                },
              },
            ],
          },
        ],
      }));
      return;
    }

    if (req.url === '/webhook/dashboard-test-wf1') {
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return { server, calls };
}

function requestDashboard(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          json: () => JSON.parse(body),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function startDashboard(port, n8nPort, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: `http://127.0.0.1:${n8nPort}`,
      N8N_API_KEY: 'test-key',
      DASHBOARD_ADMIN_LOGIN: 'patrick@example.test',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Dashboard server did not start in time'));
    }, 10_000);

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
        reject(new Error(`Dashboard server exited with code ${code}`));
      }
    });
  });
}

test('guest users cannot trigger workflow actions', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/actions/invoice-intake/trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Tailscale-User-Login': 'freund@example.test',
    },
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test('requests with explicit non-admin Tailscale identity are guests on tailnet hosts', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  // Requests WITHOUT identity header = operator trust (no Tailscale Serve injecting headers).
  // Guest status requires an explicit tailscale-user-login identifying a non-admin account.
  const response = await requestDashboard(dashboardPort, {
    method: 'POST',
    path: '/api/actions/invoice-intake/trigger',
    headers: {
      'Content-Type': 'application/json',
      Host: 'hp-mini-server.tail573a13.ts.net:8787',
      'tailscale-user-login': 'guest@other-org.example',
    },
  });

  assert.equal(response.status, 403);
  const body = response.json();
  assert.equal(body.viewer.login, 'guest@other-org.example');
  assert.equal(body.viewer.role, 'guest');
  assert.equal(mockN8n.calls.some((call) => call.method === 'POST' && call.url === '/webhook/dashboard-test-wf1'), false);
});

test('#27 Default-Deny: kein Header + kein Dev-Flag -> Gast (kann nicht auslösen)', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  // KEIN DASHBOARD_DEV_LOCAL_ADMIN -> Default-Deny greift, auch auf Loopback.
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/actions/invoice-intake/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  assert.equal(response.status, 403, 'ohne Header/Flag kein Admin mehr (Kern-Regression)');
  assert.equal(mockN8n.calls.some((call) => call.method === 'POST' && call.url === '/webhook/dashboard-test-wf1'), false);
});

test('#27 Dev-Notausgang: localhost ohne Header MIT DASHBOARD_DEV_LOCAL_ADMIN -> Admin', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort, { DASHBOARD_DEV_LOCAL_ADMIN: '1' });

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/actions/invoice-intake/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(mockN8n.calls.some((call) => call.method === 'POST' && call.url === '/webhook/dashboard-test-wf1'), true);
});

test('admin users can still trigger workflow actions', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/actions/invoice-intake/trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Tailscale-User-Login': 'patrick@example.test',
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(mockN8n.calls.some((call) => call.method === 'POST' && call.url === '/webhook/dashboard-test-wf1'), true);
});

test('dashboard response exposes guest permissions from Tailscale login', async (t) => {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort);

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
  });

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/dashboard`, {
    headers: {
      'Tailscale-User-Login': 'freund@example.test',
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.viewer.login, 'freund@example.test');
  assert.equal(body.viewer.role, 'guest');
  assert.equal(body.viewer.canTriggerActions, false);
});

// ── #28 RBAC: serverseitige Fähigkeits-Durchsetzung (403) ───────────────────

async function startWithOperator(t) {
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const port = await getFreePort();
  const dashboard = await startDashboard(port, n8nPort, { DASHBOARD_OPERATOR_LOGIN: 'operator@example.test' });
  t.after(() => { dashboard.kill(); mockN8n.server.close(); });
  return port;
}
const OP_HDR = { 'Content-Type': 'application/json', 'Tailscale-User-Login': 'operator@example.test' };
const GUEST_HDR = { 'Content-Type': 'application/json', 'Tailscale-User-Login': 'gast@example.test' };

test('#28 Auffüller DARF Bestand schreiben (kein 403 am bestand.schreiben-Endpunkt)', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/v2/inventory/write-off`, { method: 'POST', headers: OP_HDR, body: '{}' });
  assert.notEqual(res.status, 403, 'Auffüller hat bestand.schreiben → Auth passiert (Folgefehler 400/503 ok)');
});

test('#28 Auffüller NICHT Nayax (nayax.schreiben) → 403', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/v2/nayax-abgleich/apply`, { method: 'POST', headers: OP_HDR, body: '{}' });
  assert.equal(res.status, 403);
});

test('#28 Auffüller NICHT GuV (finanzen.lesen) → 403', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/v2/economics/scope`, { headers: OP_HDR });
  assert.equal(res.status, 403);
});

test('#28 Gast NICHT Bestand schreiben → 403', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/v2/inventory/write-off`, { method: 'POST', headers: GUEST_HDR, body: '{}' });
  assert.equal(res.status, 403);
});

test('guest dashboard access is written to the audit log', async (t) => {
  const auditLogPath = path.join(os.tmpdir(), `dashboard-audit-${Date.now()}.jsonl`);
  const mockN8n = startMockN8n();
  const n8nPort = await listen(mockN8n.server);
  const dashboardPort = await getFreePort();
  const dashboard = await startDashboard(dashboardPort, n8nPort, {
    DASHBOARD_AUDIT_LOG: auditLogPath,
  });

  t.after(() => {
    dashboard.kill();
    mockN8n.server.close();
    fs.rmSync(auditLogPath, { force: true });
  });

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/dashboard`, {
    headers: {
      'Tailscale-User-Login': 'freund@example.test',
    },
  });

  assert.equal(response.status, 200);
  const lines = fs.readFileSync(auditLogPath, 'utf8').trim().split(/\r?\n/);
  const entry = JSON.parse(lines.at(-1));

  assert.equal(entry.login, 'freund@example.test');
  assert.equal(entry.role, 'guest');
  assert.equal(entry.event, 'dashboard_view');
});

// ── #29 Frontend-Gating: /api/dashboard liefert Fähigkeiten je Rolle ────────

test('#29 /api/dashboard liefert capabilities[] + roleKey (Eigentümer)', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { 'Tailscale-User-Login': 'patrick@example.test' } });
  const body = await res.json();
  assert.equal(body.viewer.roleKey, 'eigentuemer');
  assert.ok(Array.isArray(body.viewer.capabilities));
  assert.ok(body.viewer.capabilities.includes('finanzen.lesen'));
  assert.ok(body.viewer.capabilities.includes('system.verwalten'));
});

test('#29 /api/dashboard: Auffüller hat bestand.schreiben, NICHT finanzen/system', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { 'Tailscale-User-Login': 'operator@example.test' } });
  const caps = (await res.json()).viewer.capabilities;
  assert.ok(caps.includes('bestand.schreiben'));
  assert.ok(!caps.includes('finanzen.lesen'));
  assert.ok(!caps.includes('system.verwalten'));
});

test('#29 /api/dashboard: Gast hat nur betrieb.lesen', async (t) => {
  const port = await startWithOperator(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { 'Tailscale-User-Login': 'gast@example.test' } });
  const caps = (await res.json()).viewer.capabilities;
  assert.deepEqual(caps, ['betrieb.lesen']);
});
