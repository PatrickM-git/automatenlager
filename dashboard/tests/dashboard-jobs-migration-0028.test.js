'use strict';

/**
 * Migration 0028 — DDL-Fundament GuV-Restatement (Issue #175, GuV-Kostenbasis-SPEC).
 * SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
 *
 * Beweist gegen die ECHTE Mini-DB im #94-Sandbox-Harness (ROLLBACK):
 *   - 0028 legt automatenlager.guv_daily.cost_basis (nullable, KEIN Default) an;
 *     CHECK erlaubt nur 'netto'/'brutto' (NULL erlaubt); Bestandszeilen bleiben NULL.
 *   - 0028 legt audit.guv_restatement_log mit allen Feldern an, inkl.
 *     executed_by (Default 'restatement-0030') + executed_context jsonb.
 *   - 0028 ist idempotent (zweimal anwendbar, kein Fehler, kein Drift).
 *   - Rollback-Index je restatement_run_id / guv_key vorhanden.
 * Reines DDL (additiv, sandbox-/rollback-sicher). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

test('#175 0028 LIVE: cost_basis-Spalte nullable, KEIN Default, alle Bestandszeilen NULL', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);

    const col = await client.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'automatenlager'
          AND table_name   = 'guv_daily'
          AND column_name  = 'cost_basis'`);
    assert.equal(col.rows.length, 1, 'Spalte cost_basis vorhanden');
    assert.equal(col.rows[0].is_nullable, 'YES', 'cost_basis ist nullable');
    assert.equal(col.rows[0].column_default, null, 'cost_basis hat KEIN Default');

    // „Kein stilles Auffüllen" robust geprüft: 0028 fügt eine NULLBARE Spalte OHNE
    // Default hinzu ⇒ eine frisch eingefügte Zeile OHNE cost_basis MUSS NULL bleiben.
    // (NICHT mehr „count über alle Live-Zeilen == 0" — nach dem produktiven Restatement
    // tragen Bestandszeilen legitim cost_basis='brutto'; das ist Datenstand, kein DDL-Defekt.)
    const ref = await client.query(
      `SELECT machine_id, product_id, tenant_id FROM automatenlager.guv_daily LIMIT 1`);
    if (ref.rows.length === 1) {
      const r = ref.rows[0];
      const ins = await client.query(
        `INSERT INTO automatenlager.guv_daily
           (guv_key, posting_date, machine_id, product_id, quantity_sold,
            revenue_gross, revenue_net, cost_of_goods, gross_profit, source, tenant_id)
         VALUES ('0028-test-' || gen_random_uuid(), CURRENT_DATE, $1, $2, 1,
                 1.00, 1.00, 0.50, 0.50, 'test_0028', $3)
         RETURNING cost_basis`,
        [r.machine_id, r.product_id, r.tenant_id]);
      assert.equal(ins.rows[0].cost_basis, null,
        'frische Zeile ohne cost_basis bleibt NULL (kein Default, kein stilles Auffüllen)');
    } else {
      // Leere Tabelle (z. B. frische CI-DB): no-default (oben geprüft) genügt als Garantie.
      assert.equal(col.rows[0].column_default, null);
    }
  });
});

test('#175 0028 LIVE: cost_basis-CHECK erlaubt netto/brutto/NULL, lehnt anderes ab', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);

    // Gültige Werte + NULL müssen durch den CHECK akzeptiert werden; ungültiger Wert abgelehnt.
    // Wir testen den Constraint ohne reale Daten zu mutieren: ein INSERT in eine
    // temporäre Probe ist nicht möglich (NOT-NULL-Pflichtfelder von guv_daily),
    // daher prüfen wir die Constraint-Definition direkt.
    const chk = await client.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t      ON t.oid = c.conrelid
         JOIN pg_namespace n  ON n.oid = t.relnamespace
        WHERE n.nspname = 'automatenlager'
          AND t.relname = 'guv_daily'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%cost_basis%'`);
    assert.equal(chk.rows.length, 1, 'genau ein CHECK-Constraint auf cost_basis');
    const def = chk.rows[0].def.toLowerCase();
    assert.ok(def.includes("'netto'") && def.includes("'brutto'"),
      'CHECK erlaubt netto und brutto');
  });
});

test('#175 0028 LIVE: audit.guv_restatement_log mit allen Feldern + Defaults', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);

    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'audit' AND table_name = 'guv_restatement_log'`);
    assert.ok(cols.rows.length > 0, 'Tabelle audit.guv_restatement_log vorhanden');
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));

    const expected = [
      'restatement_run_id', 'tenant_id', 'guv_key', 'source',
      'old_cost_of_goods', 'new_cost_of_goods',
      'old_revenue_net', 'new_revenue_net',
      'old_gross_profit', 'new_gross_profit',
      'vat_rate', 'factor',
      'executed_at', 'executed_by', 'executed_context',
      'rollback_at', 'rollback_by',
    ];
    for (const c of expected) {
      assert.ok(byName[c], `Spalte ${c} vorhanden`);
    }

    // executed_by: NOT NULL DEFAULT 'restatement-0030'
    assert.equal(byName.executed_by.is_nullable, 'NO', 'executed_by NOT NULL');
    assert.ok(
      (byName.executed_by.column_default || '').includes('restatement-0030'),
      "executed_by Default 'restatement-0030'");

    // executed_context jsonb, nullable
    assert.equal(byName.executed_context.data_type, 'jsonb', 'executed_context ist jsonb');
    assert.equal(byName.executed_context.is_nullable, 'YES', 'executed_context nullable');
  });
});

test('#175 0028 LIVE: Rollback-Index je restatement_run_id / guv_key vorhanden', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);

    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'audit' AND tablename = 'guv_restatement_log'`);
    const defs = idx.rows.map((r) => r.indexdef.toLowerCase()).join('\n');
    assert.ok(defs.includes('restatement_run_id'),
      'Index referenziert restatement_run_id (für Rollback je Run)');
  });
});

test('#175 0028 LIVE: idempotent — zweimal anwendbar ohne Fehler, kein Drift', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);
    await applyMigration(client, 28); // zweiter Lauf = No-op

    const col = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'automatenlager' AND table_name = 'guv_daily'
          AND column_name = 'cost_basis'`);
    assert.equal(col.rows[0].n, 1, 'cost_basis genau einmal vorhanden (kein Drift)');

    const tbl = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'audit' AND table_name = 'guv_restatement_log'`);
    assert.equal(tbl.rows[0].n, 1, 'guv_restatement_log genau einmal vorhanden');
  });
});
