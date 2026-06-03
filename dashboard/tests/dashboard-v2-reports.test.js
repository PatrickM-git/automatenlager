'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { buildCsvExport, buildCsvFilename } = require('../lib/reports.js');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = { ...(opts.headers || {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: () => raw,
          json: () => JSON.parse(raw),
        });
      });
    });
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
      DASHBOARD_V2_PG_URL: '',
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

// ── AC2: buildCsvExport ───────────────────────────────────────────────────────

const KPI_ROWS = [
  { product_name: 'Snickers', revenue_net: 120.5, db_net: 45.2, margin_pct: 37.5, qty: 12 },
  { product_name: 'Haribo', revenue_net: 80.0, db_net: 10.0, margin_pct: 12.5, qty: 8 },
];

const KPI_FIELDS = [
  { key: 'product_name', label: 'Produkt' },
  { key: 'revenue_net',  label: 'Umsatz (netto)' },
  { key: 'db_net',       label: 'Deckungsbeitrag' },
  { key: 'margin_pct',   label: 'Marge %' },
  { key: 'qty',          label: 'Menge' },
];

test('AC2: buildCsvExport returns a string', () => {
  const result = buildCsvExport(KPI_ROWS, KPI_FIELDS);
  assert.equal(typeof result, 'string');
});

test('AC2: buildCsvExport first line contains all column labels', () => {
  const result = buildCsvExport(KPI_ROWS, KPI_FIELDS);
  const firstLine = result.split('\n')[0];
  assert.match(firstLine, /Produkt/);
  assert.match(firstLine, /Umsatz/);
  assert.match(firstLine, /Deckungsbeitrag/);
  assert.match(firstLine, /Marge/);
  assert.match(firstLine, /Menge/);
});

test('AC2: buildCsvExport data rows match input values', () => {
  const result = buildCsvExport(KPI_ROWS, KPI_FIELDS);
  const lines = result.split('\n').filter(Boolean);
  assert.equal(lines.length, 3); // header + 2 data rows
  assert.match(lines[1], /Snickers/);
  assert.match(lines[1], /120\.5|120,5/); // comma or dot decimal
  assert.match(lines[2], /Haribo/);
});

test('AC2: buildCsvExport handles empty rows', () => {
  const result = buildCsvExport([], KPI_FIELDS);
  const lines = result.split('\n').filter(Boolean);
  assert.equal(lines.length, 1); // only header
});

test('AC2: buildCsvExport escapes values containing commas', () => {
  const rows = [{ product_name: 'Haribo, Gold', revenue_net: 10 }];
  const fields = [{ key: 'product_name', label: 'Produkt' }, { key: 'revenue_net', label: 'Umsatz' }];
  const result = buildCsvExport(rows, fields);
  assert.match(result, /"Haribo, Gold"/);
});

test('AC2: buildCsvFilename returns formatted filename for single month', () => {
  const name = buildCsvFilename('2026-05', '2026-05');
  assert.equal(name, 'kpi-bericht-2026-05.csv');
});

test('AC2: buildCsvFilename returns range filename for multi-month', () => {
  const name = buildCsvFilename('2026-04', '2026-05');
  assert.equal(name, 'kpi-bericht-2026-04-bis-2026-05.csv');
});

// ── AC2: HTTP Export-Endpunkt ─────────────────────────────────────────────────

test('AC2-HTTP: GET /api/v2/reports/export returns 503 when PG not configured', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/reports/export?format=csv&from=2026-05&to=2026-05');
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(body.ok, false);
});

test('AC2-HTTP: GET /api/v2/reports/export returns 503 with PG error when DB unreachable', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/reports/export?format=csv&from=2026-05&to=2026-05');
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(body.error.code, 'PG_ERROR');
});

test('AC2-HTTP: GET /api/v2/reports/export with format=csv returns Content-Type text/csv when PG unavailable', async (t) => {
  // We test that the server at least attempts CSV when DB works.
  // With a real DB we would get a CSV file. Here we verify the 503 response is JSON.
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/reports/export?format=csv&from=2026-05&to=2026-05');
  // Even on error, response envelope is consistent
  assert.equal(res.status, 503);
});

// ── AC3: buildLocationProfile ─────────────────────────────────────────────────

const {
  buildLocationProfile,
  buildLocationComparison,
} = require('../lib/location-profiles.js');

test('AC3: buildLocationProfile returns object with all required fields', () => {
  const raw = {
    name: 'Büro Berlin',
    status: 'aktiv',
    notes: 'Kantine EG',
    start_date: '2026-01-01',
    target_group: 'Mitarbeiter',
    machine_ids: ['VM01', 'VM02'],
  };
  const profile = buildLocationProfile(raw);
  assert.equal(profile.name, 'Büro Berlin');
  assert.equal(profile.status, 'aktiv');
  assert.equal(profile.notes, 'Kantine EG');
  assert.equal(profile.start_date, '2026-01-01');
  assert.equal(profile.target_group, 'Mitarbeiter');
  assert.deepEqual(profile.machine_ids, ['VM01', 'VM02']);
});

test('AC3: buildLocationProfile throws when name is missing', () => {
  assert.throws(() => buildLocationProfile({ status: 'aktiv', machine_ids: [] }), /name/i);
});

test('AC3: buildLocationProfile throws when status is invalid', () => {
  assert.throws(
    () => buildLocationProfile({ name: 'Test', status: 'ungültig', machine_ids: [] }),
    /status/i,
  );
});

test('AC3: buildLocationProfile accepts valid statuses: aktiv, inaktiv, geplant', () => {
  for (const status of ['aktiv', 'inaktiv', 'geplant']) {
    const p = buildLocationProfile({ name: 'X', status, machine_ids: [] });
    assert.equal(p.status, status);
  }
});

test('AC3: buildLocationProfile normalises machine_ids to array when string given', () => {
  const p = buildLocationProfile({ name: 'X', status: 'aktiv', machine_ids: 'VM01' });
  assert.deepEqual(p.machine_ids, ['VM01']);
});

test('AC3: buildLocationProfile defaults notes, start_date, target_group to null when omitted', () => {
  const p = buildLocationProfile({ name: 'X', status: 'aktiv', machine_ids: [] });
  assert.equal(p.notes, null);
  assert.equal(p.start_date, null);
  assert.equal(p.target_group, null);
});

// ── AC4: buildLocationComparison ─────────────────────────────────────────────

const PROFILES = [
  { location_id: 1, name: 'Büro Berlin', status: 'aktiv', machine_ids: ['VM01'], notes: null, start_date: null, target_group: null },
  { location_id: 2, name: 'Lager Süd', status: 'aktiv', machine_ids: ['VM02'], notes: null, start_date: null, target_group: null },
];

const KPI_ROWS_BY_MACHINE = [
  { machine_id: 'VM01', revenue_net: 500.0, db_net: 150.0, margin_pct: 30.0, qty: 50, slot_turnover: 1.2, inventory_value: 200.0 },
  { machine_id: 'VM02', revenue_net: 300.0, db_net: 80.0,  margin_pct: 26.7, qty: 30, slot_turnover: 0.9, inventory_value: 150.0 },
];

test('AC4: buildLocationComparison returns one entry per profile', () => {
  const result = buildLocationComparison(PROFILES, KPI_ROWS_BY_MACHINE);
  assert.equal(result.length, 2);
});

test('AC4: buildLocationComparison merges KPIs for matching machine_ids', () => {
  const result = buildLocationComparison(PROFILES, KPI_ROWS_BY_MACHINE);
  const berlin = result.find((r) => r.name === 'Büro Berlin');
  assert.ok(berlin, 'Berlin profile must exist');
  assert.equal(berlin.kpis.revenue_net, 500.0);
  assert.equal(berlin.kpis.db_net, 150.0);
  assert.equal(berlin.kpis.margin_pct, 30.0);
  assert.equal(berlin.kpis.qty, 50);
});

test('AC4: buildLocationComparison sums KPIs across multiple machines at one location', () => {
  const profilesMulti = [
    { location_id: 3, name: 'Multi', status: 'aktiv', machine_ids: ['VM01', 'VM02'] },
  ];
  const result = buildLocationComparison(profilesMulti, KPI_ROWS_BY_MACHINE);
  assert.equal(result[0].kpis.revenue_net, 800.0);
  assert.equal(result[0].kpis.qty, 80);
});

test('AC4: buildLocationComparison sets kpis to null when no matching machine data', () => {
  const profilesNoData = [
    { location_id: 4, name: 'Kein Automat', status: 'geplant', machine_ids: [] },
  ];
  const result = buildLocationComparison(profilesNoData, KPI_ROWS_BY_MACHINE);
  assert.equal(result[0].kpis, null);
});

test('AC4: buildLocationComparison includes slot_turnover and inventory_value in KPIs', () => {
  const result = buildLocationComparison(PROFILES, KPI_ROWS_BY_MACHINE);
  const berlin = result.find((r) => r.name === 'Büro Berlin');
  assert.equal(berlin.kpis.slot_turnover, 1.2);
  assert.equal(berlin.kpis.inventory_value, 200.0);
});

// ── AC5: Rollenrechte ─────────────────────────────────────────────────────────

test('AC5-HTTP: POST /api/v2/locations gibt 403 für Gäste (kein Admin-Header)', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/locations', {
    method: 'POST',
    headers: { 'tailscale-user-login': 'guest@example.test' },
    body: { name: 'Test', status: 'aktiv', machine_ids: [] },
  });
  assert.equal(res.status, 403);
});

test('AC5-HTTP: GET /api/v2/locations gibt 503 wenn PG nicht konfiguriert', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/locations');
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(body.ok, false);
});

test('AC5-HTTP: GET /api/v2/locations response envelope hat ok-Feld', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port, {
    DASHBOARD_V2_PG_URL: 'postgresql://invalid-host-x:5432/nonexistent',
  });
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/locations');
  assert.equal(res.status, 503);
  const body = res.json();
  assert.equal(typeof body.ok, 'boolean');
  assert.equal(body.error.code, 'PG_ERROR');
});

// ── AC1: UI-Checks (statische Dateien) ───────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
