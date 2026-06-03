'use strict';

// Issue #9 – v2-Abschaltung. v3 deckt alle v2-Funktionen ab und ist produktiv.
// Diese Guards verhindern, dass das v2-Frontend versehentlich zurückkehrt.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startDashboard(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
      N8N_API_KEY: 'test-key',
      DASHBOARD_ADMIN_LOGIN: 'patrick@example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

test('AC-RETIRED: v2-Frontend-Assets existieren nicht mehr', () => {
  for (const asset of ['v2.html', 'v2.js', 'v2.css']) {
    assert.equal(
      fs.existsSync(path.join(process.cwd(), 'public', asset)),
      false,
      `public/${asset} darf nach der v2-Abschaltung nicht mehr existieren`,
    );
  }
});

test('AC-RETIRED: v3.html verlinkt nicht mehr auf /v2', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.html'), 'utf8');
  assert.doesNotMatch(html, /href="\/v2"/, 'v3.html darf keinen /v2-Link mehr enthalten');
});

test('AC-RETIRED: GET /v2 leitet dauerhaft auf /v3 um (302)', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  for (const p of ['/v2', '/v2/', '/v2/economics']) {
    const res = await request(port, p);
    assert.equal(res.status, 302, `${p} muss 302 liefern`);
    assert.equal(res.location, '/v3', `${p} muss nach /v3 umleiten`);
  }
});
