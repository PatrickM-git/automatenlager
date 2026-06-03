'use strict';

/**
 * Schema-Contract & Drift-Guard für das Dashboard.
 * ------------------------------------------------------------------
 * Hintergrund: Der Code formuliert rohes SQL gegen das PostgreSQL-Schema
 * `automatenlager` (homelab-DB, via SSH-Tunnel). Wenn eine Code-Annahme über
 * Tabellen/Spalten von der echten DB abweicht (z. B. SELECT auf eine Spalte,
 * die es nicht gibt), fällt das bisher erst zur Laufzeit als HTTP 503 auf —
 * genau beim Erweitern eines Features.
 *
 * Dieses Modul macht solche Abweichungen früh und präzise sichtbar:
 *   1. EXPECTED_RELATIONS  – deklarierte Liste der Relationen, die das Dashboard
 *      braucht. Existenz wird gegen die echte DB geprüft. → 1 Zeile pro neuer
 *      Relation, sonst keine Pflege.
 *   2. SQL-Scanner          – liest die tatsächlichen SQL-Strings aus server.js
 *      und lib/*.js und leitet die genutzten (Relation, Spalte)-Paare ab. So
 *      bleibt der Spalten-Contract IMMER deckungsgleich mit dem Code; man muss
 *      keine Spaltenliste von Hand pflegen. Neue Queries werden automatisch
 *      mitgeprüft.
 *   3. buildSchemaReport    – vergleicht (1)+(2) mit dem Live-Schema und meldet
 *      fehlende Relationen / fehlende Spalten.
 *
 * Verwendet von:
 *   - tests/dashboard-db-schema.test.js  (Drift-Guard; überspringt offline)
 *   - GET /api/v2/_diagnostics/schema     (Laufzeit-Report, Admin)
 *   - Startup-Check in server.js          (Log-Warnung beim Start)
 *
 * Bewusste Grenzen des Scanners (konservativ → lieber still als Fehlalarm):
 *   - Nur qualifizierte `alias.spalte`-Referenzen, deren Alias im selben SQL an
 *     `automatenlager.<relation>` gebunden ist, sowie INSERT-Spaltenlisten.
 *   - Unqualifizierte SELECT-Spalten, `SELECT *` und UPDATE-SET-Spalten werden
 *     NICHT auf Spaltenebene geprüft (keine zuverlässige Zuordnung ohne echten
 *     SQL-Parser). Die Relations-Existenz deckt diese Fälle grob ab.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'automatenlager';

// Relationen, auf die das Dashboard zugreift. kind nur zur Doku.
// relkind in der DB: r=table, v=view, m=materialized view, p=partitioned, f=foreign.
const EXPECTED_RELATIONS = [
  { name: 'locations',                kind: 'table',   note: 'Standorte (location-profiles)' },
  { name: 'machines',                 kind: 'table',   note: 'Automaten' },
  { name: 'machine_profiles',         kind: 'table',   note: 'Automaten-Metadaten' },
  { name: 'slot_assignments',         kind: 'table',   note: 'Aktive MDB/Slot-Zuordnungen' },
  { name: 'products',                 kind: 'table',   note: 'Produktstammdaten' },
  { name: 'product_aliases',          kind: 'table',   note: 'Produkt-Aliase' },
  { name: 'product_change_proposals', kind: 'table',   note: 'Korrektur-/Wechselvorschläge' },
  { name: 'stock_batches',            kind: 'table',   note: 'Lagerchargen (FIFO)' },
  { name: 'sales_transactions',       kind: 'table',   note: 'Nayax-Verkäufe' },
  { name: 'guv_daily',                kind: 'table',   note: 'GuV-Tagesposten' },
  { name: 'warnings',                 kind: 'table',   note: 'Warnungen' },
  { name: 'invoices',                 kind: 'table',   note: 'Rechnungen' },
  { name: 'invoice_items',            kind: 'table',   note: 'Rechnungspositionen' },
  { name: 'suppliers',                kind: 'table',   note: 'Lieferanten' },
  { name: 'classification_settings',  kind: 'table',   note: 'Kategorie-/Schwellwert-Config je Mandant (#63)' },
  { name: 'v_warnings_open',          kind: 'view',    note: 'Offene Warnungen (View)' },
  { name: 'v_slot_turnover',          kind: 'view',    note: 'Slot-Umschlag (View)' },
  { name: 'mv_inventory_value_daily', kind: 'matview', note: 'Inventarwert (Materialized View)' },
];

// pg_catalog statt information_schema, DAMIT materialized views (relkind 'm')
// und partitionierte Tabellen mitgezählt werden. $1 = Schema-Name.
const INTROSPECT_SQL = `
  SELECT c.relname AS relation, c.relkind AS relkind, a.attname AS column
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a
      ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
   ORDER BY c.relname, a.attnum
`;

// SQL-Schlüsselwörter, die fälschlich als Tabellen-Alias erkannt würden, wenn
// eine Relation ohne Alias direkt von einer Klausel gefolgt wird.
const RESERVED_ALIASES = new Set([
  'as', 'on', 'using', 'where', 'group', 'order', 'having', 'limit', 'offset',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral',
  'union', 'and', 'or', 'set', 'values', 'returning', 'with', 'select', 'from',
]);

// ── Live-Schema einlesen ────────────────────────────────────────────────────

// rows: [{ relation, relkind, column }] → gruppiert.
function introspectRows(rows) {
  const columnsByRelation = {};
  const relationKinds = {};
  for (const row of rows) {
    relationKinds[row.relation] = row.relkind;
    if (!columnsByRelation[row.relation]) columnsByRelation[row.relation] = [];
    if (row.column) columnsByRelation[row.relation].push(row.column);
  }
  return { columnsByRelation, relationKinds };
}

async function fetchLiveSchema(client, schema = SCHEMA) {
  const res = await client.query(INTROSPECT_SQL, [schema]);
  return introspectRows(res.rows);
}

// ── SQL-Scanner: (Relation, Spalte)-Abhängigkeiten aus Quelltext ableiten ────

// Alle Backtick-Strings, die `automatenlager.` enthalten.
function extractSqlLiterals(source) {
  const literals = [];
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(source))) {
    if (/automatenlager\./i.test(m[1])) literals.push(m[1]);
  }
  return literals;
}

// alias → relation, plus relation → relation (für unaliasierte Voll-Namen-Refs).
function aliasMapFor(sql) {
  const map = new Map();
  const re = /\bautomatenlager\.([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const relation = m[1].toLowerCase();
    map.set(relation, relation);
    const alias = m[2] && m[2].toLowerCase();
    if (alias && !RESERVED_ALIASES.has(alias)) map.set(alias, relation);
  }
  return map;
}

// `alias.spalte`-Referenzen → "relation.column".
function qualifiedRefs(sql, aliasMap) {
  const refs = new Set();
  const re = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const left = m[1].toLowerCase();
    const col = m[2].toLowerCase();
    if (left === 'automatenlager') continue; // das ist schema.tabelle, keine Spalte
    if (left === 'excluded') continue;        // Upsert-Pseudotabelle
    const relation = aliasMap.get(left);
    if (relation) refs.add(`${relation}.${col}`);
  }
  return refs;
}

// INSERT INTO automatenlager.tbl (col, col, ...) → "relation.column".
function insertRefs(sql) {
  const refs = new Set();
  const re = /insert\s+into\s+automatenlager\.([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const relation = m[1].toLowerCase();
    for (const raw of m[2].split(',')) {
      const col = raw.trim().toLowerCase();
      if (/^[a-z_][a-z0-9_]*$/.test(col)) refs.add(`${relation}.${col}`);
    }
  }
  return refs;
}

// (Relation, Spalte)-Refs aus EINEM SQL-String.
function relationColumnRefsInSql(sql) {
  const refs = new Set();
  const aliasMap = aliasMapFor(sql);
  for (const ref of qualifiedRefs(sql, aliasMap)) refs.add(ref);
  for (const ref of insertRefs(sql)) refs.add(ref);
  return refs;
}

// (Relation, Spalte)-Refs aus JS-QUELLTEXT (extrahiert die eingebetteten
// Backtick-SQL-Strings und scannt jeden einzeln).
function parseRelationColumnRefs(source) {
  const refs = new Set();
  for (const sql of extractSqlLiterals(source)) {
    for (const ref of relationColumnRefsInSql(sql)) refs.add(ref);
  }
  return refs;
}

// Die Dashboard-Quelldateien, in denen SQL steht (db-schema.js & Tests ausgenommen).
function dashboardSourceFiles(rootDir) {
  const files = [path.join(rootDir, 'server.js')];
  const libDir = path.join(rootDir, 'lib');
  let entries = [];
  try { entries = fs.readdirSync(libDir); } catch { entries = []; }
  for (const name of entries) {
    if (name.endsWith('.js') && name !== 'db-schema.js') files.push(path.join(libDir, name));
  }
  return files;
}

function collectDashboardSqlRefs(rootDir) {
  const refs = new Set();
  for (const file of dashboardSourceFiles(rootDir)) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const ref of parseRelationColumnRefs(src)) refs.add(ref);
  }
  return refs;
}

// ── Report bauen ─────────────────────────────────────────────────────────────

function diffExpectedRelations(liveRelationNames) {
  const live = new Set(liveRelationNames);
  return EXPECTED_RELATIONS.filter((r) => !live.has(r.name)).map((r) => r.name);
}

function findColumnViolations(refs, columnsByRelation) {
  const violations = [];
  for (const ref of refs) {
    const dot = ref.indexOf('.');
    const relation = ref.slice(0, dot);
    const column = ref.slice(dot + 1);
    const cols = columnsByRelation[relation];
    if (!cols) continue; // Relation fehlt → separat als Relation gemeldet
    if (!cols.includes(column)) violations.push({ relation, column });
  }
  return violations.sort((a, b) =>
    `${a.relation}.${a.column}`.localeCompare(`${b.relation}.${b.column}`));
}

function buildSchemaReport(live, sqlRefs) {
  const liveRelations = Object.keys(live.columnsByRelation);
  const missingRelations = diffExpectedRelations(liveRelations);

  const refRelations = new Set([...sqlRefs].map((r) => r.slice(0, r.indexOf('.'))));
  const missingReferencedRelations = [...refRelations]
    .filter((r) => !live.columnsByRelation[r])
    .sort();

  const missingColumns = findColumnViolations(sqlRefs, live.columnsByRelation);

  const healthy = missingRelations.length === 0
    && missingReferencedRelations.length === 0
    && missingColumns.length === 0;

  return {
    schema: SCHEMA,
    healthy,
    checkedRelations: EXPECTED_RELATIONS.length,
    checkedColumnRefs: sqlRefs.size,
    liveRelationCount: liveRelations.length,
    missingRelations,              // deklariert (EXPECTED_RELATIONS), aber nicht in DB
    missingReferencedRelations,    // im SQL benutzt, aber nicht in DB
    missingColumns,                // im SQL benutzte Spalte fehlt in DB (die "locations.status"-Klasse)
  };
}

// Orchestriert den Live-Check. Der Aufrufer stellt einen verbundenen pg-Client
// und beendet ihn auch (try/finally beim Aufrufer).
async function runSchemaCheck(client, rootDir) {
  const live = await fetchLiveSchema(client);
  const sqlRefs = collectDashboardSqlRefs(rootDir);
  return buildSchemaReport(live, sqlRefs);
}

module.exports = {
  SCHEMA,
  EXPECTED_RELATIONS,
  INTROSPECT_SQL,
  RESERVED_ALIASES,
  introspectRows,
  fetchLiveSchema,
  extractSqlLiterals,
  aliasMapFor,
  relationColumnRefsInSql,
  parseRelationColumnRefs,
  dashboardSourceFiles,
  collectDashboardSqlRefs,
  diffExpectedRelations,
  findColumnViolations,
  buildSchemaReport,
  runSchemaCheck,
};
