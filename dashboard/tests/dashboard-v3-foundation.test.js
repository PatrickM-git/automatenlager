const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
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

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
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

const V3_DEEP_LINKS = [
  '/v3/guv',
  '/v3/lager',
  '/v3/slots',
  '/v3/monitoring',
  '/v3/onboarding',
  '/v3/automaten',
  '/v3/einstellungen',
];

test('v3 entry path and deep links serve the v3 shell without touching v2 or legacy', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);

  t.after(() => {
    dashboard.kill();
  });

  // v3 entry serves the v3 shell
  const entry = await request(port, '/v3');
  assert.equal(entry.status, 200, '/v3 should serve the v3 shell');
  assert.match(entry.headers['content-type'], /text\/html/);
  assert.match(entry.body, /Dashboard v3/);
  assert.match(entry.body, /Faltrix/);

  // Every deep link returns the SAME shell directly (reload/deep-link works)
  for (const deepLink of V3_DEEP_LINKS) {
    const page = await request(port, deepLink);
    assert.equal(page.status, 200, `${deepLink} should serve the v3 shell directly`);
    assert.match(page.headers['content-type'], /text\/html/, `${deepLink} should be HTML`);
    assert.match(page.body, /Dashboard v3/, `${deepLink} should return the v3 shell`);
    assert.equal(page.body, entry.body, `${deepLink} should return the identical SPA shell as /v3`);
  }

  // Root leitet seit 2026-06-02 auf v3 um (v3 = produktiver Standard).
  const root = await request(port, '/');
  assert.equal(root.status, 302, '/ should redirect to v3');
  assert.equal(root.headers.location, '/v3', '/ redirect target is /v3');

  // Legacy bleibt unter /v1 erreichbar.
  const legacy = await request(port, '/v1');
  assert.equal(legacy.status, 200);
  assert.match(legacy.body, /Automatenlager Leitstand/);
  assert.doesNotMatch(legacy.body, /Dashboard v3/);

  // v2-Frontend abgeschaltet (Issue #9): /v2 leitet dauerhaft auf /v3 um.
  const v2 = await request(port, '/v2');
  assert.equal(v2.status, 302);
  assert.equal(v2.headers.location, '/v3');
});

test('v3 static assets are served with correct content types', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);

  t.after(() => {
    dashboard.kill();
  });

  const script = await request(port, '/v3.js');
  assert.equal(script.status, 200, '/v3.js should be served');
  assert.match(script.headers['content-type'], /javascript/);

  const style = await request(port, '/v3.css');
  assert.equal(style.status, 200, '/v3.css should be served');
  assert.match(style.headers['content-type'], /text\/css/);
});

test('v3 deep links do not shadow the existing /api/v2 contracts', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, { DASHBOARD_V2_PG_URL: '' });

  t.after(() => {
    dashboard.kill();
  });

  const overview = await request(port, '/api/v2/overview');
  assert.equal(overview.status, 503, '/api/v2/overview must keep its PG-first contract');
  assert.match(overview.headers['content-type'], /application\/json/);
  const body = overview.json();
  assert.equal(body.ok, false);
  assert.equal(body.area, 'overview');
});

const PUBLIC = (file) => fs.readFileSync(path.join(process.cwd(), 'public', file), 'utf8');

test('v3 shell renders Faltrix branding and the responsive nav chrome', () => {
  const html = PUBLIC('v3.html');
  const css = PUBLIC('v3.css');

  assert.match(html, /charset="utf-8"/i, 'shell must declare UTF-8');
  assert.match(html, /Faltrix/);
  assert.match(html, /Dashboard v3/);

  // Inhalts-Outlet + beide Navigations-Container (Sidebar + Bottom-Nav)
  assert.match(html, /data-view/, 'shell needs a content outlet for the router');
  assert.match(html, /data-nav="side"/, 'desktop sidebar nav container');
  assert.match(html, /data-nav="bottom"/, 'mobile bottom nav container');

  // Responsive Umschaltung: Desktop-Breakpoint zeigt Sidebar, blendet Bottom-Nav aus
  assert.match(css, /@media\s*\(min-width:\s*880px\)/, 'desktop breakpoint switches the nav chrome');
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /--brand:\s*#/, 'single central brand token must be defined');
});

test('v3 router defines a distinct route for every page in the spec', () => {
  const js = PUBLIC('v3.js');

  const routePaths = ['/', '/guv', '/lager', '/slots', '/monitoring', '/onboarding', '/automaten', '/einstellungen'];
  for (const route of routePaths) {
    assert.ok(js.includes(`path: '${route}'`), `router must define route ${route}`);
  }

  // History-API mit Hash-Fallback
  assert.match(js, /pushState/, 'router uses the History API');
  assert.match(js, /popstate/, 'router reacts to history navigation');
  assert.match(js, /hashchange/, 'router provides a hash fallback');
});

test('v3 pages share one reusable loading/empty/error state component', () => {
  const js = PUBLIC('v3.js');
  const css = PUBLIC('v3.css');

  assert.match(js, /renderState/, 'a reusable state component must exist');
  for (const kind of ['loading', 'empty', 'error']) {
    assert.ok(js.includes(`'${kind}'`), `state component must handle the ${kind} state`);
    assert.match(css, new RegExp(`v3-state--${kind}`), `${kind} state must be styled uniformly`);
  }
});
