'use strict';

/**
 * Geteilter Migrations-Sandbox-Helper (Issue #94 — Fundament aller Stufe-1-Tests).
 * ------------------------------------------------------------------------------
 * Verifiziert die Schema-Migrationen 0007+ gegen die ECHTE automatenlager-DB,
 * OHNE jede reale Mutation: jede Migration wird in EINER Transaktion angewendet
 * und per ROLLBACK garantiert zurueckgenommen (analog zur bewaehrten Praxis in
 * dashboard-nayax-abgleich-pgw-rollback.test.js). Offline (kein PG erreichbar)
 * sauber ueberspringbar via t.skip.
 *
 *   connectOrSkip(t)              -> verbundener pg-Client oder null (Test skippt)
 *   readMigration(num)            -> SQL-Text einer Migration (per 4-stelligem Praefix)
 *   applyMigration(client, num)   -> eine Migration anwenden
 *   listMigrations(fromNum)       -> [{num,file}] aller Repo-Migrationen >= fromNum
 *   applyMigrationsFrom(client,n) -> alle Repo-Migrationen >= n der Reihe nach anwenden
 *   withRollback(client, fn)      -> BEGIN -> fn(client) -> ROLLBACK (garantiert)
 *   inSandbox(t, fn)              -> connect + BEGIN + fn + ROLLBACK + end (one-shot)
 *
 * Die Migrationen sind idempotent (IF NOT EXISTS / IF EXISTS / ON CONFLICT), daher
 * funktioniert applyMigrationsFrom sowohl gegen eine noch-nicht-migrierte DB
 * (simuliert den Post-Deploy-Zustand) als auch gegen eine bereits migrierte
 * (No-Op in der Transaktion).
 */

const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_ROOT = path.join(__dirname, '..', '..'); // tests/helpers -> dashboard
const MIGRATIONS_DIR = path.join(DASHBOARD_ROOT, 'db-migrations');

// PG-URL aus Env oder .env.local (Projekt- oder dashboard-Ebene) — identisch zur
// bestehenden Test-Praxis. Gibt KEINE Secrets aus.
function resolvePgUrl() {
  const fromEnv = process.env.DASHBOARD_V2_PG_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [path.join(DASHBOARD_ROOT, '..', '.env.local'), path.join(DASHBOARD_ROOT, '.env.local')];
  const merged = {};
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

// Verbindet oder skippt den Test (offline/CI). Rueckgabe: Client oder null.
async function connectOrSkip(t, timeoutMs = 4000) {
  const url = resolvePgUrl();
  if (!url) { t.skip('Kein DASHBOARD_V2_PG_URL — Migrations-Sandbox uebersprungen.'); return null; }
  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return null; }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
  try { await client.connect(); } catch (err) { t.skip(`PG nicht erreichbar (${err.code || err.message}).`); return null; }
  return client;
}

function migrationFilePath(num) {
  const prefix = String(num).padStart(4, '0');
  const match = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.startsWith(prefix + '-') && f.endsWith('.sql'));
  if (!match.length) throw new Error(`Keine Migration mit Praefix ${prefix} in ${MIGRATIONS_DIR}`);
  return path.join(MIGRATIONS_DIR, match[0]);
}

function readMigration(num) {
  return fs.readFileSync(migrationFilePath(num), 'utf8');
}

async function applyMigration(client, num) {
  await client.query(readMigration(num));
}

// Alle Repo-Migrationen mit 4-stelligem Praefix >= fromNum, aufsteigend sortiert.
function listMigrations(fromNum = 1) {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}-.*\.sql$/.test(f))
    .map((f) => ({ num: parseInt(f.slice(0, 4), 10), file: f }))
    .filter((m) => m.num >= fromNum)
    .sort((a, b) => a.num - b.num);
}

// Wendet 0007.. (Default) bzw. ab fromNum der Reihe nach an. Setzt voraus, dass
// die jeweils frueheren Migrationen bereits in der DB sind (committed) ODER in
// derselben Transaktion zuvor angewendet wurden.
async function applyMigrationsFrom(client, fromNum = 7) {
  for (const m of listMigrations(fromNum)) {
    await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8'));
  }
}

// Erwartet, dass ein Query mit einem Constraint-/FK-Fehler abgelehnt wird, OHNE
// die umgebende Sandbox-Transaktion zu zerstoeren. Ein Fehler abortet in PG die
// ganze Transaktion (25P02) — ein SAVEPOINT isoliert den erwarteten Fehler, sodass
// der Test danach weiter asserten kann.
async function expectReject(client, queryText, re, message) {
  const assert = require('node:assert/strict');
  await client.query('SAVEPOINT mt_expect');
  await assert.rejects(() => client.query(queryText), re, message);
  await client.query('ROLLBACK TO SAVEPOINT mt_expect');
}

// BEGIN -> fn -> ROLLBACK. ROLLBACK ist die harte Grenze: nichts wird committet.
async function withRollback(client, fn) {
  await client.query('BEGIN');
  try {
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

// One-shot: verbinden, in einer Rollback-Transaktion arbeiten, Verbindung schliessen.
// fn bekommt den Client. Bei offline skippt der Test und fn laeuft nicht.
async function inSandbox(t, fn, timeoutMs = 4000) {
  const client = await connectOrSkip(t, timeoutMs);
  if (!client) return;
  try {
    await withRollback(client, fn);
  } finally {
    await client.end();
  }
}

module.exports = {
  DASHBOARD_ROOT,
  MIGRATIONS_DIR,
  resolvePgUrl,
  connectOrSkip,
  migrationFilePath,
  readMigration,
  applyMigration,
  listMigrations,
  applyMigrationsFrom,
  withRollback,
  inSandbox,
  expectReject,
};
