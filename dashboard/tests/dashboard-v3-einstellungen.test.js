'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { SLOW_MOVER } = require('../lib/slow-mover.js');

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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, json: () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startDashboard(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'test-key' },
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

// ── Endpoint: Definitionen aus dem Backend (Single Source of Truth) ───────────

test('GET /api/v2/settings/definitions liefert die Slow-Mover-Definitionen', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/settings/definitions');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.definitions && body.definitions.slowMover, 'definitions.slowMover muss vorhanden sein');
  assert.equal(body.definitions.slowMover.ladenhueterDays, SLOW_MOVER.ladenhueterDays);
  assert.equal(body.definitions.slowMover.classes.length, 6);
});

// ── Frontend: /einstellungen-Seite rendert die Definitionen ───────────────────

test('AC-S1: v3.js verdrahtet /einstellungen mit dem Definitionen-Endpunkt', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /\/api\/v2\/settings\/definitions/, 'v3.js muss den Definitionen-Endpunkt abrufen');
  assert.match(js, /renderSettingsPage/, 'v3.js muss renderSettingsPage definieren');
  assert.match(js, /route\.path === '\/einstellungen'/, 'v3.js muss die /einstellungen-Route behandeln');
});

test('AC-S2: v3.js zeigt Drehzahl-Klassen-Badges + Schwellwerte', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /v3-badge--turnover-/, 'Klassen-Badges müssen gerendert werden');
  assert.match(js, /Ladenhüter-Schwelle/, 'Schwellwert Ladenhüter muss sichtbar sein');
  assert.match(js, /UBIQUITOUS_LANGUAGE\.md/, 'Verweis auf das Glossar');
});

test('AC-S3: v3.css definiert Klassen-Badges + Einstellungen-Layout', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  for (const c of SLOW_MOVER.classes) {
    assert.match(css, new RegExp('v3-badge--turnover-' + c.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `CSS muss Badge-Klasse für ${c.key} definieren`);
  }
  assert.match(css, /\.v3-set-defs/, 'CSS muss Einstellungen-Layout definieren');
});

// ── Glossar existiert und enthält die geforderten Begriffe ────────────────────

test('AC-S4: docs/UBIQUITOUS_LANGUAGE.md existiert mit den geforderten Begriffen', () => {
  const glossaryPath = path.join(process.cwd(), '..', 'docs', 'UBIQUITOUS_LANGUAGE.md');
  assert.ok(fs.existsSync(glossaryPath), 'docs/UBIQUITOUS_LANGUAGE.md muss existieren');
  const text = fs.readFileSync(glossaryPath, 'utf8');
  for (const term of ['Renner', 'Normal', 'Langsam-Dreher', 'Ladenhüter', 'Quartil', 'MDB', 'Etage', 'Deckungsbeitrag', 'Marge']) {
    assert.match(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Glossar muss „${term}" festschreiben`);
  }
});
