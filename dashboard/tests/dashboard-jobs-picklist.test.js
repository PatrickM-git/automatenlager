'use strict';

/**
 * WF9 Pickliste — In-Process-Port (Issue #162, Stufe 6 Slice 2).
 * Drive→Claude-OCR→Slot-Verteilung→Warnungen→stock_movement. Im Kern wie WF7,
 * aber mehrere Produkte aus einer OCR'ten PDF, Match über nayax_product_name,
 * Backstock-begrenzte Verteilung über Slots, Movement-Typ 'pick' (delta_total = -delta).
 * Verhaltensgetreu aus der authoritativen Mini-WF9-Definition.
 *
 * Ebenen: (1) reine Logik parsePicklistItems/computePickPlan/buildPicklistOcrRequest;
 * (2) Live applyPicklist durch die Tür (acme/globex); (3) processPicklistFile mit Fakes.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const pl = require('../lib/jobs/picklist.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T08:00:00.000Z';

// ── Ebene 1: parsePicklistItems ──────────────────────────────────────────────
test('#162 parsePicklistItems: strippt ```json-Fences und parst das Array', () => {
  const resp = { content: [{ text: '```json\n[{"name":"KitKat","pick":5}]\n```' }] };
  assert.deepEqual(pl.parsePicklistItems(resp), [{ name: 'KitKat', pick: 5 }]);
});

test('#162 parsePicklistItems: kein JSON / kein Array ⇒ wirft', () => {
  assert.throws(() => pl.parsePicklistItems({ content: [{ text: 'kein json' }] }), /JSON/);
  assert.throws(() => pl.parsePicklistItems({ content: [{ text: '{"x":1}' }] }), /Array/);
});

// ── Ebene 1: buildPicklistOcrRequest ─────────────────────────────────────────
test('#162 buildPicklistOcrRequest: Document-Block + Modell + Extraktions-Prompt', () => {
  const body = pl.buildPicklistOcrRequest('BASE64PDF', 'application/pdf');
  assert.ok(body.model, 'Modell gesetzt');
  const block = body.messages[0].content.find((c) => c.type === 'document');
  assert.ok(block, 'document-Block vorhanden');
  assert.equal(block.source.data, 'BASE64PDF');
  assert.equal(block.source.media_type, 'application/pdf');
});

// ── Ebene 1: computePickPlan ─────────────────────────────────────────────────
const PRODUCTS = [
  { nayax_product_name: 'KitKat', product_key: 'kitkat', product_id: 1, product_slot_id: 'S1', current_machine_qty: 2, machine_capacity: 10 },
  { nayax_product_name: 'Cola', product_key: 'cola', product_id: 2, product_slot_id: 'S2', current_machine_qty: 0, machine_capacity: 4 },
];
const BATCHES = [
  { product_key: 'kitkat', batch_id: 'BK', remaining_qty: 50, status: 'aktiv', mhd: '2027-01-01' },
  { product_key: 'cola', batch_id: 'BC', remaining_qty: 3, status: 'aktiv', mhd: '2027-01-01' },
];

test('#162 computePickPlan: füllt Slot bis Kapazität, delta + pick-Movement (delta_total negativ)', () => {
  const plan = pl.computePickPlan({ items: [{ name: 'KitKat', pick: 5 }], products: PRODUCTS, batches: BATCHES, nowIso: NOW });
  assert.equal(plan.slotUpdates.length, 1);
  assert.equal(plan.slotUpdates[0].product_slot_key, 'S1');
  assert.equal(plan.slotUpdates[0].current_machine_qty, 7); // 2 + 5
  const mv = plan.stockMovements[0];
  assert.equal(mv.data.movement_type, 'pick');
  assert.equal(mv.data.quantity_delta_slot, 5);
  assert.equal(mv.data.quantity_delta_total, -5); // Pick reduziert Gesamtbestand
  assert.equal(mv.data.batch_key, 'BK');
});

test('#162 computePickPlan: durch Backstock begrenzt (Cola: nur 3 verfügbar, Slot leer)', () => {
  const plan = pl.computePickPlan({ items: [{ name: 'Cola', pick: 10 }], products: PRODUCTS, batches: BATCHES, nowIso: NOW });
  // availableFill = totalRemaining(3) - currentInMachine(0) = 3 ⇒ effective 3
  assert.equal(plan.slotUpdates[0].current_machine_qty, 3);
  assert.equal(plan.stockMovements[0].data.quantity_delta_slot, 3);
});

test('#162 computePickPlan: unbekannter Name ⇒ notFound, kein Slot-Update', () => {
  const plan = pl.computePickPlan({ items: [{ name: 'Unbekannt', pick: 2 }], products: PRODUCTS, batches: BATCHES, nowIso: NOW });
  assert.deepEqual(plan.notFound, ['Unbekannt']);
  assert.equal(plan.slotUpdates.length, 0);
});

// ── Ebene 3: processPicklistFile mit Fakes ───────────────────────────────────
test('#162 processPicklistFile: Drive download → OCR → apply → Drive move', async () => {
  const calls = { downloaded: null, moved: null };
  const drive = {
    download: async (fileId) => { calls.downloaded = fileId; return { base64: 'PDFB64', mimeType: 'application/pdf' }; },
    move: async (fileId) => { calls.moved = fileId; },
  };
  const anthropic = { createMessage: async () => ({ content: [{ text: '[{"name":"KitKat","pick":1}]' }] }) };
  let applied = null;
  const fakeDb = { _apply: async (items) => { applied = items; return { slots_updated: 1, movements: 1, not_found: [] }; } };
  const res = await pl.processPicklistFile(fakeDb, 'acme', {
    fileId: 'F1', fileName: 'pick.pdf', drive, anthropic, nowIso: NOW,
    applyImpl: (db, tenant, opts) => fakeDb._apply(opts.items),
  });
  assert.equal(calls.downloaded, 'F1');
  assert.equal(calls.moved, 'F1', 'Datei nach Erfolg verschoben (Idempotenz)');
  assert.deepEqual(applied, [{ name: 'KitKat', pick: 1 }]);
  assert.equal(res.ok, true);
});

// ── Ebene 2: Live applyPicklist durch die Tür ────────────────────────────────
test('#162 applyPicklist LIVE: Slot-Update + pick-Movement durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // Slot-Kapazität + Nayax-Name (Match-Schlüssel) für beide Mandanten setzen.
    for (const ten of [acme, globex]) {
      await client.query(
        `UPDATE automatenlager.slot_assignments SET machine_capacity = 20 WHERE product_slot_key = $1 AND tenant_id = $2`,
        [ten.slotKey, ten.tenantId],
      );
      // product_aliases: nayax-Primäralias = 'PickName <tid>' (Match über nayax_product_name)
      await client.query(
        `INSERT INTO automatenlager.product_aliases (product_id, alias, source, is_primary, tenant_id)
         VALUES ($1, $2, 'nayax', TRUE, $3)`,
        [ten.productId, `PickName ${ten.tenantId}`, ten.tenantId],
      );
    }
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // Seed-Slot acme: current 5, capacity 20, Charge b_acme remaining 30 ⇒ availableFill 25; pick 8 ⇒ +8 = 13
    const res = await pl.applyPicklist(db, 'acme', { items: [{ name: 'PickName acme', pick: 8 }], fileName: 'pick.pdf', nowIso: NOW });
    assert.equal(res.slots_updated, 1);
    assert.equal(res.movements, 1);

    const acmeSlot = await db.read({
      tenant: 'acme', tables: ['slot_assignments'],
      text: `SELECT current_machine_qty FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_acme'`,
    });
    assert.equal(Number(acmeSlot.rows[0].current_machine_qty), 13);

    const acmeMov = await db.read({
      tenant: 'acme', tables: ['stock_movements'],
      text: `SELECT movement_type, quantity_delta_slot, quantity_delta_total FROM automatenlager.stock_movements WHERE tenant_id = $1 AND source = 'wf9_pickliste'`,
    });
    assert.equal(acmeMov.rows.length, 1);
    assert.equal(acmeMov.rows[0].movement_type, 'pick');
    assert.equal(Number(acmeMov.rows[0].quantity_delta_slot), 8);
    assert.equal(Number(acmeMov.rows[0].quantity_delta_total), -8);

    // ISOLATION: globex-Slot unverändert, keine Pick-Bewegung
    const globexMov = await db.read({
      tenant: 'globex', tables: ['stock_movements'],
      text: `SELECT count(*)::int AS n FROM automatenlager.stock_movements WHERE tenant_id = $1 AND source = 'wf9_pickliste'`,
    });
    assert.equal(globexMov.rows[0].n, 0, 'globex: keine Pick-Bewegung');
  });
});

test('#162 createPicklistPollJob: ohne drive ⇒ disabled (kein Throw)', () => {
  const job = pl.createPicklistPollJob({ tenantRunner: { runForAll: async () => ({}) }, drive: null, anthropic: null });
  assert.equal(job.disabled, true);
});
