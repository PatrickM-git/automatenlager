'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const { buildMachineLabel, buildMachineProfile, getMachineOptions } = require('../lib/machine-profiles.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      DASHBOARD_DEV_LOCAL_ADMIN: '1', // #27: lokaler Test = Admin-Notausgang
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
      if (String(chunk).includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.resume();
    child.on('exit', (code) => {
      if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); }
    });
  });
}

function stopDashboard(child) {
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill();
  });
}

// ── AC: Label-Bildung ─────────────────────────────────────────────────────────

test('buildMachineLabel – alle Felder ohne Spitzname', () => {
  const label = buildMachineLabel({ machine_id: 'M1', area: 'EG', type: 'Snack', position: 'links', nickname: null });
  assert.strictEqual(label, 'EG · Snack · links');
});

test('buildMachineLabel – alle Felder mit Spitzname', () => {
  const label = buildMachineLabel({ machine_id: 'M1', area: '2.OG', type: 'Getränke', position: 'rechts', nickname: 'Hauptautomat' });
  assert.strictEqual(label, '2.OG · Getränke · rechts (Hauptautomat)');
});

test('buildMachineLabel – nur Typ und Position (kein Bereich)', () => {
  const label = buildMachineLabel({ machine_id: 'M1', area: null, type: 'Kombi', position: 'links', nickname: null });
  assert.strictEqual(label, 'Kombi · links');
});

test('buildMachineLabel – nur Bereich gesetzt', () => {
  const label = buildMachineLabel({ machine_id: 'M1', area: '1.OG', type: null, position: null, nickname: null });
  assert.strictEqual(label, '1.OG');
});

test('buildMachineLabel – alle Felder null fällt auf machine_id zurück', () => {
  const label = buildMachineLabel({ machine_id: 'ABC-123', area: null, type: null, position: null, nickname: null });
  assert.strictEqual(label, 'ABC-123');
});

test('buildMachineLabel – Spitzname ohne andere Felder', () => {
  const label = buildMachineLabel({ machine_id: 'X', area: null, type: null, position: null, nickname: 'Kiosk' });
  assert.strictEqual(label, 'Kiosk');
});

test('buildMachineLabel – Sonstiges-Freitext in Feldern', () => {
  const label = buildMachineLabel({ machine_id: 'M1', area: 'Keller', type: 'Kuscheltiere', position: 'mitte', nickname: null });
  assert.strictEqual(label, 'Keller · Kuscheltiere · mitte');
});

// ── AC: buildMachineProfile Validierung ──────────────────────────────────────

test('buildMachineProfile – machine_id ist Pflichtfeld', () => {
  assert.throws(() => buildMachineProfile({}), /machine_id/);
  assert.throws(() => buildMachineProfile({ machine_id: '' }), /machine_id/);
  assert.throws(() => buildMachineProfile({ machine_id: '  ' }), /machine_id/);
});

test('buildMachineProfile – normalisiert optionale Felder auf null', () => {
  const p = buildMachineProfile({ machine_id: 'M99' });
  assert.strictEqual(p.machine_id, 'M99');
  assert.strictEqual(p.area, null);
  assert.strictEqual(p.type, null);
  assert.strictEqual(p.position, null);
  assert.strictEqual(p.nickname, null);
});

test('buildMachineProfile – übernimmt alle optionalen Felder', () => {
  const p = buildMachineProfile({ machine_id: ' M5 ', area: 'EG', type: 'Snack', position: 'links', nickname: 'Foyer' });
  assert.strictEqual(p.machine_id, 'M5');
  assert.strictEqual(p.area, 'EG');
  assert.strictEqual(p.type, 'Snack');
  assert.strictEqual(p.position, 'links');
  assert.strictEqual(p.nickname, 'Foyer');
});

test('buildMachineProfile – whitespace wird von machine_id getrimmt', () => {
  const p = buildMachineProfile({ machine_id: '  ABC  ' });
  assert.strictEqual(p.machine_id, 'ABC');
});

// ── AC: getMachineOptions ─────────────────────────────────────────────────────

test('getMachineOptions – liefert Typen inkl. Sonstiges', () => {
  const opts = getMachineOptions();
  assert.ok(Array.isArray(opts.types));
  assert.ok(opts.types.includes('Snack'));
  assert.ok(opts.types.includes('Getränke'));
  assert.ok(opts.types.includes('Kombi'));
  assert.ok(opts.types.includes('Sonstiges'));
});

test('getMachineOptions – liefert Positionen inkl. Sonstiges', () => {
  const opts = getMachineOptions();
  assert.ok(Array.isArray(opts.positions));
  assert.ok(opts.positions.includes('links'));
  assert.ok(opts.positions.includes('rechts'));
  assert.ok(opts.positions.includes('Sonstiges'));
});

test('getMachineOptions – liefert Bereiche inkl. alle OGs und Sonstiges', () => {
  const opts = getMachineOptions();
  assert.ok(Array.isArray(opts.areas));
  assert.ok(opts.areas.includes('EG'));
  assert.ok(opts.areas.includes('1.OG'));
  assert.ok(opts.areas.includes('2.OG'));
  assert.ok(opts.areas.includes('3.OG'));
  assert.ok(opts.areas.includes('Sonstiges'));
});

// ── AC: Migration SQL ─────────────────────────────────────────────────────────

test('Migration 0017 SQL enthält machine_profiles Tabellendefinition', () => {
  const migrationPath = path.resolve(
    __dirname, '..', '..', '..', 'homelab', 'infra', 'postgres', 'migrations', '0017_machine_profiles.sql'
  );
  // Try alternate relative path if homelab is sibling of automatenlager
  const altPath = path.resolve(
    __dirname, '..', '..', '..', '..', 'Documents', 'homelab', 'infra', 'postgres', 'migrations', '0017_machine_profiles.sql'
  );
  const sql = fs.existsSync(migrationPath)
    ? fs.readFileSync(migrationPath, 'utf8')
    : fs.readFileSync(altPath, 'utf8');
  assert.ok(sql.includes('machine_profiles'), 'Tabelle machine_profiles muss definiert werden');
  assert.ok(sql.includes('machine_id'), 'machine_id-Spalte muss enthalten sein');
  assert.ok(sql.includes('n8n_app'), 'GRANT für n8n_app muss enthalten sein');
  assert.ok(sql.includes('UNIQUE'), 'machine_id muss UNIQUE sein');
});

// ── AC: GET /api/v2/machine-profiles ─────────────────────────────────────────

test('GET /api/v2/machine-profiles – ohne PG gibt leere Liste zurück', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => stopDashboard(child));

  const res = await request(port, '/api/v2/machine-profiles');
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.ok, true);
  assert.ok(Array.isArray(body.data), 'data muss ein Array sein');
  assert.ok('options' in body, 'options muss enthalten sein');
  assert.ok(Array.isArray(body.options.types));
});

// ── AC: POST /api/v2/machine-profiles – 403 für Gäste ────────────────────────

test('POST /api/v2/machine-profiles – 403 für Gast-Anfrage', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  t.after(() => stopDashboard(child));

  const res = await request(port, '/api/v2/machine-profiles', {
    method: 'POST',
    headers: { 'tailscale-user-login': 'guest@example.test' },
    body: { machine_id: 'TEST', area: 'EG', type: 'Snack', position: 'links', nickname: null },
  });
  assert.strictEqual(res.status, 403);
  const body = res.json();
  assert.strictEqual(body.ok, false);
});

test('POST /api/v2/machine-profiles – 400 bei fehlendem machine_id (als Admin, ohne PG)', async (t) => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'patrick@example.test' });
  t.after(() => stopDashboard(child));

  const res = await request(port, '/api/v2/machine-profiles', {
    method: 'POST',
    headers: { 'x-user-email': 'patrick@example.test' },
    body: { area: 'EG' },
  });
  assert.strictEqual(res.status, 400);
  const body = res.json();
  assert.strictEqual(body.ok, false);
  assert.ok(body.error.code === 'VALIDATION_ERROR');
});
