'use strict';

/**
 * Migration 0033 — Portabilität für die Cloud-Migration (Issue #214, Slice 1).
 * SPEC: docs/specs/cloud-migration-3-schichten-phase-b-v1.md
 *       §"Supabase-spezifische DB-Anpassungen" → „Migration 0033 bedingt machen".
 *
 * `ALTER ROLE n8n_app NOBYPASSRLS` muss rollen-BEDINGT sein: auf Supabase existiert
 * die Rolle n8n_app NIE (n8n lief nur auf dem Mini). Eine unbedingte Anweisung würde
 * dort mit „role does not exist" hart fehlschlagen und die Migrationskette abbrechen.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, readMigration } = require('./helpers/migration-sandbox.js');

// Portabilität (statisch): die Migration darf das ALTER ROLE nur GUARDED enthalten.
test('#214 Migration 0033 ist rollen-bedingt (kein harter Fehler ohne n8n_app, z. B. Supabase)', () => {
  const sql = readMigration(33);
  assert.match(sql, /IF EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_roles\s+WHERE\s+rolname\s*=\s*'n8n_app'/i,
    'ALTER ROLE muss durch eine pg_roles-Existenzprüfung geschützt sein');
  // Kein unbedingtes ALTER ROLE am Spaltenanfang mehr (das geschützte steht eingerückt im DO-Block).
  assert.doesNotMatch(sql, /^ALTER ROLE n8n_app NOBYPASSRLS\s*;/m,
    'das ALTER ROLE darf nicht ungeschützt (Spalte 0) stehen — nur eingerückt im DO-Block');
});

// Verhalten (Sandbox): die Migration läuft sauber durch (idempotent; Rolle auf dem Mini vorhanden).
test('#214 Migration 0033 läuft sauber durch und ist idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 33);
    await applyMigration(client, 33); // zweite Anwendung ohne Fehler
    assert.ok(true, 'kein Fehler beim (wiederholten) Anwenden');
  });
});
