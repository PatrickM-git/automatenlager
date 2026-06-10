'use strict';

/**
 * EK-Preis-Korrektur pro Lagercharge + GuV-Restatement (#209).
 * (1) Reine Validierung validateBatchEkUpdate.
 * (2) Live-Sandbox: batch EK korrigieren, guv_daily restated, Audit-Log prüfen.
 * (3) Mandanten-Isolation: globex unberührt.
 * (4) Datumsgrenze: zweite Charge begrenzt den Restatement-Scope.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { validateBatchEkUpdate, applyBatchEkUpdate } = require('../lib/batch-ek-correction.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── Ebene 1: Validierung ─────────────────────────────────────────────────────

test('#209 validateBatchEkUpdate: gültig vs. fehlerhaft', () => {
  assert.equal(validateBatchEkUpdate({ batchKey: 'b_twix_01', unitCostNet: 0.48  }).ok, true);
  assert.equal(validateBatchEkUpdate({ batchKey: 'b_x',       unitCostNet: 0.001 }).ok, true);
  assert.equal(validateBatchEkUpdate({ batchKey: '',          unitCostNet: 0.5   }).ok, false, 'leerer batch_key');
  assert.equal(validateBatchEkUpdate({ batchKey: null,        unitCostNet: 0.5   }).ok, false, 'null batch_key');
  assert.equal(validateBatchEkUpdate({ batchKey: 'b_x',       unitCostNet: 0     }).ok, false, 'value = 0');
  assert.equal(validateBatchEkUpdate({ batchKey: 'b_x',       unitCostNet: -1    }).ok, false, 'negativ');
  assert.equal(validateBatchEkUpdate({ batchKey: 'b_x',       unitCostNet: 'x'   }).ok, false, 'kein Number');
  assert.deepEqual(validateBatchEkUpdate({ batchKey: 'b_x', unitCostNet: 0.48 }).value, 0.48, 'value geparsed');
});

// ── Ebene 2: Live EK-Korrektur + GuV-Restatement ─────────────────────────────

test('#209 applyBatchEkUpdate LIVE: EK korrigiert, guv_daily restated, Audit-Log geschrieben', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // Migration 28: audit.guv_restatement_log; 30: GRANT auf audit-Tabellen.
    for (const n of [28, 30]) await applyMigration(client, n);

    const db = createTenantDb({ pool: sandboxTxPool(client) });
    const runId = 'test-run-209';

    // Vorher: unit_cost_net = 5 (cost=50, qty=10 ⇒ unit=5); guv_daily.cost_of_goods = 50
    const pre = await db.read({
      tenant: 'acme', tables: ['stock_batches'],
      text: `SELECT unit_cost_net FROM automatenlager.stock_batches WHERE tenant_id=$1 AND batch_key='b_acme'`,
    });
    assert.equal(Number(pre.rows[0].unit_cost_net), 5, 'Vorwert unit_cost_net = 5');

    const result = await applyBatchEkUpdate(db, 'acme', {
      batchKey: 'b_acme',
      unitCostNet: 7,
      runId,
    });

    // Zusammenfassung
    assert.equal(result.batchKey,    'b_acme');
    assert.equal(result.oldUnitCost, 5);
    assert.equal(result.newUnitCost, 7);
    assert.equal(result.guvRestated, 1, 'eine guv_daily-Zeile restated');
    assert.equal(result.guvLogged,   1, 'eine Audit-Log-Zeile');

    // Batch-EK aktualisiert
    const batch = await db.read({
      tenant: 'acme', tables: ['stock_batches'],
      text: `SELECT unit_cost_net FROM automatenlager.stock_batches WHERE tenant_id=$1 AND batch_key='b_acme'`,
    });
    assert.equal(Number(batch.rows[0].unit_cost_net), 7, 'Batch-EK auf 7 gesetzt');

    // guv_daily restated: cost_of_goods = 50 * (7/5) = 70; gross_profit = revenue_gross - 70
    const guv = await db.read({
      tenant: 'acme', tables: ['guv_daily'],
      text: `SELECT cost_of_goods, gross_profit, revenue_gross FROM automatenlager.guv_daily WHERE tenant_id=$1 AND guv_key='guv_acme_20260515'`,
    });
    assert.equal(Number(guv.rows[0].cost_of_goods), 70, 'cost_of_goods = 70 (50 × 7/5)');
    assert.equal(Number(guv.rows[0].gross_profit),  Number(guv.rows[0].revenue_gross) - 70, 'gross_profit = revenue_gross - 70');

    // Audit-Log
    const log = await client.query(
      `SELECT old_cost_of_goods, new_cost_of_goods, executed_by, executed_context
         FROM audit.guv_restatement_log
        WHERE restatement_run_id=$1 AND tenant_id='acme'`,
      [runId],
    );
    assert.equal(log.rows.length, 1, 'Audit-Log-Eintrag');
    assert.equal(Number(log.rows[0].old_cost_of_goods), 50, 'old_cost_of_goods = 50');
    assert.equal(Number(log.rows[0].new_cost_of_goods), 70, 'new_cost_of_goods = 70');
    const ctx = log.rows[0].executed_context; // JSONB → bereits JS-Objekt
    assert.equal(ctx.batch_key,    'b_acme', 'Audit-Context: batch_key');
    assert.equal(ctx.old_unit_cost, 5,       'Audit-Context: old_unit_cost');
    assert.equal(ctx.new_unit_cost, 7,       'Audit-Context: new_unit_cost');
  });
});

// ── Ebene 2: Mandanten-Isolation ─────────────────────────────────────────────

test('#209 applyBatchEkUpdate LIVE: globex-Charge + guv_daily unberührt (Isolation)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    for (const n of [28, 30]) await applyMigration(client, n);

    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // acme-Charge korrigieren
    await applyBatchEkUpdate(db, 'acme', { batchKey: 'b_acme', unitCostNet: 9, runId: 'iso-test' });

    // globex-Charge unverändert
    const g = await db.read({
      tenant: 'globex', tables: ['stock_batches'],
      text: `SELECT unit_cost_net FROM automatenlager.stock_batches WHERE tenant_id=$1 AND batch_key='b_globex'`,
    });
    assert.equal(Number(g.rows[0].unit_cost_net), 12.5, 'globex unit_cost_net unberührt (250*0.5/10=12.5)');

    // globex-GuV unverändert
    const gGuv = await db.read({
      tenant: 'globex', tables: ['guv_daily'],
      text: `SELECT cost_of_goods FROM automatenlager.guv_daily WHERE tenant_id=$1 AND guv_key='guv_globex_20260515'`,
    });
    assert.equal(Number(gGuv.rows[0].cost_of_goods), 125, 'globex cost_of_goods unberührt (250*0.5=125)');
  });
});

// ── Ebene 2: Datumsgrenze (zweite Charge begrenzt Scope) ─────────────────────

test('#209 applyBatchEkUpdate LIVE: zweite Charge begrenzt Restatement-Scope', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of [28, 30]) await applyMigration(client, n);

    // Zweite Charge mit received_at NACH dem GuV-Posting (2026-05-15)
    // → GuV-Zeile 2026-05-15 gehört zur ERSTEN Charge (received 2026-05-01),
    //   NICHT zur zweiten (received 2026-06-01).
    // Erste Charge korrigieren: nur die Zeile 2026-05-15 liegt im Scope.
    await client.query(
      `INSERT INTO automatenlager.stock_batches
         (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, tenant_id)
         VALUES ('b_acme_2', $1, 20, 20, 3.0, 'active', '2026-06-01', 'acme')`,
      [acme.productId],
    );
    // GuV-Zeile für NEUES Datum (nach 2. Charge) → darf NICHT restated werden
    const machineRes = await client.query(
      `SELECT machine_id FROM automatenlager.machines WHERE tenant_id='acme' LIMIT 1`,
    );
    const machineId = machineRes.rows[0].machine_id;
    await client.query(
      `INSERT INTO automatenlager.guv_daily
         (guv_key, posting_date, machine_id, product_id, quantity_sold,
          revenue_gross, revenue_net, cost_of_goods, gross_profit, source, tenant_id)
         VALUES ('guv_acme_20260610', '2026-06-10', $1, $2, 5, 25, 25, 15, 10, 'wf8_daily', 'acme')`,
      [machineId, acme.productId],
    );

    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const result = await applyBatchEkUpdate(db, 'acme', {
      batchKey: 'b_acme',  // erste Charge (received 2026-05-01)
      unitCostNet: 7,
      runId: 'scope-test',
    });

    // Nur die Zeile 2026-05-15 liegt im Scope (< 2026-06-01)
    assert.equal(result.guvRestated, 1, 'nur 1 Zeile restated (2026-05-15), nicht die 2026-06-10-Zeile');

    // Die 2026-06-10-Zeile bleibt unverändert
    const newGuv = await db.read({
      tenant: 'acme', tables: ['guv_daily'],
      text: `SELECT cost_of_goods FROM automatenlager.guv_daily WHERE tenant_id=$1 AND guv_key='guv_acme_20260610'`,
    });
    assert.equal(Number(newGuv.rows[0].cost_of_goods), 15, '2026-06-10-Zeile unberührt');
  });
});

// ── Ebene 2: Charge nicht gefunden ───────────────────────────────────────────

test('#209 applyBatchEkUpdate LIVE: unbekannte Charge → BATCH_NOT_FOUND', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of [28, 30]) await applyMigration(client, n);

    const db = createTenantDb({ pool: sandboxTxPool(client) });

    await assert.rejects(
      () => applyBatchEkUpdate(db, 'acme', { batchKey: 'b_nicht_vorhanden', unitCostNet: 1, runId: 'err-test' }),
      (err) => err.code === 'BATCH_NOT_FOUND',
      'wirft BATCH_NOT_FOUND',
    );
  });
});
