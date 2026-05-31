'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { buildProductCatalog } = require('../lib/product-catalog.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET';
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: opts.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
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
      DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
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

// ── fixtures ──────────────────────────────────────────────────────────────────

const ROWS = [
  { product_id: 9,  product_key: 'SKU_TWIX_ORIGINAL', name: 'SKU_TWIX_ORIGINAL' }, // Roh-SKU, kein Slot
  { product_id: 46, product_key: 'SKU_BUENO_WHITE',   name: 'Bueno White' },        // schon Klartext
  { product_id: 3,  product_key: 'SKU_ALPHA',         name: '' },                    // leerer Name → ID-Fallback
];

// ── AC1: Mapping/Format ───────────────────────────────────────────────────────

test('AC1: buildProductCatalog formatiert SKU-Rohnamen zu Klartext', () => {
  const out = buildProductCatalog(ROWS, '');
  const twix = out.find((it) => it.product_id === 9);
  assert.equal(twix.name, 'Twix Original');
  assert.equal(twix.product_key, 'SKU_TWIX_ORIGINAL');
});

test('AC1: bereits sauberer Name bleibt unverändert', () => {
  const out = buildProductCatalog(ROWS, '');
  const bueno = out.find((it) => it.product_id === 46);
  assert.equal(bueno.name, 'Bueno White');
});

test('AC1: leerer Name fällt auf Produkt-ID zurück', () => {
  const out = buildProductCatalog(ROWS, '');
  const alpha = out.find((it) => it.product_id === 3);
  assert.equal(alpha.name, '3');
});

// ── AC2: Suche (Name + product_key) ───────────────────────────────────────────

test('AC2: Suche filtert nach Klartextnamen (case-insensitive)', () => {
  const out = buildProductCatalog(ROWS, 'twix');
  assert.equal(out.length, 1);
  assert.equal(out[0].product_id, 9);
});

test('AC2: Suche findet auch über product_key', () => {
  const out = buildProductCatalog(ROWS, 'bueno_white');
  assert.equal(out.length, 1);
  assert.equal(out[0].product_id, 46);
});

test('AC2: leere Suche liefert alle Produkte', () => {
  const out = buildProductCatalog(ROWS, '');
  assert.equal(out.length, 3);
});

// ── AC3: Sortierung + Robustheit ──────────────────────────────────────────────

test('AC3: Ergebnis ist alphabetisch nach Name sortiert', () => {
  const out = buildProductCatalog(ROWS, '');
  const names = out.map((it) => it.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'de')));
});

test('AC3: leere/fehlende Eingabe → leeres Array', () => {
  assert.deepEqual(buildProductCatalog([], ''), []);
  assert.deepEqual(buildProductCatalog(null, ''), []);
});

// ── AC4: HTTP-Endpoint ────────────────────────────────────────────────────────

test('AC4: GET /api/v2/products/catalog liefert 503 ohne PG-Konfiguration', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/products/catalog?q=');
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
    assert.ok(Array.isArray(body.results));
  } finally {
    child.kill();
  }
});
