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

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    let payload = null;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, json: () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function resolvePgUrlForTest() {
  const fromEnv = process.env.DASHBOARD_V2_PG_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [path.join(process.cwd(), '..', '.env.local'), path.join(process.cwd(), '.env.local')];
  for (const fp of files) {
    let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      if (t.slice(0, i).trim() === 'DASHBOARD_V2_PG_URL') return t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DASHBOARD_DEV_LOCAL_ADMIN: '1', PORT: String(port), N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'test-key', ...envOverrides },
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

// ── Schreibpfad /einstellungen editierbar (Issue #66) ─────────────────────────

test('AC-W1: GET liefert canEdit + effektive Config (Margen, Latten)', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/settings/definitions');
  const body = res.json();
  assert.equal(body.canEdit, true, 'localhost = Admin → editierbar');
  assert.ok(body.definitions.config, 'effektive Config muss mitgeliefert werden');
  assert.ok(body.definitions.config.categories.getraenk, 'Kategorie-Margen vorhanden');
  assert.ok(body.definitions.config.latten, 'abgeleitete Latten vorhanden');
});

test('AC-W2: POST als Read-Only-Gast → 403 (kein Schreibrecht)', async (t) => {
  const port = await getFreePort();
  const dashboard = await startDashboard(port);
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/settings/definitions', {
    method: 'POST',
    headers: { 'Tailscale-User-Login': 'gast@example.test' },
    body: { config: { graceDays: 99 } },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json().error.code, 'CAPABILITY_REQUIRED'); // #31: system.verwalten nötig
});

test('#31/US22: Auffüller (workflows.starten, NICHT system.verwalten) → 403 bei Schwellwert-Schreiben', async (t) => {
  const port = await getFreePort();
  // KEIN Dev-Flag hier: Rolle kommt aus dem Header + Operator-Allowlist.
  const dashboard = await startDashboard(port, { DASHBOARD_DEV_LOCAL_ADMIN: '', DASHBOARD_OPERATOR_LOGIN: 'auffueller@example.test' });
  t.after(() => dashboard.kill());

  const res = await request(port, '/api/v2/settings/definitions', {
    method: 'POST',
    headers: { 'Tailscale-User-Login': 'auffueller@example.test' },
    body: { config: { graceDays: 99 } },
  });
  assert.equal(res.status, 403, 'Auffüller darf Schwellwerte NICHT ändern');
  assert.equal(res.json().error.code, 'CAPABILITY_REQUIRED');
});

test('AC-W3 LIVE: Admin-POST persistiert, GET spiegelt es (Snapshot/Restore)', async (t) => {
  const pgUrl = resolvePgUrlForTest();
  if (!pgUrl) { t.skip('Kein DASHBOARD_V2_PG_URL — Schreib-Round-Trip übersprungen.'); return; }
  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return; }

  const snap = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
  try { await snap.connect(); } catch (e) { t.skip(`PG nicht erreichbar (${e.code || e.message}).`); return; }
  // Originalzustand sichern, um die Produktions-Default-Zeile danach zu restaurieren.
  let original;
  try {
    const r = await snap.query(`SELECT config FROM automatenlager.classification_settings WHERE mandant_id='__default__'`);
    original = r.rows.length ? r.rows[0].config : {};
  } finally { /* keep snap open for restore */ }

  const port = await getFreePort();
  const dashboard = await startDashboard(port, { DASHBOARD_V2_PG_URL: pgUrl });
  t.after(async () => {
    dashboard.kill();
    try {
      await snap.query(
        `INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
         ON CONFLICT (mandant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [JSON.stringify(original)],
      );
    } finally { await snap.end(); }
  });

  const post = await request(port, '/api/v2/settings/definitions', {
    method: 'POST',
    body: { config: { graceDays: 21, categories: { snack: { marginPct: 58 } } } },
  });
  assert.equal(post.status, 200);
  const pj = post.json();
  assert.equal(pj.definitions.config.graceDays, 21);
  assert.equal(pj.definitions.config.categories.snack.marginPct, 58);

  // Teil-Speichern darf andere Kategorien nicht verwerfen.
  assert.equal(pj.definitions.config.categories.getraenk.marginPct, 43, 'getraenk bleibt erhalten');

  const get = await request(port, '/api/v2/settings/definitions');
  assert.equal(get.json().definitions.config.graceDays, 21, 'GET spiegelt den persistierten Wert');
});

// ── Frontend: editierbares Formular + Schreibpfad-Verdrahtung ─────────────────

test('AC-W4: v3.js rendert editierbares Settings-Formular + speichert über den Schreibpfad', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /bindSettingsControls/, 'Settings-Steuerung muss gebunden werden');
  assert.match(js, /data-set-key=/, 'editierbare Schwellwert-Felder vorhanden');
  assert.match(js, /data-set-cat=/, 'editierbare Kategorie-Margen vorhanden');
  assert.match(js, /postJson\('\/api\/v2\/settings\/definitions'/, 'Speichern über den Schreibpfad');
  assert.match(js, /renderSettingsPage\(result\.settings,\s*result\.canEdit\)/, 'canEdit steuert die Editierbarkeit');
});
