'use strict';

// Issue #99 — Migration 0012 (fachliche Schluessel mandanten-eindeutig, ADDITIV).
// LIVE-Sandbox mit ROLLBACK.
//
// REVIDIERT: 0012 legt die (tenant_id, key)-Uniques ADDITIV neben die bestehenden
// (key)-Uniques. Die alten BLEIBEN, damit der laufende Schreibpfad (ON CONFLICT
// (key)) nicht bricht (Story 23). Daher: KEIN "gleicher key bei zwei Mandanten"-
// Test (der alte globale Unique blockt das im Single-Tenant noch) — das wird erst
// in Stufe 6 scharf. Stattdessen: beide Uniques existieren nebeneinander.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

async function setup(client) {
  for (const n of [7, 8, 9, 10, 11, 12]) await applyMigration(client, n);
}
async function constraintExists(client, name) {
  const r = await client.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=$1`, [name]);
  return r.rows[0] ? r.rows[0].d : null;
}

test('#99 LIVE-Sandbox: (tenant_id, key)-Uniques existieren ADDITIV', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    const expected = {
      products_tenant_uk: /UNIQUE \(tenant_id, product_key\)/,
      stock_batches_tenant_uk: /UNIQUE \(tenant_id, batch_key\)/,
      suppliers_tenant_uk: /UNIQUE \(tenant_id, supplier_key\)/,
      warnings_tenant_uk: /UNIQUE \(tenant_id, warning_key\)/,
      product_change_proposals_tenant_uk: /UNIQUE \(tenant_id, proposal_key\)/,
      product_aliases_tenant_uk: /UNIQUE \(tenant_id, alias, source\)/,
      invoices_tenant_uk: /UNIQUE \(tenant_id, invoice_key\)/,
      invoice_items_tenant_uk: /UNIQUE \(tenant_id, invoice_id, line_number\)/,
      guv_daily_tenant_uk: /UNIQUE \(tenant_id, guv_key\)/,
      stock_movements_tenant_uk: /UNIQUE \(tenant_id, movement_key\)/,
      workflow_state_tenant_uk: /UNIQUE \(tenant_id, workflow_key\)/,
    };
    for (const [name, re] of Object.entries(expected)) {
      const def = await constraintExists(client, name);
      assert.ok(def, `${name} existiert`);
      assert.match(def, re, `${name} ist tenant-fuehrend`);
    }
    // slot_assignments: partieller aktiver Unique-Index tenant-fuehrend (additiv).
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='automatenlager' AND indexname='idx_slot_active_tenant'`);
    assert.equal(idx.rowCount, 1, 'idx_slot_active_tenant existiert');
    assert.match(idx.rows[0].indexdef, /tenant_id, machine_id, mdb_code/);
  });
});

test('#99 LIVE-Sandbox: alte globale (key)-Uniques BLEIBEN erhalten (Story 23)', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Diese muessen weiter existieren, damit ON CONFLICT (key) im n8n-Schreibpfad greift.
    for (const name of ['products_product_key_key', 'stock_batches_batch_key_key',
      'suppliers_supplier_key_key', 'warnings_warning_key_key', 'invoices_invoice_key_key',
      'guv_daily_guv_key_key', 'stock_movements_movement_key_key',
      'product_change_proposals_proposal_key_key', 'product_aliases_alias_source_key',
      'invoice_items_invoice_id_line_number_key']) {
      const r = await client.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [name]);
      assert.equal(r.rowCount, 1, `alter Unique ${name} bleibt erhalten`);
    }
    // slot_assignments + workflow_state behalten ihre alten Constraints.
    const slot = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname='idx_slot_active'`);
    assert.equal(slot.rowCount, 1, 'idx_slot_active bleibt');
    // workflow_state-PK ist nach Migration 0031 (auf der Mini-DB deployt) bereits
    // auf (tenant_id, workflow_key) umgestellt — tenant-fuehrend ist korrekt.
    const wfpk = await constraintExists(client, 'workflow_state_pkey');
    assert.ok(wfpk && /PRIMARY KEY/.test(wfpk), 'workflow_state-PK existiert');
  });
});

test('#99 LIVE-Sandbox: Migration idempotent', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    await applyMigration(client, 12);
    const def = await constraintExists(client, 'products_tenant_uk');
    assert.match(def, /UNIQUE \(tenant_id, product_key\)/);
  });
});
