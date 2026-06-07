'use strict';

/**
 * Inline-Inventur (lib/inventory-count.js) — Issue #152.
 * Reine Funktionen (ohne DB) + Schreib-Isolation live gegen die Mini-DB
 * (#94-Sandbox-Harness, ROLLBACK) als Mandanten-Tür.
 *
 * Beweist: remaining_qty (Lager) wird gesetzt, NIE machine_qty; Wertebereich
 * 0..initial_qty; optimistic lock; fremde Charge ⇒ NOT_FOUND (RLS/Tür).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateInventoryCount, canSetCount, setBatchCountPg, buildInventoryCountAuditEntry,
} = require('../lib/inventory-count.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

function doorForDb(client) { return createTenantDb({ pool: sandboxTxPool(client) }); }

// ── Reine Validierung ────────────────────────────────────────────────────────
test('#152 validateInventoryCount: gültig (ganze Zahl >= 0)', () => {
  assert.equal(validateInventoryCount({ batch_key: 'b1', new_qty: 5 }).valid, true);
  assert.equal(validateInventoryCount({ batch_key: 'b1', new_qty: 0 }).valid, true, '0 ist gültig (leer gezählt)');
});

test('#152 validateInventoryCount: ungültig (fehlend/negativ/Komma/leer)', () => {
  assert.equal(validateInventoryCount({ new_qty: 5 }).valid, false, 'batch_key fehlt');
  assert.equal(validateInventoryCount({ batch_key: 'b1', new_qty: -1 }).valid, false, 'negativ');
  assert.equal(validateInventoryCount({ batch_key: 'b1', new_qty: 2.5 }).valid, false, 'keine ganze Zahl');
  assert.equal(validateInventoryCount({ batch_key: 'b1' }).valid, false, 'new_qty fehlt');
  assert.equal(validateInventoryCount({ batch_key: 'b1', new_qty: 'x' }).valid, false, 'keine Zahl');
});

// ── canSetCount-Verdikt ──────────────────────────────────────────────────────
test('#152 canSetCount: Verdikte (NOT_FOUND/ABGEBUCHT/RANGE/DRIFT/ok)', () => {
  assert.equal(canSetCount(null, 5, null).code, 'NOT_FOUND');
  assert.equal(canSetCount({ status: 'ausgesondert', remaining_qty: 0, initial_qty: 50 }, 5, null).code, 'ALREADY_WRITTEN_OFF');
  assert.equal(canSetCount({ status: 'active', remaining_qty: 30, initial_qty: 50 }, 60, null).code, 'OUT_OF_RANGE', 'mehr als initial_qty');
  assert.equal(canSetCount({ status: 'active', remaining_qty: 30, initial_qty: 50 }, 42, 99).code, 'DRIFT', 'expected stimmt nicht');
  assert.equal(canSetCount({ status: 'active', remaining_qty: 30, initial_qty: 50 }, 42, 30).ok, true);
  assert.equal(canSetCount({ status: 'active', remaining_qty: 30, initial_qty: 50 }, 0, null).ok, true, '0 erlaubt');
});

test('#152 buildInventoryCountAuditEntry: alt→neu + Actor', () => {
  const e = buildInventoryCountAuditEntry({ login: 'me@x' }, { batch_key: 'b1' }, { ok: true, product_id: 7, previous_qty: 30, new_qty: 42 });
  assert.equal(e.action, 'inventory_set_count');
  assert.equal(e.actor, 'me@x');
  assert.equal(e.previous_qty, 30);
  assert.equal(e.new_qty, 42);
});

// ── Schreib-Isolation live (Sandbox) ─────────────────────────────────────────
test('#152 setBatchCountPg: acme setzt eigenen Chargenrest; globex unberührt, machine_qty NIE geändert', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client); // b_acme/b_globex: initial 50, remaining 30
    const db = doorForDb(client);
    // Ausgangs-machine_qty (slot_assignments.current_machine_qty) festhalten.
    const beforeSlot = await client.query(
      `SELECT current_machine_qty FROM automatenlager.slot_assignments WHERE tenant_id='acme' AND product_slot_key='slot_acme'`);
    const out = await setBatchCountPg(db, 'acme', 'b_acme', 42, 30);
    assert.equal(out.ok, true);
    assert.equal(out.previous_qty, 30);
    assert.equal(out.new_qty, 42);
    // acme-Charge neu, globex unverändert
    const acme = await client.query(`SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id='acme' AND batch_key='b_acme'`);
    const globex = await client.query(`SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id='globex' AND batch_key='b_globex'`);
    assert.equal(Number(acme.rows[0].remaining_qty), 42, 'acme remaining_qty gesetzt');
    assert.equal(Number(globex.rows[0].remaining_qty), 30, 'globex unberührt');
    // machine_qty (Im Automaten) NICHT verändert
    const afterSlot = await client.query(
      `SELECT current_machine_qty FROM automatenlager.slot_assignments WHERE tenant_id='acme' AND product_slot_key='slot_acme'`);
    assert.equal(Number(afterSlot.rows[0].current_machine_qty), Number(beforeSlot.rows[0].current_machine_qty), 'machine_qty unverändert');
  });
});

test('#152 setBatchCountPg: acme kann globex-Charge NICHT setzen ⇒ NOT_FOUND (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    const db = doorForDb(client);
    await assert.rejects(() => setBatchCountPg(db, 'acme', 'b_globex', 10, null), (e) => e.code === 'NOT_FOUND');
    // globex-Charge unverändert
    const globex = await client.query(`SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id='globex' AND batch_key='b_globex'`);
    assert.equal(Number(globex.rows[0].remaining_qty), 30, 'fremde Charge unangetastet');
  });
});

test('#152 setBatchCountPg: ohne Mandant wirft (fail-closed)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForDb(client);
    await assert.rejects(() => setBatchCountPg(db, '', 'b_acme', 10, null), /Mandant/i);
  });
});

test('#152 setBatchCountPg: OUT_OF_RANGE (mehr als initial_qty) ⇒ keine Änderung', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    const db = doorForDb(client);
    await assert.rejects(() => setBatchCountPg(db, 'acme', 'b_acme', 999, null), (e) => e.code === 'OUT_OF_RANGE');
    const acme = await client.query(`SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id='acme' AND batch_key='b_acme'`);
    assert.equal(Number(acme.rows[0].remaining_qty), 30, 'unverändert nach OUT_OF_RANGE');
  });
});
