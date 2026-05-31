'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');

const { buildBulkRefillPlan } = require('../lib/bulk-refill.js');

/* ---- Fixtures ------------------------------------------------------------ */
/* Ein Automat mit gemischten Slots; available_backstock = verfügbarer Lager-
   bestand des Produkts (pro Produkt identisch, egal in wie vielen Slots). */
const SLOTS = [
  { machine_id: 'M1', mdb_code: 11, product_id: 100, product_name: 'Cola',  current_machine_qty: 2,  capacity: 10, free_capacity: 8, available_backstock: 5 },
  { machine_id: 'M1', mdb_code: 12, product_id: 200, product_name: 'Water', current_machine_qty: 8,  capacity: 10, free_capacity: 2, available_backstock: 10 },
  { machine_id: 'M1', mdb_code: 13, product_id: 100, product_name: 'Cola',  current_machine_qty: 0,  capacity: 6,  free_capacity: 6, available_backstock: 5 },
  { machine_id: 'M1', mdb_code: 14, product_id: 0,   product_name: '',      current_machine_qty: 0,  capacity: 8,  free_capacity: 8, available_backstock: 0 },
  { machine_id: 'M1', mdb_code: 15, product_id: 300, product_name: 'Bar',   current_machine_qty: 10, capacity: 10, free_capacity: 0, available_backstock: 4 },
];

function bySlot(plan, mdb) { return plan.slots.find((s) => s.mdb_code === mdb); }

/* ---- AC-BR1: Auffüllen Richtung Kapazität -------------------------------- */
test('AC-BR1: a slot is filled toward its free capacity when stock allows', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  assert.equal(bySlot(plan, 12).refill_qty, 2);      // Water: 2 frei, 10 Lager -> 2
  assert.equal(bySlot(plan, 12).capped_by_stock, false);
});

/* ---- AC-BR2: NIE mehr als der verfügbare Lagerbestand -------------------- */
test('AC-BR2: refill never exceeds the available warehouse stock of a product', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  // Cola Slot 11 will 8, aber nur 5 im Lager -> 5, als begrenzt markiert
  assert.equal(bySlot(plan, 11).refill_qty, 5);
  assert.equal(bySlot(plan, 11).capped_by_stock, true);
});

/* ---- AC-BR3: geteilter Lagerbestand wird über Slots aufgeteilt ----------- */
test('AC-BR3: shared product stock is split across slots, never double-counted', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  // Slot 11 verbraucht die 5 Cola; Slot 13 (auch Cola) bekommt nichts mehr
  assert.equal(bySlot(plan, 13).refill_qty, 0);
  assert.equal(bySlot(plan, 13).capped_by_stock, true);
  // Summe Cola-Auffüllung == verfügbarer Lagerbestand, nicht mehr
  const colaTotal = bySlot(plan, 11).refill_qty + bySlot(plan, 13).refill_qty;
  assert.equal(colaTotal, 5);
});

/* ---- AC-BR4: bereits voller Slot bekommt 0 ------------------------------- */
test('AC-BR4: an already-full slot is not refilled', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  assert.equal(bySlot(plan, 15).refill_qty, 0);
  assert.equal(bySlot(plan, 15).capped_by_stock, false);
});

/* ---- AC-BR5: leerer Slot (kein Produkt) wird übersprungen ---------------- */
test('AC-BR5: an empty slot without a product is skipped', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  assert.equal(bySlot(plan, 14).refill_qty, 0);
});

/* ---- AC-BR6: Summen-Kennzahlen ------------------------------------------- */
test('AC-BR6: plan summary reports total quantity and planned slot count', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  assert.equal(plan.totalRefill, 7);     // 5 Cola + 2 Water
  assert.equal(plan.slotsPlanned, 2);    // Slot 11 und 12
  assert.equal(plan.cappedCount, 2);     // Slot 11 und 13 begrenzt
});

/* ---- AC-BR7: Aufschlüsselung je Produkt (angefragt vs. zugeteilt) -------- */
test('AC-BR7: byProduct shows requested vs allocated vs available with short flag', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  const cola = plan.byProduct.find((p) => p.product_id === 100);
  assert.equal(cola.requested, 14);   // 8 + 6
  assert.equal(cola.allocated, 5);
  assert.equal(cola.available, 5);
  assert.equal(cola.short, true);
  const water = plan.byProduct.find((p) => p.product_id === 200);
  assert.equal(water.allocated, 2);
  assert.equal(water.short, false);
});

/* ---- AC-BR8: Plan-Parameter sind die des bestehenden Refill-Vorgangs ----- */
test('AC-BR8: planned slots carry the existing refill trigger params', () => {
  const plan = buildBulkRefillPlan(SLOTS);
  const s11 = bySlot(plan, 11);
  assert.equal(s11.machine_id, 'M1');
  assert.equal(s11.mdb_code, 11);
  assert.equal(s11.product_id, 100);
  assert.equal(s11.qty, 5);   // qty == refill_qty, bereit für /api/v2/refill/trigger
});

/* ---- AC-BR9: Robust bei leerer Eingabe ----------------------------------- */
test('AC-BR9: buildBulkRefillPlan handles empty input', () => {
  const plan = buildBulkRefillPlan([]);
  assert.equal(plan.totalRefill, 0);
  assert.equal(plan.slotsPlanned, 0);
  assert.deepEqual(plan.slots, []);
  assert.deepEqual(plan.byProduct, []);
});

test('AC-BR9b: missing argument does not throw', () => {
  const plan = buildBulkRefillPlan(undefined);
  assert.equal(plan.totalRefill, 0);
});

/* ---- AC-BR10: Frontend-Wiring (statische Präsenz) ------------------------ */
test('AC-BR10: v3.js wires the bulk-fill action and reuses the existing refill trigger', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /buildBulkRefillPlan|bulkRefillPlan/, 'v3.js must build a bulk refill plan');
  assert.match(js, /data-slots-fillall/, 'v3.js must expose an "Automat voll auffüllen" action');
  assert.match(js, /\/api\/v2\/refill\/trigger/, 'bulk fill must reuse the existing /api/v2/refill/trigger');
  assert.match(js, /\/api\/v2\/refill\/details/, 'bulk fill must read warehouse stock via /api/v2/refill/details');
});

test('AC-BR11: v3.css defines bulk-fill classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-slots-fill/, 'v3.css must define .v3-slots-fill* classes');
});
