'use strict';

/**
 * write-off Schreib-Isolation — Stufe 4, Slice 3d (Issue #138, „übersehener" Schreiber).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Direkte DB-Schreiber"
 *
 * writeOffBatchPg läuft DURCH die Tür in db.tx: SELECT … FOR UPDATE + UPDATE auf
 * stock_batches/warnings, beide mandantengebunden (tenant_id = $1). Eine fremde
 * Charge ist im tenant-gefilterten SELECT unsichtbar ⇒ NOT_FOUND, keine Änderung.
 * Nicht-vakuös gegen acme/globex im #94-Harness.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb } = require('../lib/tenant-db.js');
const { writeOffBatchPg } = require('../lib/write-off.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

function doorForSandbox(client) { return createTenantDb({ pool: sandboxTxPool(client) }); }

// LOW_STOCK-Warnung je Mandant für dessen Produkt (wird vom Ausbuchen aufgelöst).
async function seedLowStockWarning(client, tid, productId) {
  await client.query(
    `INSERT INTO automatenlager.warnings (warning_key, warning_type, message, source_workflow, product_id, tenant_id, resolved)
       VALUES ($1, 'LOW_STOCK', 'low', 'wf5', $2, $3, FALSE)`,
    [`wo_${tid}`, productId, tid]);
}

test('#138 fail-closed: Ausbuchen ohne Mandant WIRFT', async () => {
  const noop = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) };
  const db = createTenantDb({ pool: noop });
  await assert.rejects(() => writeOffBatchPg(db, '', 'b_x', null), /Mandant/i);
});

test('#138 read-after-write: acme bucht eigene Charge aus (Charge + Warnung), globex unberührt', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client); // b_acme/b_globex, status 'active', remaining 30
    await seedLowStockWarning(client, 'acme', acme.productId);
    await seedLowStockWarning(client, 'globex', globex.productId);
    const db = doorForSandbox(client);

    const outcome = await writeOffBatchPg(db, 'acme', 'b_acme', null);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.written_off_qty, 30);

    // acme-Charge ausgesondert + leer; acme-Warnung aufgelöst
    const ab = await client.query(`SELECT status, remaining_qty FROM automatenlager.stock_batches WHERE batch_key='b_acme' AND tenant_id='acme'`);
    assert.equal(ab.rows[0].status, 'ausgesondert');
    assert.equal(Number(ab.rows[0].remaining_qty), 0);
    const aw = await client.query(`SELECT resolved FROM automatenlager.warnings WHERE warning_key='wo_acme'`);
    assert.equal(aw.rows[0].resolved, true, 'acme-Warnung mandantengebunden aufgelöst');

    // globex-Charge + Warnung unberührt
    const gb = await client.query(`SELECT status, remaining_qty FROM automatenlager.stock_batches WHERE batch_key='b_globex' AND tenant_id='globex'`);
    assert.equal(gb.rows[0].status, 'active', 'globex-Charge unangetastet');
    assert.equal(Number(gb.rows[0].remaining_qty), 30);
    const gw = await client.query(`SELECT resolved FROM automatenlager.warnings WHERE warning_key='wo_globex'`);
    assert.equal(gw.rows[0].resolved, false, 'globex-Warnung NICHT aufgelöst');
  });
});

test('#138 fremde Charge ⇒ NOT_FOUND, keine Änderung an globex-Daten', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    const db = doorForSandbox(client);

    // acme versucht globex' Charge auszubuchen ⇒ vom tenant-gefilterten SELECT nicht gesehen.
    await assert.rejects(() => writeOffBatchPg(db, 'acme', 'b_globex', null), (err) => err.code === 'NOT_FOUND');

    const gb = await client.query(`SELECT status, remaining_qty FROM automatenlager.stock_batches WHERE batch_key='b_globex' AND tenant_id='globex'`);
    assert.equal(gb.rows[0].status, 'active', 'globex-Charge unverändert');
    assert.equal(Number(gb.rows[0].remaining_qty), 30);
  });
});
