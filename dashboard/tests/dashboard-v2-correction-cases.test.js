'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  buildCorrectionCases,
} = require('../lib/correction-cases.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROPOSAL_MDB_MISMATCH = {
  proposal_id: 1,
  proposal_key: 'prop_mismatch_123',
  proposal_type: 'MDB_PRODUCT_MAPPING_MISMATCH',
  machine_id: 10001,
  mdb_code: 102,
  product_id: 7,
  product_name: 'Snickers',
  reason: 'MDB 102 meldete SKU_MARS statt SKU_SNICKERS',
  status: 'open',
  payload: { wf4_auto_start: true, suggested_product_id: 8, suggested_product_name: 'Mars' },
  created_at: '2026-05-20T08:00:00.000Z',
};

const PROPOSAL_CODE_CHANGED = {
  proposal_id: 2,
  proposal_key: 'prop_code_42',
  proposal_type: 'MDB_CODE_CHANGED_FOR_PRODUCT',
  machine_id: 10001,
  mdb_code: 205,
  product_id: 3,
  product_name: 'Haribo',
  reason: 'MDB-Code für Haribo von 200 auf 205 geändert',
  status: 'open',
  payload: { wf4_auto_start: false },
  created_at: '2026-05-21T09:00:00.000Z',
};

const UNKNOWN_TX_HARIBO = {
  product_key: 'UNKNOWN_HARIBO_SOUR',
  product_name_raw: 'HARIBO SOUR APPLE',
  machine_id: 10001,
  mdb_code: 301,
  tx_count: 5,
  first_seen_at: '2026-05-18T14:00:00.000Z',
  last_seen_at: '2026-05-22T10:00:00.000Z',
};

const WARNING_MDB_CHANGED = {
  warning_id: 99,
  warning_key: 'MDB_CODE_CHANGED_FOR_PRODUCT|10001|205|2026-05-21',
  warning_type: 'MDB_CODE_CHANGED_FOR_PRODUCT',
  severity: 'warning',
  product_id: 3,
  machine_id: 10001,
  mdb_code: 205,
  slot_assignment_id: 55,
  message: 'MDB 205: Haribo – Code geändert',
  resolved: false,
  created_at: '2026-05-21T09:01:00.000Z',
};

const WARNING_UNMATCHED = {
  warning_id: 100,
  warning_key: 'UNMATCHED_PRODUCT|10001|301|2026-05-18',
  warning_type: 'UNMATCHED_PRODUCT',
  severity: 'warning',
  product_id: null,
  machine_id: 10001,
  mdb_code: 301,
  slot_assignment_id: null,
  message: 'Unbekanntes Produkt: HARIBO SOUR APPLE (MDB 301)',
  resolved: false,
  created_at: '2026-05-18T14:00:00.000Z',
};

// ── buildCorrectionCases – Quelle (a): proposals ──────────────────────────────

test('AC1a: buildCorrectionCases includes open MDB proposals as mdb_proposal cases', () => {
  const { cases } = buildCorrectionCases({
    proposals: [PROPOSAL_MDB_MISMATCH],
    unknownTxGroups: [],
    correctionWarnings: [],
  });

  assert.equal(cases.length, 1);
  assert.equal(cases[0].case_type, 'mdb_proposal');
  assert.equal(cases[0].machine_id, 10001);
  assert.equal(cases[0].mdb_code, 102);
});

// ── buildCorrectionCases – Quelle (b): unknown transactions ──────────────────

test('AC1b: buildCorrectionCases includes UNKNOWN_PRODUCT transaction groups', () => {
  const { cases } = buildCorrectionCases({
    proposals: [],
    unknownTxGroups: [UNKNOWN_TX_HARIBO],
    correctionWarnings: [],
  });

  assert.equal(cases.length, 1);
  assert.equal(cases[0].case_type, 'unknown_product');
  assert.equal(cases[0].machine_id, 10001);
  assert.equal(cases[0].mdb_code, 301);
});

// ── buildCorrectionCases – Quelle (c): correction warnings ───────────────────

test('AC1c: buildCorrectionCases includes unresolved correction warnings', () => {
  const { cases } = buildCorrectionCases({
    proposals: [],
    unknownTxGroups: [],
    correctionWarnings: [WARNING_MDB_CHANGED, WARNING_UNMATCHED],
  });

  assert.equal(cases.length, 2);
  assert.ok(cases.every((c) => c.case_type === 'correction_warning'));
});

// ── buildCorrectionCases – alle drei Quellen zusammen ────────────────────────

test('AC1d: buildCorrectionCases aggregates all three sources and returns counts', () => {
  const { cases, counts } = buildCorrectionCases({
    proposals: [PROPOSAL_MDB_MISMATCH, PROPOSAL_CODE_CHANGED],
    unknownTxGroups: [UNKNOWN_TX_HARIBO],
    correctionWarnings: [WARNING_MDB_CHANGED, WARNING_UNMATCHED],
  });

  assert.equal(cases.length, 5);
  assert.equal(counts.mdb_proposals, 2);
  assert.equal(counts.unknown_products, 1);
  assert.equal(counts.correction_warnings, 2);
  assert.equal(counts.total, 5);
});

// ── buildCorrectionCases – vollständiger Kontext (AC2) ───────────────────────

test('AC2a: mdb_proposal case contains full context', () => {
  const { cases } = buildCorrectionCases({
    proposals: [PROPOSAL_MDB_MISMATCH],
    unknownTxGroups: [],
    correctionWarnings: [],
  });

  const c = cases[0];
  assert.ok(typeof c.case_id === 'string' && c.case_id.length > 0);
  assert.ok(typeof c.created_at === 'string');
  assert.ok(typeof c.nayax_report === 'string' && c.nayax_report.length > 0);
  assert.equal(c.product_id, 7);
  assert.equal(c.wf4_auto_start, true);
});

test('AC2b: unknown_product case contains full context', () => {
  const { cases } = buildCorrectionCases({
    proposals: [],
    unknownTxGroups: [UNKNOWN_TX_HARIBO],
    correctionWarnings: [],
  });

  const c = cases[0];
  assert.ok(typeof c.case_id === 'string');
  assert.equal(c.affected_tx_count, 5);
  assert.ok(typeof c.nayax_report === 'string' && c.nayax_report.length > 0);
  assert.equal(c.product_id, null);
});

test('AC2c: correction_warning case contains full context', () => {
  const { cases } = buildCorrectionCases({
    proposals: [],
    unknownTxGroups: [],
    correctionWarnings: [WARNING_MDB_CHANGED],
  });

  const c = cases[0];
  assert.ok(typeof c.case_id === 'string');
  assert.equal(c.slot_assignment_id, 55);
  assert.ok(typeof c.message === 'string' && c.message.length > 0);
});

test('AC2d: resolved proposals are not included', () => {
  const resolvedProposal = { ...PROPOSAL_MDB_MISMATCH, status: 'resolved' };
  const { cases } = buildCorrectionCases({
    proposals: [resolvedProposal],
    unknownTxGroups: [],
    correctionWarnings: [],
  });

  assert.equal(cases.length, 0);
});

// ── HTTP endpoint tests ───────────────────────────────────────────────────────

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
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
      },
    );
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

// AC3: endpoint exists and returns cases structure (no PG required)
test('AC3: GET /api/v2/correction-cases returns 200 with cases and counts', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-cases');
  assert.equal(res.status, 200);

  const body = res.json();
  assert.ok(Array.isArray(body.cases), 'body.cases should be an array');
  assert.ok(typeof body.counts === 'object', 'body.counts should be an object');
  assert.ok(typeof body.counts.total === 'number', 'counts.total should be a number');
});

// AC4: read-only guest can access correction cases (no 403)
test('AC4: guest (no admin header) can read /api/v2/correction-cases', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => child.kill());

  const res = await request(port, '/api/v2/correction-cases', {});
  assert.notEqual(res.status, 403, 'Guests should be able to read correction cases');
  assert.equal(res.status, 200);
});
