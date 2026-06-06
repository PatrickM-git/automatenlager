'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  EXPECTED_RELATIONS,
  relationColumnRefsInSql,
  aliasMapFor,
  introspectRows,
  diffExpectedRelations,
  findColumnViolations,
  buildSchemaReport,
  collectDashboardSqlRefs,
  runSchemaCheck,
} = require('../lib/db-schema.js');

const ROOT_DIR = path.join(__dirname, '..'); // dashboard/

// ── Scanner: reine Funktionen, laufen immer (kein DB nötig) ────────────────────

test('relationColumnRefsInSql: löst alias.spalte über automatenlager.<rel> auf', () => {
  const sql = `
    SELECT l.name, m.machine_id, m.active
      FROM automatenlager.locations l
      LEFT JOIN automatenlager.machines m ON m.location_id = l.location_id`;
  const refs = relationColumnRefsInSql(sql);
  assert.ok(refs.has('locations.name'));
  assert.ok(refs.has('machines.machine_id'));
  assert.ok(refs.has('machines.active'));
  assert.ok(refs.has('machines.location_id'));
  assert.ok(refs.has('locations.location_id'));
});

test('relationColumnRefsInSql: erfasst INSERT-Spaltenlisten', () => {
  const sql = `INSERT INTO automatenlager.locations (location_key, name, location_type, customer_group, notes)
               VALUES ($1,$2,$3,$4,$5)`;
  const refs = relationColumnRefsInSql(sql);
  assert.ok(refs.has('locations.location_key'));
  assert.ok(refs.has('locations.customer_group'));
  assert.ok(refs.has('locations.notes'));
});

test('relationColumnRefsInSql: ignoriert EXCLUDED und schema.tabelle, nicht als Spalte', () => {
  const sql = `INSERT INTO automatenlager.locations (name) VALUES ($1)
               ON CONFLICT (location_key) DO UPDATE SET name = EXCLUDED.name
               FROM automatenlager.locations l`;
  const refs = relationColumnRefsInSql(sql);
  assert.ok(![...refs].some((r) => r.startsWith('excluded.')), 'EXCLUDED darf keine Spalten-Ref erzeugen');
  assert.ok(![...refs].some((r) => r === 'automatenlager.locations'), 'schema.tabelle ist keine Spalte');
});

test('aliasMapFor: bindet auf Klausel folgende Relation NICHT als Alias (reserviertes Wort)', () => {
  const map = aliasMapFor('FROM automatenlager.guv_daily WHERE g.x = 1');
  assert.equal(map.get('where'), undefined, '"where" darf kein Alias sein');
  assert.equal(map.get('guv_daily'), 'guv_daily', 'Voll-Name bleibt selbst-gemappt');
});

// ── Report-Logik (synthetisches Live-Schema) ───────────────────────────────────

const FAKE_LIVE = introspectRows([
  { relation: 'locations', relkind: 'r', column: 'location_id' },
  { relation: 'locations', relkind: 'r', column: 'location_key' },
  { relation: 'locations', relkind: 'r', column: 'name' },
  { relation: 'machines', relkind: 'r', column: 'machine_id' },
  { relation: 'machines', relkind: 'r', column: 'location_id' },
]);

test('findColumnViolations: meldet im Code benutzte, aber fehlende Spalte (die "locations.status"-Klasse)', () => {
  // Genau der ursprüngliche Bug: alter Upsert schrieb nicht existierende Spalten.
  const refs = relationColumnRefsInSql(
    `INSERT INTO automatenlager.locations (name, status, start_date, machine_ids) VALUES ($1,$2,$3,$4)`,
  );
  const violations = findColumnViolations(refs, FAKE_LIVE.columnsByRelation);
  const cols = violations.map((v) => v.column);
  assert.ok(cols.includes('status'), 'status muss als fehlend erkannt werden');
  assert.ok(cols.includes('start_date'));
  assert.ok(cols.includes('machine_ids'));
  assert.ok(!cols.includes('name'), 'name existiert und darf nicht gemeldet werden');
});

test('diffExpectedRelations: meldet eine deklarierte, aber fehlende Relation', () => {
  const missing = diffExpectedRelations(['locations', 'machines']);
  assert.ok(missing.includes('products'), 'products ist deklariert, fehlt aber im Live-Schema');
  assert.ok(!missing.includes('locations'));
});

test('buildSchemaReport: healthy=false wenn eine benutzte Spalte fehlt', () => {
  const refs = relationColumnRefsInSql('SELECT l.nope FROM automatenlager.locations l');
  const report = buildSchemaReport(FAKE_LIVE, refs);
  assert.equal(report.healthy, false);
  assert.ok(report.missingColumns.some((v) => v.relation === 'locations' && v.column === 'nope'));
});

test('collectDashboardSqlRefs: liest echte Quellen und findet bekannte Refs', () => {
  const refs = collectDashboardSqlRefs(ROOT_DIR);
  assert.ok(refs.size > 0, 'es müssen SQL-Refs gefunden werden');
  assert.ok(refs.has('locations.customer_group'), 'location-profiles.js nutzt customer_group');
  assert.ok(refs.has('machines.location_id'));
});

// ── Live-Drift-Guard: prüft echtes Schema, überspringt offline ─────────────────

function resolvePgUrlForTest() {
  const fromEnv = process.env.DASHBOARD_V2_PG_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [path.join(ROOT_DIR, '..', '.env.local'), path.join(ROOT_DIR, '.env.local')];
  let merged = {};
  for (const fp of files) {
    let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      merged[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return (merged.DASHBOARD_V2_PG_URL || merged.POSTGRES_URL || merged.DATABASE_URL || '').trim();
}

// Migrations-aware: Solange die Stufe-1-Migrationen (0007+) noch nicht auf der DB
// deployt sind, prueft der Guard den POST-MIGRATIONS-Zustand — er wendet die
// Repo-Migrationen in EINER Transaktion an, prueft das Schema gegen den Code und
// macht per ROLLBACK garantiert nichts persistent. Nach dem Deploy sind die
// Migrationen idempotent (No-Op in der Transaktion) und der Guard prueft die
// echte DB unveraendert. So bleibt "Code <-> Schema deckungsgleich" gruen, ohne
// die Produktions-DB anzufassen.
test('LIVE: Dashboard-SQL passt zum echten automatenlager-Schema inkl. Repo-Migrationen (skip wenn PG offline)', async (t) => {
  const pgUrl = resolvePgUrlForTest();
  if (!pgUrl) { t.skip('Kein DASHBOARD_V2_PG_URL — Drift-Check übersprungen.'); return; }

  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return; }

  const { applyMigrationsFrom, withRollback } = require('./helpers/migration-sandbox.js');

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    t.skip(`PG nicht erreichbar (${err.code || err.message}) — Drift-Check übersprungen.`);
    return;
  }

  try {
    const report = await withRollback(client, async (c) => {
      await applyMigrationsFrom(c, 7); // ausstehende Stufe-1-Migrationen simulieren
      return runSchemaCheck(c, ROOT_DIR);
    });
    const detail = JSON.stringify({
      missingRelations: report.missingRelations,
      missingReferencedRelations: report.missingReferencedRelations,
      missingColumns: report.missingColumns,
    }, null, 2);
    assert.equal(report.healthy, true,
      `Schema-Drift erkannt — Code erwartet etwas, das die DB (inkl. Repo-Migrationen) nicht hat:\n${detail}`);
    assert.equal(report.missingRelations.length, 0);
    assert.equal(report.missingColumns.length, 0);
  } finally {
    await client.end();
  }
});

// Sicherheitsnetz: das Manifest selbst muss konsistent sein.
test('EXPECTED_RELATIONS: eindeutige Namen, gültige kinds', () => {
  const names = EXPECTED_RELATIONS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, 'Relationennamen müssen eindeutig sein');
  for (const r of EXPECTED_RELATIONS) {
    assert.ok(['table', 'view', 'matview'].includes(r.kind), `${r.name}: ungültige kind ${r.kind}`);
  }
});
