'use strict';

/**
 * WF7 Nachfüllung — In-Process-Port (Issue #162, Stufe 6 Slice 2).
 * Ersetzt den `fetch(/webhook/nachfuellung)`-Trigger auf n8n-WF7 durch einen
 * direkten In-Process-Aufruf; der Schreibpfad (slot_assignments-Update,
 * warnings-resolve/-INSERT, stock_movement via pgw_write) läuft durch die
 * Mandanten-Tür (`db.tx`).
 *
 * Verhalten verhaltensgetreu abgeleitet aus der AUTHORITATIVEN Mini-WF7-
 * Definition (nicht dem stale/korrupten lokalen Export):
 *   - newQty = qty!=null ? min(qty, capacity) : capacity
 *   - resolvable Warnungstypen: EMPTY_BATCH, LOW_STOCK, INSUFFICIENT_BATCH_STOCK, LOW_BATCH
 *   - stock_movement (movement_type 'refill') nur bei delta>0 und vorhandener FIFO-Charge
 *
 * Ebene (1): reine Logik `computeRefillPlan` (kein DB) — hier.
 * Ebene (2): Live durch die Tür im Sandbox-Harness — siehe unten.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeRefillPlan, applyRefill } = require('../lib/refill-apply.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T10:00:00.000Z';

function baseSlot(over = {}) {
  return {
    product_slot_key: 'SLOT_457107528_12',
    machine_key: '457107528',
    product_key: 'kitkat',
    product_name: 'KitKat',
    current_machine_qty: 2,
    machine_capacity: 10,
    ...over,
  };
}

test('#162 compute: qty wird auf Kapazität gedeckelt; delta = newQty - current', () => {
  const plan = computeRefillPlan({
    slot: baseSlot({ current_machine_qty: 2, machine_capacity: 10 }),
    qty: 99, // über Kapazität
    batches: [],
    openWarnings: [],
    nowIso: NOW,
  });
  assert.equal(plan.slotUpdate.product_slot_key, 'SLOT_457107528_12');
  assert.equal(plan.slotUpdate.current_machine_qty, 10); // gedeckelt
  assert.equal(plan.summary.delta, 8); // 10 - 2
});

test('#162 compute: qty=null ⇒ auffüllen auf volle Kapazität', () => {
  const plan = computeRefillPlan({
    slot: baseSlot({ current_machine_qty: 3, machine_capacity: 8 }),
    qty: null,
    batches: [],
    openWarnings: [],
    nowIso: NOW,
  });
  assert.equal(plan.slotUpdate.current_machine_qty, 8);
});

test('#162 compute: stock_movement nur bei delta>0 + FIFO-Charge (älteste MHD zuerst)', () => {
  const plan = computeRefillPlan({
    slot: baseSlot({ current_machine_qty: 1, machine_capacity: 6 }),
    qty: 6,
    batches: [
      { batch_key: 'B_NEU', product_key: 'kitkat', remaining_qty: 50, mhd_date: '2027-01-01', status: 'aktiv' },
      { batch_key: 'B_ALT', product_key: 'kitkat', remaining_qty: 20, mhd_date: '2026-08-01', status: 'aktiv' },
    ],
    openWarnings: [],
    nowIso: NOW,
  });
  assert.ok(plan.stockMovement, 'stockMovement erwartet');
  assert.equal(plan.stockMovement.event_type, 'stock_movement');
  assert.equal(plan.stockMovement.batch_run_id, 'wf7_2026-06-09');
  assert.equal(plan.stockMovement.data.movement_type, 'refill');
  assert.equal(plan.stockMovement.data.quantity_delta_slot, 5); // 6 - 1
  assert.equal(plan.stockMovement.data.quantity_delta_total, 0); // Slot-Umbuchung, kein Gesamt-Delta
  assert.equal(plan.stockMovement.data.batch_key, 'B_ALT'); // FIFO: älteste MHD
  assert.equal(plan.stockMovement.data.product_slot_key, 'SLOT_457107528_12');
  assert.equal(plan.stockMovement.data.source, 'wf7_nachfuellung');
});

test('#162 compute: delta<=0 ⇒ kein stock_movement', () => {
  const plan = computeRefillPlan({
    slot: baseSlot({ current_machine_qty: 6, machine_capacity: 6 }),
    qty: 6, // bereits voll ⇒ delta 0
    batches: [{ batch_key: 'B1', product_key: 'kitkat', remaining_qty: 10, mhd_date: '2026-08-01', status: 'aktiv' }],
    openWarnings: [],
    nowIso: NOW,
  });
  assert.equal(plan.stockMovement, null);
  assert.equal(plan.summary.delta, 0);
});

test('#162 compute: delta>0 aber keine verfügbare Charge ⇒ kein stock_movement (Slot-Update trotzdem)', () => {
  const plan = computeRefillPlan({
    slot: baseSlot({ current_machine_qty: 1, machine_capacity: 6 }),
    qty: 6,
    batches: [{ batch_key: 'B1', product_key: 'kitkat', remaining_qty: 0, status: 'aktiv' }], // leer
    openWarnings: [],
    nowIso: NOW,
  });
  assert.equal(plan.stockMovement, null);
  assert.equal(plan.slotUpdate.current_machine_qty, 6);
});

test('#162 compute: nur resolvable Warnungstypen werden aufgelöst', () => {
  const plan = computeRefillPlan({
    slot: baseSlot(),
    qty: 5,
    batches: [],
    openWarnings: [
      { warning_key: 'W_EMPTY', warning_type: 'EMPTY_BATCH' },
      { warning_key: 'W_LOW', warning_type: 'LOW_STOCK' },
      { warning_key: 'W_MHD', warning_type: 'MHD_WARNING' }, // NICHT resolvable
    ],
    nowIso: NOW,
  });
  assert.deepEqual(plan.resolveWarningKeys.sort(), ['W_EMPTY', 'W_LOW']);
  assert.equal(plan.summary.hints_resolved, 2);
});

test('#162 compute: Audit-Warnung NACHFUELLUNG (resolved, severity info) mit Slot+Menge in der Message', () => {
  const plan = computeRefillPlan({
    slot: baseSlot({ current_machine_qty: 0, machine_capacity: 4 }),
    qty: 4,
    batches: [],
    openWarnings: [],
    notes: 'Tour Mo',
    nowIso: NOW,
  });
  assert.equal(plan.auditWarning.warning_type, 'NACHFUELLUNG');
  assert.equal(plan.auditWarning.severity, 'info');
  assert.equal(plan.auditWarning.resolved, true);
  assert.match(plan.auditWarning.message, /KitKat/);
  assert.match(plan.auditWarning.message, /SLOT_457107528_12=4/);
  assert.match(plan.auditWarning.message, /Tour Mo/);
});

// ── Ebene (2): Live durch die Tür im #94-Sandbox-Harness (acme/globex nicht-vakuös) ──
// Läuft gegen die echte DB als automatenlager_app; ohne DASHBOARD_V2_PG_URL ⇒ skip.
test('#162 applyRefill LIVE: Slot-Update + Warnung-resolve + stock_movement durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // Fixture-Ergänzung (RAW, vor RLS): Slot-Kapazität + eine resolvable Warnung je Mandant.
    for (const ten of [acme, globex]) {
      await client.query(
        `UPDATE automatenlager.slot_assignments SET machine_capacity = 20
           WHERE product_slot_key = $1 AND tenant_id = $2`,
        [ten.slotKey, ten.tenantId],
      );
      await client.query(
        `INSERT INTO automatenlager.warnings
           (warning_key, warning_type, message, source_workflow, product_id, machine_id, resolved, tenant_id)
         VALUES ($1, 'LOW_STOCK', 'niedrig', 'wf5', $2, $3, FALSE, $4)`,
        [`lowstock_${ten.tenantId}`, ten.productId, ten.machineId, ten.tenantId],
      );
    }
    // RLS scharf schalten (Stufe 5) — wie die Slice-1-Live-Tests.
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);

    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // Refill NUR für acme: mdb_code 10 (Seed), qty 15 (current 5 ⇒ delta 10), Charge b_acme vorhanden.
    const res = await applyRefill(db, 'acme', {
      machineKey: 'vm_acme', mdbCode: 10, productId: acme.productId, qty: 15, notes: 'Tour Mo', nowIso: NOW,
    });
    assert.equal(res.ok, true);
    assert.equal(res.slots_updated, 1);
    assert.equal(res.new_qty, 15);
    assert.equal(res.hints_resolved, 1, 'LOW_STOCK aufgelöst');
    assert.equal(res.stock_movement, true, 'stock_movement eingefügt');

    // acme: Slot aktualisiert
    const acmeSlot = await db.read({
      tenant: 'acme', tables: ['slot_assignments'],
      text: `SELECT current_machine_qty FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_acme'`,
    });
    assert.equal(Number(acmeSlot.rows[0].current_machine_qty), 15);

    // acme: stock_movement vorhanden (genau 1, movement_type 'refill', delta 10)
    const acmeMov = await db.read({
      tenant: 'acme', tables: ['stock_movements'],
      text: `SELECT movement_type, quantity_delta_slot, quantity_delta_total FROM automatenlager.stock_movements WHERE tenant_id = $1 AND source = 'wf7_nachfuellung'`,
    });
    assert.equal(acmeMov.rows.length, 1);
    assert.equal(acmeMov.rows[0].movement_type, 'refill');
    assert.equal(Number(acmeMov.rows[0].quantity_delta_slot), 10);
    assert.equal(Number(acmeMov.rows[0].quantity_delta_total), 0);

    // acme: LOW_STOCK resolved (Audit liegt im JSONL des Endpunkts, nicht in warnings)
    const acmeWarn = await db.read({
      tenant: 'acme', tables: ['warnings'],
      text: `SELECT resolved FROM automatenlager.warnings WHERE tenant_id = $1 AND warning_key = 'lowstock_acme'`,
    });
    assert.equal(acmeWarn.rows[0].resolved, true, 'LOW_STOCK resolved');

    // ISOLATION (nicht-vakuös): globex unverändert + sieht acme-Bewegung NICHT.
    const globexSlot = await db.read({
      tenant: 'globex', tables: ['slot_assignments'],
      text: `SELECT current_machine_qty FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_globex'`,
    });
    assert.equal(Number(globexSlot.rows[0].current_machine_qty), 5, 'globex-Slot unverändert');
    const globexMov = await db.read({
      tenant: 'globex', tables: ['stock_movements'],
      text: `SELECT count(*)::int AS n FROM automatenlager.stock_movements WHERE tenant_id = $1 AND source = 'wf7_nachfuellung'`,
    });
    assert.equal(globexMov.rows[0].n, 0, 'globex sieht keine acme-Bewegung (RLS)');
    const globexLow = await db.read({
      tenant: 'globex', tables: ['warnings'],
      text: `SELECT resolved FROM automatenlager.warnings WHERE tenant_id = $1 AND warning_key = 'lowstock_globex'`,
    });
    assert.equal(globexLow.rows[0].resolved, false, 'globex-Warnung NICHT aufgelöst');
  });
});

test('#162 applyRefill LIVE: unbekannter Slot ⇒ SLOT_NOT_FOUND, kein Schreibzugriff', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    const res = await applyRefill(db, 'acme', {
      machineKey: 'vm_acme', mdbCode: 999, productId: acme.productId, qty: 5, nowIso: NOW,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SLOT_NOT_FOUND');
  });
});
