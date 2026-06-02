const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  buildAlertDigest,
  isOperationalIssue,
} = require('../lib/alert-digest.js');

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
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'test-key', DASHBOARD_ADMIN_LOGIN: 'patrick@example.test', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('server start timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`exit ${code}`)); } });
  });
}

const RAW = {
  nowIso: '2026-06-02T18:00:00.000Z',
  lowBatchThreshold: 5,
  mhdBatches: [
    { product_name: 'Nick Nacks', batch_key: 'B1', mhd_date: '2026-05-31', remaining_qty: 3, days_remaining: -2 },
    { product_name: 'KitKat', batch_key: 'B2', mhd_date: '2026-06-20', remaining_qty: 10, days_remaining: 18 },
  ],
  batchTotals: [
    { product_name: 'Red Bull Spring', product_key: 'SKU_RED_BULL_SPRING', total_remaining: 5 },
    { product_name: 'Bueno', product_key: 'SKU_BUENO', total_remaining: 0 },
  ],
  emptySlots: [
    { product_slot_key: 'PS_1', machine_id: '1', mdb_code: '53', product_name: 'Bueno', current_machine_qty: 0 },
    { product_slot_key: 'PS_2', machine_id: '1', mdb_code: '54', product_name: 'Duplo Chocnut', current_machine_qty: 0 },
  ],
  warnings: [
    // ECHTE operative Fehler → müssen als dataIssue erscheinen
    { warning_type: 'WORKFLOW_ERROR', severity: 'critical', resolved: false, created_at: '2026-06-02T08:00:00.000Z', warning_key: 'WORKFLOW_ERROR|WF8|2026-06-02', message: 'WF8 Fehler' },
    { warning_type: 'CONTAINER_DOWN', severity: 'critical', resolved: false, created_at: '2026-06-02T07:00:00.000Z', warning_key: 'CONTAINER_DOWN|homelab-n8n|2026-06-02', message: 'n8n down' },
    // FEHLALARME aus der alten Logik → dürfen NICHT als dataIssue erscheinen
    { warning_type: 'AUTO_REFILL_SLOT', severity: 'info', resolved: false, created_at: '2026-06-02T05:00:00.000Z', warning_key: 'AUTO_REFILL_SLOT|7 Days Croissant|2026-06-02', message: 'Auto-Refill: Slot war leer, auf 8 gesetzt.' },
    { warning_type: 'LOW_STOCK', severity: 'info', resolved: false, created_at: '2026-06-02T05:00:00.000Z', warning_key: 'LOW_STOCK|Bueno|2026-06-02', message: 'Bueno: Slot leer.' },
    { warning_type: 'LOW_BATCH', severity: 'warning', resolved: false, created_at: '2026-06-02T05:00:00.000Z', warning_key: 'LOW_BATCH|Red Bull Spring|2026-06-02', message: 'Red Bull Spring: Nur noch 5.' },
    // resolved → ignorieren
    { warning_type: 'WORKFLOW_ERROR', severity: 'critical', resolved: true, created_at: '2026-06-01T08:00:00.000Z', warning_key: 'WORKFLOW_ERROR|WF3|2026-06-01', message: 'behoben' },
  ],
  workflowFailures: [
    { workflow_key: 'WF2', started_at: '2026-06-02T09:00:00.000Z', finished_at: '2026-06-02T09:01:00.000Z', status: 'error' },
  ],
};

test('AD1: isOperationalIssue includes real ops errors and excludes auto-correction/info/stock types', () => {
  assert.equal(isOperationalIssue({ warning_type: 'WORKFLOW_ERROR', severity: 'critical', resolved: false }), true);
  assert.equal(isOperationalIssue({ warning_type: 'CONTAINER_DOWN', severity: 'critical', resolved: false }), true);
  assert.equal(isOperationalIssue({ warning_type: 'UNKNOWN_PRODUCT', severity: 'warning', resolved: false }), true);

  // Kern-Fix: AUTO_REFILL_SLOT ist KEIN Fehler
  assert.equal(isOperationalIssue({ warning_type: 'AUTO_REFILL_SLOT', severity: 'info', resolved: false }), false);
  // selbst wenn jemand AUTO_REFILL_SLOT fälschlich auf warning setzt → trotzdem kein Fehler
  assert.equal(isOperationalIssue({ warning_type: 'AUTO_REFILL_SLOT', severity: 'warning', resolved: false }), false);
  // Bestands-/MHD-Typen haben eigene Sektionen, nicht „Fehler"
  assert.equal(isOperationalIssue({ warning_type: 'LOW_STOCK', severity: 'info', resolved: false }), false);
  assert.equal(isOperationalIssue({ warning_type: 'LOW_BATCH', severity: 'warning', resolved: false }), false);
  assert.equal(isOperationalIssue({ warning_type: 'MHD_EXPIRED', severity: 'critical', resolved: false }), false);
  // resolved zählt nie
  assert.equal(isOperationalIssue({ warning_type: 'WORKFLOW_ERROR', severity: 'critical', resolved: true }), false);
  // info-Severity zählt nie
  assert.equal(isOperationalIssue({ warning_type: 'WORKFLOW_ERROR', severity: 'info', resolved: false }), false);
});

test('AD2: buildAlertDigest splits MHD into expired (<0) and soon (0..30)', () => {
  const d = buildAlertDigest(RAW);
  assert.equal(d.counts.mhdExpired, 1);
  assert.equal(d.counts.mhdSoon, 1);
  assert.equal(d.mhdExpired[0].product_name, 'Nick Nacks');
  assert.equal(d.mhdSoon[0].product_name, 'KitKat');
});

test('AD3: buildAlertDigest splits batch totals into empty (<=0) and low (1..threshold)', () => {
  const d = buildAlertDigest(RAW);
  assert.equal(d.counts.emptyBatches, 1);
  assert.equal(d.counts.lowBatches, 1);
  assert.equal(d.emptyBatches[0].product_name, 'Bueno');
  assert.equal(d.lowBatches[0].product_name, 'Red Bull Spring');
  assert.equal(d.lowBatches[0].total_remaining_qty, 5);
});

test('AD4: empty slots come through as the "niedriger Bestand" section (PG, not Sheet)', () => {
  const d = buildAlertDigest(RAW);
  assert.equal(d.counts.emptySlots, 2);
  assert.deepEqual(d.emptySlots.map((s) => s.product_name).sort(), ['Bueno', 'Duplo Chocnut']);
  assert.ok(d.emptySlots.every((s) => s.current_machine_qty === 0));
});

test('AD5: dataIssues contain ONLY real ops issues — no AUTO_REFILL_SLOT, no info, no stock types', () => {
  const d = buildAlertDigest(RAW);
  // 2 echte Warnungen (WORKFLOW_ERROR, CONTAINER_DOWN) + 1 Workflow-Failure (WF2) = 3
  assert.equal(d.counts.dataIssues, 3);
  const types = d.dataIssues.map((i) => i.warning_type);
  assert.ok(!d.dataIssues.some((i) => /AUTO_REFILL/.test(i.warning_type)), 'AUTO_REFILL_SLOT must not be a data issue');
  assert.ok(!d.dataIssues.some((i) => i.severity === 'info'), 'no info-level entries');
  assert.ok(types.includes('CONTAINER_DOWN'));
  assert.ok(d.dataIssues.some((i) => i.source === 'workflow_run' && i.entity === 'WF2'));
});

test('AD6: defaults are safe for empty input', () => {
  const d = buildAlertDigest({});
  assert.equal(d.counts.dataIssues, 0);
  assert.equal(d.counts.emptySlots, 0);
  assert.equal(d.lowBatchThreshold, 5);
  assert.ok(Array.isArray(d.mhdExpired));
});

test('AD-HTTP: /api/v2/alerts/digest returns explicit PG error when DB unreachable', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, { DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent' });
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/alerts/digest');
  assert.equal(res.status, 503);
  assert.equal(res.json().error.code, 'PG_ERROR');
});
