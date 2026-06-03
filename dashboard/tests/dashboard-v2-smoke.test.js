'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  buildOverviewData,
  buildMonitoringData,
} = require('../lib/overview-monitoring.js');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, urlPath, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body;
  const headers = { ...(opts.headers || {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, text: () => raw, json: () => JSON.parse(raw) });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
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
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

const SMOKE_RAW = {
  nowIso: '2026-05-27T10:00:00.000Z',
  openWarningsCount: 2,
  mhdRiskCount: 1,
  lowStockCount: 3,
  economicsToday: { revenueGross: 53.5, revenueNet: 45.0, quantity: 12 },
  workflowRuns: [
    { workflow_key: 'WF-Monitor', status: 'success', started_at: '2026-05-27T09:54:00.000Z', finished_at: '2026-05-27T09:55:00.000Z' },
    { workflow_key: 'WF-Val', status: 'success', started_at: '2026-05-27T04:14:00.000Z', finished_at: '2026-05-27T04:15:00.000Z' },
  ],
  warnings: [],
};

test('AC-COVERAGE: v2 overview covers all legacy business data categories', () => {
  const overview = buildOverviewData(SMOKE_RAW);
  const monitoring = buildMonitoringData(SMOKE_RAW);

  // Umsatz (brutto, live aus sales_transactions) + netto
  assert.equal(overview.metrics.revenueGrossToday, 53.5, 'overview must expose gross revenue (Umsatz heute)');
  assert.equal(overview.metrics.revenueNetToday, 45.0, 'overview must expose net revenue');
  // Verkäufe (Stückzahl)
  assert.equal(overview.metrics.quantityToday, 12, 'overview must expose sales count (Verkäufe)');
  // Bestand MHD-Risiken
  assert.equal(overview.metrics.mhdRiskCount, 1, 'overview must expose MHD risk count');
  // Lagerbestand unter Ziel
  assert.equal(overview.metrics.lowStockCount, 3, 'overview must expose low stock count');
  // Offene Warnungen
  assert.equal(overview.metrics.openWarningsCount, 2, 'overview must expose open warning count');
  // Validierungsstatus
  const validationAmpel = monitoring.ampels.find((a) => a.key === 'validation');
  assert.ok(validationAmpel, 'monitoring must expose validation status ampel');
  assert.ok(['green', 'yellow', 'red'].includes(validationAmpel.state), 'validation ampel must have valid state');
  // Letzte Workflow-Läufe
  const workflowAmpel = monitoring.ampels.find((a) => a.key === 'workflows');
  assert.ok(workflowAmpel, 'monitoring must expose workflow run status ampel');
  assert.ok(['green', 'yellow', 'red'].includes(workflowAmpel.state), 'workflow ampel must have valid state');
});

test('AC-READONLY: all v2 write endpoints return 403 for guest users', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  const guestHeaders = { 'tailscale-user-login': 'guest@example.test' };

  const writeEndpoints = [
    ['/api/v2/refill/trigger', 'refill trigger'],
    ['/api/v2/slot-change/confirm', 'slot-change confirm'],
    ['/api/v2/actions/smoke-test/trigger', 'v2 action trigger'],
    ['/api/v2/uploads/invoice', 'upload invoice'],
    ['/api/v2/locations', 'locations write'],
    ['/api/v2/machine-profiles', 'machine-profiles write'],
  ];

  for (const [urlPath, label] of writeEndpoints) {
    const res = await request(port, urlPath, { method: 'POST', headers: guestHeaders, body: '{}' });
    assert.equal(res.status, 403, `${label} must return 403 for guest`);
    const body = res.json();
    assert.equal(body.ok, false, `${label} 403 response must have ok:false`);
  }
});

test('AC-CUTOVER: docs/cutover-v2.md exists and contains required sections', () => {
  const runbookPath = path.join(process.cwd(), 'docs', 'cutover-v2.md');
  assert.ok(fs.existsSync(runbookPath), 'docs/cutover-v2.md must exist in dashboard docs');

  const content = fs.readFileSync(runbookPath, 'utf8');
  assert.match(content, /Voraussetzungen|Prerequisites/i, 'runbook must have prerequisites section');
  assert.match(content, /Rollback/i, 'runbook must have rollback section');
  assert.match(content, /Validierung|Smoke.?Test/i, 'runbook must have validation section');
  assert.match(content, /Legacy/i, 'runbook must reference legacy fallback');
});
