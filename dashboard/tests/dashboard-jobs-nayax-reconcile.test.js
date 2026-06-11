'use strict';

/**
 * WF3 Nachbuch-Reconciliation (Issue #221) — unvollständig gelieferte Nayax-Verkäufe
 * periodisch neu holen & re-buchen.
 *
 * Befund (Prod-DB, 2026-06-11): sales_transactions trägt problematische Zeilen mit
 * gross_amount = 0 (INSUFFICIENT_BATCH_STOCK, SKIPPED_BEFORE_CUTOVER, OK-aber-0).
 * Dieser Job definiert „nachbuchungsbedürftig", holt die Preise erneut von Nayax
 * (lastSales, Mapping wie Live-Import), bucht FIFO nach sobald Bestand da ist,
 * lässt nicht-auflösbare Zeilen ehrlich pending (kein stilles Schlucken) und
 * auditiert jede Korrektur (alt/neu) — alles durch die Mandanten-Tür.
 *
 * Ebenen: (1) reine Logik isReconcilable/computeReconcilePlan; (2) I/O durch die
 * Tür applyNayaxReconcile + readReconcileBacklog (acme/globex-Isolation, Sandbox).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const rec = require('../lib/jobs/nayax-reconcile.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const CONFIG = { default_quantity_per_sale: 1 };
const NOW = '2026-06-11T08:00:00.000Z';

// Die für den Reconcile nötigen Migrationen (RLS/Tür + Audit-Tabelle 0036).
const RECONCILE_MIGRATIONS = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 36];

// Eine problematische sales_transactions-Zeile (gross=0) für einen Mandanten anlegen.
async function seedProblemSale(client, ten, { txId, status = 'INSUFFICIENT_BATCH_STOCK', qty = 2 } = {}) {
  await client.query(
    `INSERT INTO automatenlager.sales_transactions
       (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
        gross_amount, net_amount, vat_amount, settlement_at, processing_status, source, tenant_id)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 0, '2026-05-15T10:00:00Z', $6, 'nayax_lastSales', $7)`,
    [txId, ten.machineId, ten.productId, ten.productName, qty, status, ten.tenantId],
  );
}

// Eine Backlog-Zeile in der Form, die reconcileBacklogSql liefert (gross<=0).
function backlogRow(extra = {}) {
  return {
    nayax_transaction_id: 'T1',
    machine_key: '457107528',
    product_key: 'SKU_KITKAT',
    product_slot_key: 'PS_457107528_12_KITKAT_1',
    quantity: 2,
    gross_amount: 0,
    processing_status: 'INSUFFICIENT_BATCH_STOCK',
    settlement_at: '2026-05-15T10:00:00.000Z',
    ...extra,
  };
}

// Ein frischer Nayax-Verkauf (lastSales), wie er den vollständigen Preis trägt.
function freshSale(extra = {}) {
  return {
    TransactionID: 'T1',
    MachineID: '457107528',
    ProductName: 'KitKat (12 = 1.50)',
    SettlementValue: 1.5,
    SettlementDateTimeGMT: '2026-05-15T10:00:00.000Z',
    MultivendNumberOfProducts: 0,
    ...extra,
  };
}

function batches(extra = []) {
  return [
    { batch_id: 'B1', product_key: 'SKU_KITKAT', remaining_qty: 10, mhd: '2026-07-01', status: 'aktiv' },
    ...extra,
  ];
}

// ── Ebene 1: isReconcilable (AC1 — „nachbuchungsbedürftig" sauber definiert) ──────
test('#221 isReconcilable: gross=0 + INSUFFICIENT_BATCH_STOCK ist nachbuchungsbedürftig', () => {
  assert.equal(rec.isReconcilable({ gross_amount: 0, processing_status: 'INSUFFICIENT_BATCH_STOCK' }), true);
});

test('#221 isReconcilable: gross=NULL + OK (Preis fehlte beim Import) ist nachbuchungsbedürftig', () => {
  assert.equal(rec.isReconcilable({ gross_amount: null, processing_status: 'OK' }), true);
});

test('#221 isReconcilable: SKIPPED_BEFORE_CUTOVER wird NICHT automatisch verbucht (Vor-Inventur)', () => {
  assert.equal(rec.isReconcilable({ gross_amount: 0, processing_status: 'SKIPPED_BEFORE_CUTOVER' }), false);
});

test('#221 isReconcilable: Zeile mit gültigem Preis (gross>0) ist nicht nachbuchungsbedürftig', () => {
  assert.equal(rec.isReconcilable({ gross_amount: 1.5, processing_status: 'OK' }), false);
});

// ── Ebene 1: computeReconcilePlan ────────────────────────────────────────────────
test('#221 computeReconcilePlan: Preis aus Nayax + genug Bestand ⇒ Korrektur (Status OK, gross=qty*Preis, FIFO-Abbuchung)', () => {
  const plan = rec.computeReconcilePlan({
    backlog: [backlogRow({ quantity: 2 })],
    freshSales: [freshSale({ SettlementValue: 1.5 })],
    batches: batches(),
    config: CONFIG,
    nowIso: '2026-06-11T08:00:00.000Z',
  });
  assert.equal(plan.corrections.length, 1);
  assert.equal(plan.pending.length, 0);
  const c = plan.corrections[0];
  assert.equal(c.nayax_transaction_id, 'T1');
  assert.equal(c.old.gross, 0);
  assert.equal(c.old.status, 'INSUFFICIENT_BATCH_STOCK');
  assert.equal(c.new.status, 'OK');
  assert.equal(c.new.gross, 3.0); // 2 * 1.50
  assert.equal(c.new.net, 3.0);   // wie Live-Import: net = gross, vat = 0
  assert.deepEqual(c.deductedBatches, ['B1']);
  // Genau ein stock_movement mit Delta -2 auf B1, idempotenter Schlüssel je Transaktion.
  assert.equal(plan.stockMovements.length, 1);
  assert.equal(plan.stockMovements[0].batch_key, 'B1');
  assert.equal(plan.stockMovements[0].quantity_delta_total, -2);
  assert.match(plan.stockMovements[0].movement_key, /T1/);
});

test('#221 computeReconcilePlan: Preis da, aber zu wenig Bestand ⇒ pending INSUFFICIENT_BATCH_STOCK (erneut markiert, kein Schlucken)', () => {
  const plan = rec.computeReconcilePlan({
    backlog: [backlogRow({ quantity: 5 })],
    freshSales: [freshSale({ SettlementValue: 1.5 })],
    batches: [{ batch_id: 'B1', product_key: 'SKU_KITKAT', remaining_qty: 2, mhd: '2026-07-01', status: 'aktiv' }],
    config: CONFIG,
    nowIso: '2026-06-11T08:00:00.000Z',
  });
  assert.equal(plan.corrections.length, 0);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].nayax_transaction_id, 'T1');
  assert.equal(plan.pending[0].reason, 'INSUFFICIENT_BATCH_STOCK');
  assert.equal(plan.stockMovements.length, 0); // keine Teil-Abbuchung
});

test('#221 computeReconcilePlan: keine passende Nayax-Transaktion im Fenster ⇒ pending NO_NAYAX_MATCH (historisch, ehrlich)', () => {
  const plan = rec.computeReconcilePlan({
    backlog: [backlogRow({ nayax_transaction_id: 'T_HISTORIC' })],
    freshSales: [freshSale({ TransactionID: 'T1' })],
    batches: batches(),
    config: CONFIG,
  });
  assert.equal(plan.corrections.length, 0);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].nayax_transaction_id, 'T_HISTORIC');
  assert.equal(plan.pending[0].reason, 'NO_NAYAX_MATCH');
});

test('#221 computeReconcilePlan: frischer Verkauf ohne/0 Preis ⇒ pending NO_PRICE (keine 0-Buchung)', () => {
  const plan = rec.computeReconcilePlan({
    backlog: [backlogRow()],
    freshSales: [freshSale({ SettlementValue: 0 })],
    batches: batches(),
    config: CONFIG,
  });
  assert.equal(plan.corrections.length, 0);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].reason, 'NO_PRICE');
});

test('#221 computeReconcilePlan: leerer Backlog ⇒ nichts zu tun (vakuumfrei)', () => {
  const plan = rec.computeReconcilePlan({ backlog: [], freshSales: [freshSale()], batches: batches(), config: CONFIG });
  assert.equal(plan.corrections.length, 0);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.stockMovements.length, 0);
});

// ── Ebene 2: applyNayaxReconcile LIVE durch die Tür (Sandbox, acme/globex) ────────
function liveFresh(ten, txId, extra = {}) {
  return {
    TransactionID: txId, MachineID: `vm_${ten.tenantId}`, ProductName: ten.productName,
    SettlementValue: 1.0, SettlementDateTimeGMT: '2026-05-15T10:00:00.000Z', ...extra,
  };
}

test('#221 applyNayaxReconcile LIVE: bucht gross=0-Zeile nach (Status OK, gross gesetzt, FIFO via Trigger), auditiert; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    for (const ten of [acme, globex]) {
      await client.query(`UPDATE automatenlager.stock_batches SET mhd_date = '2027-06-01' WHERE batch_key = $1 AND tenant_id = $2`, [`b_${ten.tenantId}`, ten.tenantId]);
    }
    for (const n of RECONCILE_MIGRATIONS) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // Problematische Zeilen für BEIDE Mandanten (Isolation nicht-vakuös).
    await seedProblemSale(client, acme, { txId: 'REC_acme', qty: 2 });
    await seedProblemSale(client, globex, { txId: 'REC_globex', qty: 2 });

    const res = await rec.applyNayaxReconcile(db, 'acme', {
      freshSales: [liveFresh(acme, 'REC_acme', { SettlementValue: 1.5 })], config: CONFIG, nowIso: NOW, runId: 'run_test',
    });
    assert.equal(res.correctedCount, 1, 'eine Zeile nachgebucht');
    assert.equal(res.pendingCount, 0);

    // Zeile korrigiert: gross 0 → 3.0, Status OK.
    const sale = await db.read({
      tenant: 'acme', tables: ['sales_transactions'],
      text: `SELECT gross_amount, net_amount, processing_status FROM automatenlager.sales_transactions WHERE tenant_id = $1 AND nayax_transaction_id = 'REC_acme'`,
    });
    assert.equal(Number(sale.rows[0].gross_amount), 3.0);
    assert.equal(Number(sale.rows[0].net_amount), 3.0);
    assert.equal(sale.rows[0].processing_status, 'OK');

    // FIFO-Abbuchung über den Trigger: b_acme 30 → 28 (qty 2).
    const batch = await db.read({
      tenant: 'acme', tables: ['stock_batches'],
      text: `SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id = $1 AND batch_key = 'b_acme'`,
    });
    assert.equal(Number(batch.rows[0].remaining_qty), 28, 'remaining_qty vom Trigger dekrementiert');

    // Audit (alt/neu) geschrieben.
    const audit = await client.query(
      `SELECT old_gross, new_gross, old_status, new_status, reconcile_run_id FROM audit.sales_reconciliation_log WHERE tenant_id = 'acme' AND nayax_transaction_id = 'REC_acme'`);
    assert.equal(audit.rows.length, 1, 'genau ein Audit-Eintrag');
    assert.equal(Number(audit.rows[0].old_gross), 0);
    assert.equal(Number(audit.rows[0].new_gross), 3.0);
    assert.equal(audit.rows[0].old_status, 'INSUFFICIENT_BATCH_STOCK');
    assert.equal(audit.rows[0].new_status, 'OK');
    assert.equal(audit.rows[0].reconcile_run_id, 'run_test');

    // ISOLATION: globex unangetastet.
    const gSale = await db.read({
      tenant: 'globex', tables: ['sales_transactions'],
      text: `SELECT gross_amount, processing_status FROM automatenlager.sales_transactions WHERE tenant_id = $1 AND nayax_transaction_id = 'REC_globex'`,
    });
    assert.equal(Number(gSale.rows[0].gross_amount), 0, 'globex-Zeile nicht nachgebucht');
    assert.equal(gSale.rows[0].processing_status, 'INSUFFICIENT_BATCH_STOCK');
    const gBatch = await db.read({
      tenant: 'globex', tables: ['stock_batches'],
      text: `SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id = $1 AND batch_key = 'b_globex'`,
    });
    assert.equal(Number(gBatch.rows[0].remaining_qty), 30, 'globex-Charge unverändert');
  });
});

test('#221 applyNayaxReconcile: idempotent — zweiter Lauf ist ein No-Op (kein Doppel-Dekrement, kein zweiter Audit-Eintrag)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await client.query(`UPDATE automatenlager.stock_batches SET mhd_date = '2027-06-01' WHERE batch_key = 'b_acme' AND tenant_id = 'acme'`);
    for (const n of RECONCILE_MIGRATIONS) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    await seedProblemSale(client, acme, { txId: 'REC_acme', qty: 2 });

    const fresh = [liveFresh(acme, 'REC_acme', { SettlementValue: 1.5 })];
    const r1 = await rec.applyNayaxReconcile(db, 'acme', { freshSales: fresh, config: CONFIG, nowIso: NOW, runId: 'run1' });
    assert.equal(r1.correctedCount, 1);
    const r2 = await rec.applyNayaxReconcile(db, 'acme', { freshSales: fresh, config: CONFIG, nowIso: NOW, runId: 'run2' });
    assert.equal(r2.correctedCount, 0, 'zweiter Lauf korrigiert nichts mehr');

    const batch = await db.read({
      tenant: 'acme', tables: ['stock_batches'],
      text: `SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id = $1 AND batch_key = 'b_acme'`,
    });
    assert.equal(Number(batch.rows[0].remaining_qty), 28, 'kein Doppel-Dekrement (nicht 26)');
    const audit = await client.query(`SELECT count(*)::int AS n FROM audit.sales_reconciliation_log WHERE tenant_id = 'acme' AND nayax_transaction_id = 'REC_acme'`);
    assert.equal(audit.rows[0].n, 1, 'kein zweiter Audit-Eintrag');
  });
});

test('#221 applyNayaxReconcile: ohne passende Nayax-Transaktion bleibt die Zeile unangetastet (pending, kein stilles Schlucken)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of RECONCILE_MIGRATIONS) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    await seedProblemSale(client, acme, { txId: 'REC_historic', qty: 1 });

    const res = await rec.applyNayaxReconcile(db, 'acme', { freshSales: [], config: CONFIG, nowIso: NOW, runId: 'run_x' });
    assert.equal(res.correctedCount, 0);
    assert.equal(res.pendingCount, 1);
    assert.equal(res.pending[0].reason, 'NO_NAYAX_MATCH');

    const sale = await db.read({
      tenant: 'acme', tables: ['sales_transactions'],
      text: `SELECT gross_amount, processing_status FROM automatenlager.sales_transactions WHERE tenant_id = $1 AND nayax_transaction_id = 'REC_historic'`,
    });
    assert.equal(Number(sale.rows[0].gross_amount), 0, 'Zeile bleibt unverändert (pending)');
  });
});

test('#221 readReconcileBacklog: zählt nachbuchungsbedürftige Zeilen, SKIPPED_BEFORE_CUTOVER separat (Arbeitsvorrat)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of RECONCILE_MIGRATIONS) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    await seedProblemSale(client, acme, { txId: 'B_insuff', status: 'INSUFFICIENT_BATCH_STOCK' });
    await seedProblemSale(client, acme, { txId: 'B_ok0', status: 'OK' });
    await seedProblemSale(client, acme, { txId: 'B_skip', status: 'SKIPPED_BEFORE_CUTOVER' });

    const backlog = await rec.readReconcileBacklog(db, 'acme');
    assert.equal(backlog.reconcilable, 2, 'INSUFFICIENT + OK-0 sind nachbuchungsbedürftig');
    assert.equal(backlog.skippedBeforeCutover, 1, 'SKIPPED separat ausgewiesen');
  });
});

// ── Worker-Factory ───────────────────────────────────────────────────────────────
test('#221 createNayaxReconcileJob: ohne NAYAX_API_TOKEN wird sauber übersprungen', async () => {
  const job = rec.createNayaxReconcileJob({ db: { tx() {}, read() {} }, env: {} });
  assert.equal(job.key, 'wf3-nayax-reconcile');
  const out = await job.run();
  assert.match(out.skipped, /NAYAX_API_TOKEN/);
});

test('#221 createNayaxReconcileJob: holt lastSales (Mock) und bucht den Backlog des Mandanten nach', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await client.query(`UPDATE automatenlager.stock_batches SET mhd_date = '2027-06-01' WHERE batch_key = 'b_acme' AND tenant_id = 'acme'`);
    for (const n of RECONCILE_MIGRATIONS) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    await seedProblemSale(client, acme, { txId: 'REC_acme', qty: 2 });

    const fetchImpl = async () => ({ ok: true, json: async () => [liveFresh(acme, 'REC_acme', { SettlementValue: 2.0 })] });
    const env = { NAYAX_API_TOKEN: 'TOK', NAYAX_TENANT_ID: 'acme', NAYAX_MACHINE_ID: 'vm_acme' };
    const job = rec.createNayaxReconcileJob({ db, env, fetchImpl });
    const out = await job.run();

    assert.equal(out.tenant, 'acme');
    assert.equal(out.fetched, 1);
    assert.equal(out.correctedCount, 1);
    assert.equal(out.backlog.reconcilable, 0, 'Backlog nach Nachbuchung leer');

    const sale = await db.read({
      tenant: 'acme', tables: ['sales_transactions'],
      text: `SELECT gross_amount, processing_status FROM automatenlager.sales_transactions WHERE tenant_id = $1 AND nayax_transaction_id = 'REC_acme'`,
    });
    assert.equal(Number(sale.rows[0].gross_amount), 4.0); // 2 * 2.00
    assert.equal(sale.rows[0].processing_status, 'OK');
  });
});
