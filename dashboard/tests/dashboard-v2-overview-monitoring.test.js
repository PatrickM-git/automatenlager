const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const {
  buildOverviewData,
  buildMonitoringData,
  buildWarningDrilldown,
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

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
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

const RAW_DATA = {
  nowIso: '2026-05-27T10:00:00.000Z',
  openWarningsCount: 6,
  mhdRiskCount: 2,
  lowStockCount: 3,
  economicsToday: {
    revenueNet: 188.4,
    dbNet: 71.2,
    quantity: 54,
  },
  workflowRuns: [
    { workflow_key: 'WF-Monitor', status: 'success', started_at: '2026-05-27T09:54:00.000Z', finished_at: '2026-05-27T09:55:00.000Z' },
    { workflow_key: 'WF-Val', status: 'success', started_at: '2026-05-27T04:14:00.000Z', finished_at: '2026-05-27T04:15:00.000Z' },
  ],
  warnings: [
    { warning_type: 'VALIDATION_DRIFT_SHEETS_PG', severity: 'warning', resolved: false, created_at: '2026-05-27T07:22:00.000Z', warning_key: 'VALIDATION_DRIFT_SHEETS_PG|wf-val|2026-05-27', message: 'Drift bei GuV' },
    { warning_type: 'CONTAINER_DOWN', severity: 'critical', resolved: false, created_at: '2026-05-27T07:20:00.000Z', warning_key: 'CONTAINER_DOWN|homelab-n8n|2026-05-27', message: 'n8n down' },
    { warning_type: 'BACKUP_OK', severity: 'info', resolved: true, created_at: '2026-05-27T03:58:00.000Z', warning_key: 'BACKUP_OK|backup|2026-05-27', message: 'Backup erfolgreich' },
    { warning_type: 'WORKFLOW_ERROR', severity: 'warning', resolved: false, created_at: '2026-05-27T08:20:00.000Z', warning_key: 'WORKFLOW_ERROR|WF8|2026-05-27', message: 'WF8 Fehler' },
  ],
};

test('AC1: overview builds today priorities with MHD, stock and warning counters', () => {
  const overview = buildOverviewData(RAW_DATA);

  assert.equal(overview.metrics.openWarningsCount, 6);
  assert.equal(overview.metrics.mhdRiskCount, 2);
  assert.equal(overview.metrics.lowStockCount, 3);
  assert.equal(overview.metrics.revenueNetToday, 188.4);
  assert.equal(overview.metrics.dbNetToday, 71.2);
  assert.ok(Array.isArray(overview.priorities));
  assert.ok(overview.priorities.length >= 3);
});

test('AC2: monitoring exposes six compact ampels with explicit state and message', () => {
  const monitoring = buildMonitoringData(RAW_DATA);
  const keys = monitoring.ampels.map((item) => item.key);

  assert.deepEqual(keys, ['postgres', 'n8n', 'backups', 'validation', 'workflows', 'monitoring']);
  assert.ok(monitoring.ampels.every((item) => ['green', 'yellow', 'red'].includes(item.state)));
  assert.ok(monitoring.ampels.every((item) => typeof item.message === 'string' && item.message.length > 0));
});

test('AC3: stale data is marked only after a full day without pipeline activity', () => {
  const staleMonitoring = buildMonitoringData({
    ...RAW_DATA,
    nowIso: '2026-05-27T15:00:00.000Z',
    workflowRuns: [],
    warnings: [
      { warning_type: 'BACKUP_OK', severity: 'info', resolved: true, created_at: '2026-05-26T03:00:00.000Z', warning_key: 'BACKUP_OK|backup|2026-05-26', message: 'Backup erfolgreich' },
    ],
  });

  assert.equal(staleMonitoring.stale.isStale, true);
  assert.match(staleMonitoring.stale.message, /veraltet/i);
  assert.equal(staleMonitoring.ampels.find((a) => a.key === 'monitoring').state, 'yellow');
});

test('AC3b: same-day batch evidence is fresh even when hours old (live read)', () => {
  const freshMonitoring = buildMonitoringData({
    ...RAW_DATA,
    nowIso: '2026-05-27T13:00:00.000Z',
    workflowRuns: [
      { workflow_key: 'WF-Val', status: 'success', started_at: '2026-05-27T04:14:00.000Z', finished_at: '2026-05-27T05:00:00.000Z' },
    ],
    warnings: [],
  });

  assert.equal(freshMonitoring.stale.isStale, false);
  assert.doesNotMatch(freshMonitoring.stale.message, /veraltet/i);
  assert.equal(freshMonitoring.ampels.find((a) => a.key === 'monitoring').state, 'green');
});

test('AC-HTTP: /api/v2/overview and /api/v2/monitoring return explicit PG errors when DB is unreachable', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });

  t.after(() => {
    dashboard.kill();
  });

  const overview = await request(port, '/api/v2/overview');
  const monitoring = await request(port, '/api/v2/monitoring');

  assert.equal(overview.status, 503);
  assert.equal(monitoring.status, 503);
  assert.equal(overview.json().error.code, 'PG_ERROR');
  assert.equal(monitoring.json().error.code, 'PG_ERROR');
});

test('AC-UI: v2 overview has dedicated containers for priorities and monitoring ampels', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.html'), 'utf8');

  assert.match(html, /id="overviewPriorities"/, 'missing overview priorities container');
  assert.match(html, /id="overviewAmpels"/, 'missing overview ampels container');
  assert.match(html, /id="monitoringAmpelList"/, 'missing monitoring ampel list container');
  assert.match(html, /Monitoring-Details/, 'missing explicit monitoring detail affordance');
  assert.doesNotMatch(html, /Admin-Trigger/, 'default overview must not render admin trigger copy');
});

test('AC-UI: v2.js fetches overview and monitoring endpoints and handles stale\/error\/empty states', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.js'), 'utf8');

  assert.match(js, /\/api\/v2\/overview/, 'v2.js must load overview endpoint');
  assert.match(js, /\/api\/v2\/monitoring/, 'v2.js must load monitoring endpoint');
  assert.match(js, /isStale/, 'v2.js must handle stale markers');
  assert.match(js, /Keine offenen Prioritaeten|Keine Prioritaeten/, 'v2.js must render empty-state copy');
  assert.match(js, /FEHLER|error/i, 'v2.js must render explicit error state');
});

test('AC-UI: v2.css enforces first-screen focus and compact ampel layout on desktop\/mobile', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.css'), 'utf8');

  assert.match(css, /\.v2-first-screen/, 'missing first-screen layout class');
  assert.match(css, /\.v2-first-screen[\s\S]{0,200}align-content\s*:\s*start/, 'first-screen should use align-content: start layout');
  assert.match(css, /\.v2-ampel-grid/, 'missing compact ampel grid styles');
  assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.v2-ampel-grid/, 'missing mobile ampel layout rules');
});

// ── Issue #42: Warnungs-Drill-down ───────────────────────────────────

test('AC-WD1: buildWarningDrilldown extracts entity from warning_key and returns null correction_link for informational types', () => {
  const result = buildWarningDrilldown({
    warning_type: 'CONTAINER_DOWN',
    warning_key: 'CONTAINER_DOWN|homelab-n8n|2026-05-27',
    message: 'n8n down',
    severity: 'critical',
    resolved: false,
    created_at: '2026-05-27T07:20:00.000Z',
  });

  assert.equal(result.entity, 'homelab-n8n');
  assert.equal(result.warning_type, 'CONTAINER_DOWN');
  assert.equal(result.message, 'n8n down');
  assert.equal(result.severity, 'critical');
  assert.equal(result.resolved, false);
  assert.equal(result.correction_link, null);
});

test('AC-WD1b: buildWarningDrilldown falls back to message prefix as entity when warning_key has no pipe separator', () => {
  const result = buildWarningDrilldown({
    warning_type: 'MHD_NEAR',
    warning_key: 'WARN_MHD_NEAR_SKU_NICK_NACKS_B_NICK_NACKS_20260502_1_2026_05_29',
    message: 'Nick Nacks: Charge B_NICK_NACKS_20260502_1 ist seit 2 Tag(en) abgelaufen.',
    severity: 'critical',
    resolved: false,
    created_at: '2026-05-29T07:00:00.000Z',
  });

  assert.equal(result.entity, 'Nick Nacks');
  assert.equal(result.correction_link, null);
});

test('AC-WD2: buildWarningDrilldown returns correction_link for actionable warning types', () => {
  const types = ['UNKNOWN_PRODUCT', 'UNMATCHED_PRODUCT', 'MDB_CODE_CHANGED_FOR_PRODUCT'];
  for (const warning_type of types) {
    const result = buildWarningDrilldown({
      warning_type,
      warning_key: `${warning_type}|some-entity|2026-05-27`,
      message: 'Test',
      severity: 'warning',
      resolved: false,
      created_at: '2026-05-27T08:00:00.000Z',
    });
    assert.ok(result.correction_link !== null, `expected correction_link for ${warning_type}`);
    assert.match(result.correction_link, /correctionCasesPanel/, `correction_link should point to panel for ${warning_type}`);
  }
});

test('AC-WD3: buildMonitoringData includes enriched warnings list with entity and correction_link', () => {
  const monitoring = buildMonitoringData(RAW_DATA);

  assert.ok(Array.isArray(monitoring.warnings), 'monitoring.warnings must be an array');
  assert.equal(monitoring.warnings.length, RAW_DATA.warnings.length);

  const containerDown = monitoring.warnings.find((w) => w.warning_type === 'CONTAINER_DOWN');
  assert.ok(containerDown, 'CONTAINER_DOWN warning must be in list');
  assert.equal(containerDown.entity, 'homelab-n8n');
  assert.equal(containerDown.correction_link, null);

  monitoring.warnings.forEach((w) => {
    assert.ok('entity' in w, 'each warning must have entity field');
    assert.ok('correction_link' in w, 'each warning must have correction_link field');
    assert.ok('warning_type' in w);
    assert.ok('message' in w);
    assert.ok('severity' in w);
  });
});

test('AC-WD4: server.js passes warnings from monitoring into /api/v2/overview response', () => {
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

  assert.match(serverSrc, /monitoring\.warnings/, 'server must include monitoring.warnings in overview response');
});

test('AC-WD5: v2.html has #warningsDrilldownList container', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.html'), 'utf8');

  assert.match(html, /id="warningsDrilldownList"/, 'missing #warningsDrilldownList container');
});

test('AC-WD6: v2.js renders warning drill-down list and handles correction link', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.js'), 'utf8');

  assert.match(js, /renderWarningsDrilldown/, 'v2.js must define renderWarningsDrilldown function');
  assert.match(js, /warningsDrilldownList/, 'v2.js must reference #warningsDrilldownList container');
  assert.match(js, /correction_link/, 'v2.js must render correction_link when present');
  assert.match(js, /Keine offenen Warnungen/, 'v2.js must render empty state');
});

test('AC-WD7: v2.css defines warning drill-down styles', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v2.css'), 'utf8');

  assert.match(css, /\.v2-warn-list/, 'missing .v2-warn-list');
  assert.match(css, /\.v2-warn-item--critical/, 'missing critical severity style');
  assert.match(css, /\.v2-warn-trigger/, 'missing .v2-warn-trigger');
  assert.match(css, /\.v2-warn-correction-link/, 'missing .v2-warn-correction-link');
});

// ── #2: Cockpit-KPIs — „nur leere" Slots + BACKUP_OK aus Warnungs-Zähler ──

test('AC-CK2-1: low-stock priority is relabelled to empty slots ("leer"), not "unter Zielbestand"', () => {
  const overview = buildOverviewData(RAW_DATA);
  const lowStock = overview.priorities.find((p) => p.id === 'low-stock');

  assert.ok(lowStock, 'low-stock priority must exist when lowStockCount > 0');
  assert.equal(lowStock.title, 'Leere Slots');
  assert.match(lowStock.message, /leer/);
  assert.doesNotMatch(lowStock.message, /unter Zielbestand/);
});

test('AC-CK2-2: low-stock count query counts empty slots (= 0), matching the detail page, not "< target_stock"', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'overview-monitoring.js'), 'utf8');

  assert.match(src, /current_machine_qty\s*=\s*0/, 'cockpit low-stock query must count empty slots (= 0)');
  assert.doesNotMatch(src, /current_machine_qty\s*<\s*target_stock/, 'cockpit must no longer count slots merely under target');
});

test('AC-CK2-3: open-warnings COUNT query excludes BACKUP_OK (success message), consistent with the warnings list', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'overview-monitoring.js'), 'utf8');
  const backupOkFilters = src.match(/!=\s*'BACKUP_OK'/g) || [];

  // One filter already lives in the warnings-list query; the COUNT query must add a second.
  assert.ok(backupOkFilters.length >= 2, `expected BACKUP_OK to be excluded in both count and list queries, found ${backupOkFilters.length}`);
});

test('AC-CK2-4: cockpit.js KPI label for low-stock reflects empty slots', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'cockpit.js'), 'utf8');
  assert.match(src, /'low-stock'[\s\S]{0,40}'Leere Slots'/, 'cockpit.js low-stock KPI must be labelled "Leere Slots"');
});

// ── #17: Overview-Drilldown (MHD-/Leere-Slots-Detaillisten) + BACKUP_OK-Ampel ──

test('AC-DD1: buildOverviewData passes mhdItems and lowStockItems through for the overview drilldown', () => {
  const overview = buildOverviewData({
    ...RAW_DATA,
    mhdItems: [
      { product_name: 'SKU_NICK_NACKS', batch_key: 'B_NICK_NACKS_1', mhd_date: '2026-06-03', days_remaining: 2 },
    ],
    lowStockItems: [
      { product_slot_key: 'PSID_1', machine_id: 'LH001', product_name: '7 Days Croissant', current_machine_qty: 0 },
    ],
  });

  assert.ok(Array.isArray(overview.mhdItems), 'overview.mhdItems must be an array');
  assert.ok(Array.isArray(overview.lowStockItems), 'overview.lowStockItems must be an array');
  assert.equal(overview.mhdItems.length, 1);
  assert.equal(overview.lowStockItems.length, 1);
  assert.equal(overview.mhdItems[0].batch_key, 'B_NICK_NACKS_1');
  assert.equal(overview.lowStockItems[0].product_slot_key, 'PSID_1');
});

test('AC-DD2: buildOverviewData defaults mhdItems/lowStockItems to empty arrays when raw omits them', () => {
  const overview = buildOverviewData(RAW_DATA);

  assert.deepEqual(overview.mhdItems, []);
  assert.deepEqual(overview.lowStockItems, []);
});

test('AC-DD3: mhd-risk priority escalates to critical when a batch is already expired (days_remaining < 0)', () => {
  const expired = buildOverviewData({
    ...RAW_DATA,
    mhdItems: [
      { product_name: 'A', batch_key: 'B1', mhd_date: '2026-05-30', days_remaining: -2 },
      { product_name: 'B', batch_key: 'B2', mhd_date: '2026-06-04', days_remaining: 3 },
    ],
  });
  const mhdExpired = expired.priorities.find((p) => p.id === 'mhd-risk');
  assert.equal(mhdExpired.severity, 'critical', 'expired batch must escalate mhd-risk to critical');

  const soonOnly = buildOverviewData({
    ...RAW_DATA,
    mhdItems: [{ product_name: 'B', batch_key: 'B2', mhd_date: '2026-06-04', days_remaining: 3 }],
  });
  const mhdSoon = soonOnly.priorities.find((p) => p.id === 'mhd-risk');
  assert.equal(mhdSoon.severity, 'warning', 'without expired batch mhd-risk stays warning');
});

test('AC-BO1: backups ampel is green when raw.hasBackupOk is true, yellow when false', () => {
  const ok = buildMonitoringData({ ...RAW_DATA, warnings: [], hasBackupOk: true });
  assert.equal(ok.ampels.find((a) => a.key === 'backups').state, 'green');

  const missing = buildMonitoringData({ ...RAW_DATA, warnings: [], hasBackupOk: false });
  assert.equal(missing.ampels.find((a) => a.key === 'backups').state, 'yellow');
});

test('AC-BO2: queryOverviewMonitoringPg sources hasBackupOk from a dedicated query, not the filtered warnings list', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'overview-monitoring.js'), 'utf8');

  // The monitoring ampel must read the explicit flag, since the warnings list filters BACKUP_OK out.
  assert.match(src, /hasBackupOk\s*=\s*raw\.hasBackupOk\s*===\s*true/, 'hasBackupOk must come from raw.hasBackupOk');
  assert.match(src, /warning_type\s*=\s*'BACKUP_OK'/, 'a dedicated query must count BACKUP_OK rows');
});
