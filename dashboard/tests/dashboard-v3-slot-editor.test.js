'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseSlotCode,
  buildFloorLayout,
  buildPaletteItems,
  buildDropPreview,
  resolveSlotPosition,
  buildSwapPlan,
  fillToCapacityQty,
  buildRefillPlan,
} = require('../lib/slot-editor.js');

const { buildSlotAssignPayload } = require('../lib/slot-assign-inline.js');
const { buildSlotChangePayload } = require('../lib/slot-change.js');

/* ---- AC1: Automat als Etagen-Stapel ----------------------------------- */
/* Erste MDB-Ziffer = Etage, oberste Etage (1) oben; folgende Ziffern = Position. */

test('parseSlotCode: erste Ziffer ist die Etage, Rest die Position', () => {
  assert.deepEqual(parseSlotCode(23), { floor: 2, position: 3, raw: '23' });
  assert.deepEqual(parseSlotCode('105'), { floor: 1, position: 5, raw: '105' });
  assert.deepEqual(parseSlotCode(47), { floor: 4, position: 7, raw: '47' });
});

test('buildFloorLayout: Etagen mit oberster Etage (1) zuerst, Slots nach Position sortiert', () => {
  const slots = [
    { mdb_code: 31, product_name: 'C' },
    { mdb_code: 12, product_name: 'A' },
    { mdb_code: 11, product_name: 'B' },
    { mdb_code: 23, product_name: 'D' },
  ];

  const layout = buildFloorLayout(slots);

  // Etagen aufsteigend: oberste Etage (1) zuerst, dann 2, dann 3.
  assert.deepEqual(layout.map((f) => f.floor), [1, 2, 3]);

  // Etage 1 enthaelt Position 1 und 2 in Reihenfolge.
  assert.deepEqual(layout[0].slots.map((s) => s.position), [1, 2]);
  assert.equal(layout[0].slots[0].mdb_code, 11);
  assert.equal(layout[0].slots[1].mdb_code, 12);

  // Jeder Slot traegt floor/position aus dem Slot-Code.
  assert.equal(layout[1].floor, 2);
  assert.equal(layout[1].slots[0].position, 3);
});

/* ---- AC2: Ziehbare Produkt-Kacheln aus der Produkt-/Refill-Suche ------- */

test('buildPaletteItems: macht aus Suchergebnissen ziehbare Produkt-Kacheln', () => {
  const searchResults = [
    { product_id: 7, product_name: 'Coca-Cola 0,5l', machine_id: 'M1', mdb_code: 11 },
    { product_id: 9, product_name: 'Wasser still', machine_id: 'M1', mdb_code: 12 },
  ];

  const items = buildPaletteItems(searchResults);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    product_id: 7,
    product_key: null,
    name: 'Coca-Cola 0,5l',
    label: 'Coca-Cola 0,5l',
  });
});

test('buildPaletteItems: dedupliziert nach Produkt und ignoriert Zeilen ohne Produkt-ID', () => {
  const searchResults = [
    { product_id: 7, product_name: 'Coca-Cola 0,5l', machine_id: 'M1', mdb_code: 11 },
    { product_id: 7, product_name: 'Coca-Cola 0,5l', machine_id: 'M2', mdb_code: 21 },
    { product_name: 'Ohne ID', machine_id: 'M3', mdb_code: 31 },
  ];

  const items = buildPaletteItems(searchResults);

  assert.equal(items.length, 1);
  assert.equal(items[0].product_id, 7);
});

/* ---- AC3: Drag&Drop -> Vorschau -> Bestaetigung ----------------------- */

test('buildDropPreview: erzeugt Vorschau mit Produkt, Ziel-Slot und Assign-Parametern', () => {
  const item = { product_id: 7, product_key: 'COLA05', name: 'Coca-Cola 0,5l' };
  const slot = { mdb_code: 23 };

  const preview = buildDropPreview({ item, slot, machine_id: 'M1', qty: 12, start_date: '2026-05-30' });

  assert.deepEqual(preview.product, { product_id: 7, product_key: 'COLA05', name: 'Coca-Cola 0,5l' });
  assert.equal(preview.slot.mdb_code, 23);
  assert.equal(preview.slot.floor, 2);
  assert.equal(preview.slot.position, 3);
  assert.equal(preview.slot.machine_id, 'M1');
  assert.equal(preview.valid, true);

  // Assign-Parameter sind exakt die Eingabe des bestehenden Confirm-Endpunkts.
  assert.deepEqual(preview.assign, {
    product_id: 7,
    product_key: 'COLA05',
    machine_id: 'M1',
    mdb_code: 23,
    qty: 12,
    start_date: '2026-05-30',
  });
});

test('buildDropPreview: nutzt den idempotenten Schluessel des bestehenden Slot-Assign-Vorgangs', () => {
  const item = { product_id: 7, product_key: 'COLA05', name: 'Coca-Cola 0,5l' };
  const slot = { mdb_code: 23 };

  const preview = buildDropPreview({ item, slot, machine_id: 'M1', qty: 12, start_date: '2026-05-30' });

  const expected = buildSlotAssignPayload(
    { product_id: 7, product_key: 'COLA05' },
    { machine_id: 'M1', mdb_code: 23, qty: 12, start_date: '2026-05-30' },
  );
  assert.equal(preview.assign_key, expected.assign_key);
  assert.equal(preview.assign_key, 'SLOTASSIGN|7|M1|23');
});

test('buildDropPreview: markiert unvollstaendige Zuordnung als ungueltig', () => {
  const item = { product_id: 7, product_key: 'COLA05', name: 'Coca-Cola 0,5l' };
  const slot = { mdb_code: 23 };

  const preview = buildDropPreview({ item, slot, machine_id: '', qty: 12, start_date: '2026-05-30' });

  assert.equal(preview.valid, false);
  assert.ok(preview.errors.some((e) => e.field === 'machine_id'));
});

/* ---- AC4: Touch-Alternative (Tap-Quelle dann Tap-Ziel) ---------------- */

test('Touch-Tap und Drag&Drop erzeugen dieselbe Vorschau (gemeinsamer Kern)', () => {
  const item = { product_id: 7, product_key: 'COLA05', name: 'Coca-Cola 0,5l' };
  const slot = { mdb_code: 23 };
  const args = { item, slot, machine_id: 'M1', qty: 12, start_date: '2026-05-30' };

  // Drag-Drop-Pfad und Tap-Pfad rufen exakt dieselbe Funktion mit denselben
  // Argumenten – das Ergebnis muss identisch sein.
  const dragPreview = buildDropPreview(args);
  const tapPreview = buildDropPreview(args);

  assert.deepEqual(tapPreview, dragPreview);
});

/* ---- AC5: Slot-Position rueckwaertskompatibel; sonst aus Code ableiten - */

test('resolveSlotPosition: leitet Etage/Position aus dem Slot-Code ab, wenn nicht gespeichert', () => {
  assert.deepEqual(resolveSlotPosition({ mdb_code: 23 }), { floor: 2, position: 3 });
});

test('resolveSlotPosition: nutzt gespeicherte floor/position, wenn vorhanden (keine Migration noetig)', () => {
  // Eine zukuenftig explizit gespeicherte Position hat Vorrang vor der Ableitung.
  assert.deepEqual(
    resolveSlotPosition({ mdb_code: 23, floor: 5, position: 9 }),
    { floor: 5, position: 9 },
  );
});

test('buildFloorLayout: respektiert explizit gespeicherte Positionen', () => {
  const slots = [
    { mdb_code: 23, floor: 1, position: 2 },
    { mdb_code: 11, floor: 1, position: 1 },
  ];
  const layout = buildFloorLayout(slots);

  assert.deepEqual(layout.map((f) => f.floor), [1]);
  assert.deepEqual(layout[0].slots.map((s) => s.position), [1, 2]);
  // mdb_code 23 wurde explizit auf Etage 1 Position 2 gelegt – nicht abgeleitet 2/3.
  assert.equal(layout[0].slots[1].mdb_code, 23);
});

/* ---- Tauschen zweier belegter Slots (über bestehenden Slot-Change) ----- */

const SLOT_A = { slot_assignment_id: 101, machine_id: 'M1', mdb_code: 11, product_id: 7, product_name: 'Cola',  current_machine_qty: 4 };
const SLOT_B = { slot_assignment_id: 202, machine_id: 'M1', mdb_code: 23, product_id: 9, product_name: 'Wasser', current_machine_qty: 6 };

test('buildSwapPlan: tauscht die Produkte zweier belegter Slots, Mengen wandern mit', () => {
  const plan = buildSwapPlan(SLOT_A, SLOT_B, '2026-05-30');

  assert.equal(plan.valid, true);
  assert.equal(plan.changes.length, 2);

  // Slot A (Pos 11) bekommt Produkt von B mit dessen Menge.
  const changeA = plan.changes[0];
  assert.equal(changeA.machine_id, 'M1');
  assert.equal(changeA.mdb_code, 11);
  assert.equal(changeA.new_product_id, 9);
  assert.equal(changeA.new_qty, 6);
  assert.equal(changeA.old_product_id, 7);

  // Slot B (Pos 23) bekommt Produkt von A mit dessen Menge.
  const changeB = plan.changes[1];
  assert.equal(changeB.mdb_code, 23);
  assert.equal(changeB.new_product_id, 7);
  assert.equal(changeB.new_qty, 4);
});

test('buildSwapPlan: nutzt den idempotenten Schluessel des bestehenden Slot-Change-Vorgangs', () => {
  const plan = buildSwapPlan(SLOT_A, SLOT_B, '2026-05-30');

  const expectedA = buildSlotChangePayload(
    { slot_assignment_id: 101, machine_id: 'M1', mdb_code: 11, product_id: 7 },
    { new_product_id: 9, new_qty: 6, start_date: '2026-05-30' },
  );
  assert.equal(plan.changes[0].change_key, expectedA.change_key);
  assert.equal(plan.changes[0].change_key, 'SLOTCHG|M1|11|9|2026-05-30');
});

test('buildSwapPlan: nur zwei belegte, verschiedene Slots sind tauschbar', () => {
  const empty = { slot_assignment_id: 0, machine_id: 'M1', mdb_code: 31, product_id: 0, product_name: 'Frei', current_machine_qty: 0 };
  assert.equal(buildSwapPlan(SLOT_A, empty, '2026-05-30').valid, false);          // Ziel leer
  assert.equal(buildSwapPlan(SLOT_A, SLOT_A, '2026-05-30').valid, false);         // gleicher Slot
});

/* ---- Nachfüllen direkt am Slot (über bestehenden Refill/WF7-Vorgang) ---- */

const REFILL_DETAILS = {
  slot: { machine_id: 'M1', mdb_code: 11, product_id: 7, product_name: 'Cola', current_machine_qty: 4, capacity: 10, free_capacity: 6 },
  backstock: { total_qty: 20, batches_count: 2 },
};

test('fillToCapacityQty: liefert die Menge, die den Slot bis zur Kapazität auffüllt', () => {
  assert.equal(fillToCapacityQty(REFILL_DETAILS), 6); // 10 Kapazität − 4 Bestand
});

test('fillToCapacityQty: nie negativ, wenn der Slot bereits voll/überfüllt ist', () => {
  const full = { slot: { capacity: 10, current_machine_qty: 10, free_capacity: 0 } };
  assert.equal(fillToCapacityQty(full), 0);
});

test('buildRefillPlan: baut die Nachfüll-Parameter des bestehenden Refill-Vorgangs', () => {
  const plan = buildRefillPlan(REFILL_DETAILS, 3);

  assert.deepEqual(plan.params, {
    machine_id: 'M1',
    mdb_code: 11,
    product_id: 7,
    product_name: 'Cola',
    qty: 3,
  });
  assert.equal(plan.validation.valid, true);
});

test('buildRefillPlan: Menge 0 ist ungueltig, Überschreiten der Kapazität gibt eine Warnung', () => {
  assert.equal(buildRefillPlan(REFILL_DETAILS, 0).validation.valid, false);

  const over = buildRefillPlan(REFILL_DETAILS, 8); // freie Kapazität ist 6
  assert.equal(over.validation.valid, true);
  assert.ok(over.validation.warnings.some((w) => /Kapazit/.test(w)));
});
