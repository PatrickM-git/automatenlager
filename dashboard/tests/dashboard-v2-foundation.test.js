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

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: headers.__method || 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json: () => JSON.parse(body),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
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

test('Dashboard v2 is reachable under /v2 without replacing the legacy dashboard', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);

  t.after(() => {
    dashboard.kill();
  });

  const rootRedirect = await request(port, '/');
  const legacy = await request(port, '/v1');
  const v2 = await request(port, '/v2');

  // Root leitet auf v3 um; Legacy bleibt unter /v1 erreichbar.
  assert.equal(rootRedirect.status, 302);
  assert.equal(rootRedirect.headers.location, '/v3');
  assert.equal(legacy.status, 200);
  assert.match(legacy.body, /Automatenlager Leitstand/);
  assert.doesNotMatch(legacy.body, /Dashboard v2/);

  assert.equal(v2.status, 200);
  assert.match(v2.headers['content-type'], /text\/html/);
  assert.match(v2.body, /Dashboard v2/);
  assert.match(v2.body, /Legacy-Dashboard/);
  assert.match(v2.body, /\/api\/v2\/overview/);
});

test('Dashboard v2 read endpoints expose stable PostgreSQL-first contracts', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: '',
  });

  t.after(() => {
    dashboard.kill();
  });

  const endpoints = [
    ['/api/v2/overview', 'overview'],
    ['/api/v2/inventory-mhd', 'inventory-mhd'],
    ['/api/v2/economics', 'economics'],
    ['/api/v2/assortment-slots', 'assortment-slots'],
    ['/api/v2/monitoring', 'monitoring'],
  ];

  for (const [endpoint, area] of endpoints) {
    const response = await request(port, endpoint);
    assert.equal(response.status, 503, `${endpoint} should fail explicitly while PG is unconfigured`);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.area, area);
    assert.equal(body.source, 'postgres');
    assert.equal(body.data, null);
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(body.generatedAtDisplay, /\bMESZ\b|\bMEZ\b/);
    assert.equal(body.lastSuccessfulAt, null);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
    assert.match(body.error.message, /PostgreSQL/);
  }
});

test('Dashboard v2 PG failures expose last successful PG timestamp without legacy fallback', async (t) => {
  const lastSuccessFile = path.join(os.tmpdir(), `dashboard-v2-last-success-${Date.now()}.json`);
  fs.writeFileSync(lastSuccessFile, JSON.stringify({
    overview: {
      generatedAt: '2026-05-25T12:34:56.000Z',
    },
  }), 'utf8');

  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: '',
    DASHBOARD_V2_LAST_SUCCESS_FILE: lastSuccessFile,
  });

  t.after(() => {
    dashboard.kill();
    fs.rmSync(lastSuccessFile, { force: true });
  });

  const response = await request(port, '/api/v2/overview');
  assert.equal(response.status, 503);
  const body = response.json();

  assert.equal(body.ok, false);
  assert.equal(body.source, 'postgres');
  assert.equal(body.lastSuccessfulAt, '2026-05-25T12:34:56.000Z');
  assert.match(body.lastSuccessfulAtDisplay, /\bMESZ\b|\bMEZ\b/);
  assert.notEqual(body.source, 'local_xlsx');
  assert.notEqual(body.source, 'google_sheets_live');
});

test('Dashboard v2 mutating actions respect Admin and Read-Only roles', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);

  t.after(() => {
    dashboard.kill();
  });

  const guest = await request(port, '/api/v2/actions/smoke-test/trigger', {
    __method: 'POST',
    'Tailscale-User-Login': 'freund@example.test',
  });
  assert.equal(guest.status, 403);
  const guestBody = guest.json();
  assert.equal(guestBody.ok, false);
  assert.equal(guestBody.viewer.role, 'guest');
  assert.equal(guestBody.error.code, 'READ_ONLY_FORBIDDEN');

  const admin = await request(port, '/api/v2/actions/smoke-test/trigger', {
    __method: 'POST',
    'Tailscale-User-Login': 'patrick@example.test',
  });
  assert.equal(admin.status, 501);
  const adminBody = admin.json();
  assert.equal(adminBody.ok, false);
  assert.equal(adminBody.viewer.role, 'admin');
  assert.equal(adminBody.error.code, 'V2_ACTION_NOT_IMPLEMENTED');
});

test('Dashboard v2 shell exposes Faltrix branding and respects reduced motion', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.html'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.css'), 'utf8');

  assert.match(html, /Faltrix/);
  assert.match(html, /Dashboard v2/);
  assert.match(html, /id="v2Status"[^>]*role="status"/);
  assert.match(html, /id="v2Status"[^>]*aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /animation:\s*none/);
});
