'use strict';

// TDD fuer Issue #17: "Aus Nayax abgleichen" - reine Abgleich-Logik.
// Vollabgleich Slotbelegung (Umbuchung) UND Fuellstand Nayax/Moma -> PG.
// Nayax-Wahrheit: machineProducts, On-Hand = PAR - MissingStockByMDB (nur MDB).
// Matching Nayax-Produktname -> products.product_id ueber product_aliases (source='nayax').
// Reine Funktionen, voll getestet inkl. Edge-Cases. machine_id parametrisch.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeOnHand,
  normalizeName,
  normalizeNayaxItems,
  buildAliasIndex,
  buildNameIndex,
  buildNayaxIdIndex,
  matchNayaxProduct,
  buildAbgleichDiff,
  buildApplyPlan,
  buildSlotAssignmentEvents,
  validateAbgleichApply,
  buildAbgleichPreviewPayload,
  buildAbgleichApplyPayload,
  buildAbgleichAuditEntry,
  buildActiveSlotsQuery,
  buildNayaxAliasesQuery,
  buildProductsByIdQuery,
} = require('../lib/nayax-abgleich.js');

// ── computeOnHand: PAR - MissingStockByMDB, geclamped >= 0 ────────────────────

test('computeOnHand: On-Hand = PAR - MissingStockByMDB', () => {
  assert.equal(computeOnHand(40, 5), 35);
  assert.equal(computeOnHand(40, 0), 40);
  assert.equal(computeOnHand(10, 3), 7);
});

test('computeOnHand: negativ wird auf 0 geclamped', () => {
  assert.equal(computeOnHand(10, 15), 0);
});

test('computeOnHand: fehlende Werte -> 0, robust', () => {
  assert.equal(computeOnHand(undefined, undefined), 0);
  assert.equal(computeOnHand(null, null), 0);
  assert.equal(computeOnHand('8', '2'), 6);
});

// ── normalizeName: symmetrische Normalisierung fuer das Matching ──────────────

test('normalizeName: lowercase + trim + Whitespace-Kollaps', () => {
  assert.equal(normalizeName('  Snickers '), 'snickers');
  assert.equal(normalizeName('COCA  COLA'), 'coca cola');
});

test('normalizeName: deutsche Umlaute + ss werden ascii-gemappt (kein U+FFFD-Bug)', () => {
  assert.equal(normalizeName('Müller'), 'mueller');
  assert.equal(normalizeName('Weiße Schokolade'), 'weisse schokolade');
  assert.equal(normalizeName('Nürnberger Lebkuchen'), 'nuernberger lebkuchen');
});

test('normalizeName: Satzzeichen werden zu Trenn-Whitespace', () => {
  assert.equal(normalizeName('Kit-Kat'), 'kit kat');
  assert.equal(normalizeName('m&m\'s'), 'm m s');
});

test('normalizeName: leer/null robust', () => {
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName(''), '');
});

// ── normalizeNayaxItems: rohe machineProducts -> normalisierte Items ──────────

test('normalizeNayaxItems: rohe Nayax-Feldnamen (MDBCode/PAR/MissingStockByMDB) -> normalisiert + on_hand', () => {
  const raw = [{ MDBCode: '11', Name: 'Snickers', PAR: 10, MissingStockByMDB: 2 }];
  const [item] = normalizeNayaxItems(raw);
  assert.equal(item.mdb_code, 11, 'mdb_code als Number');
  assert.equal(item.product_name, 'Snickers');
  assert.equal(item.par, 10);
  assert.equal(item.missing_mdb, 2);
  assert.equal(item.on_hand, 8, 'on_hand = PAR - MissingStockByMDB');
});

test('normalizeNayaxItems: akzeptiert bereits normalisierte Keys', () => {
  const [item] = normalizeNayaxItems([{ mdb_code: 12, product_name: 'KitKat', par: 8, missing_mdb: 0 }]);
  assert.equal(item.mdb_code, 12);
  assert.equal(item.product_name, 'KitKat');
  assert.equal(item.on_hand, 8);
});

test('normalizeNayaxItems: PAR/Missing sind die Wahrheit, ueberschreiben mitgeliefertes on_hand', () => {
  const [item] = normalizeNayaxItems([{ mdb_code: 1, product_name: 'X', par: 10, missing_mdb: 2, on_hand: 99 }]);
  assert.equal(item.on_hand, 8, 'on_hand wird aus PAR-Missing neu berechnet, nicht uebernommen');
});

test('normalizeNayaxItems: nie DEX verwenden (MissingStockByDEX wird ignoriert)', () => {
  const [item] = normalizeNayaxItems([{ MDBCode: 5, Name: 'Y', PAR: 10, MissingStockByMDB: 1, MissingStockByDEX: 10 }]);
  assert.equal(item.on_hand, 9, 'nur MDB zaehlt, DEX wird ignoriert');
});

test('normalizeNayaxItems: leere/ungueltige Eingabe -> []', () => {
  assert.deepEqual(normalizeNayaxItems([]), []);
  assert.deepEqual(normalizeNayaxItems(undefined), []);
  assert.deepEqual(normalizeNayaxItems(null), []);
});

// ── buildAliasIndex / matchNayaxProduct ──────────────────────────────────────

test('buildAliasIndex + matchNayaxProduct: Nayax-Name -> product_id ueber Aliase', () => {
  const idx = buildAliasIndex([
    { alias: 'Snickers', product_id: 101 },
    { alias: 'Kit Kat', product_id: 102 },
  ]);
  assert.equal(matchNayaxProduct({ product_name: 'snickers' }, idx), 101, 'case-insensitiv');
  assert.equal(matchNayaxProduct({ product_name: 'KIT  KAT' }, idx), 102, 'whitespace-tolerant');
  assert.equal(matchNayaxProduct({ product_name: 'Unbekannt' }, idx), null, 'kein Treffer -> null');
});

test('buildAliasIndex: mehrere Aliase pro Produkt erlaubt (alle mappen)', () => {
  const idx = buildAliasIndex([
    { alias: 'Coca Cola', product_id: 200 },
    { alias: 'Cola', product_id: 200 },
  ]);
  assert.equal(matchNayaxProduct({ product_name: 'Cola' }, idx), 200);
  assert.equal(matchNayaxProduct({ product_name: 'coca cola' }, idx), 200);
});

// ── Issue #18: Matching ueber NayaxProductID (robuster als Name) ─────────────

test('normalizeNayaxItems: extrahiert nayax_product_id (NayaxProductID/ProductId)', () => {
  const [a] = normalizeNayaxItems([{ MDBCode: 11, NayaxProductID: 457, Name: 'KitKat', PAR: 8, MissingStockByMDB: 0 }]);
  assert.equal(a.nayax_product_id, '457');
  const [b] = normalizeNayaxItems([{ mdb_code: 12, nayax_product_id: '99', product_name: 'X' }]);
  assert.equal(b.nayax_product_id, '99');
  const [c] = normalizeNayaxItems([{ mdb_code: 1, product_name: 'ohne id' }]);
  assert.equal(c.nayax_product_id, null);
});

test('buildNayaxIdIndex: alias-Rows (numerische ID) -> Map ID->product_id', () => {
  const idx = buildNayaxIdIndex([
    { alias: '457', product_id: 6 },
    { alias: '12345', product_id: 9 },
    { alias: '', product_id: 7 },        // leer -> ignoriert
    { alias: '777', product_id: 'x' },   // ungueltige pid -> ignoriert
  ]);
  assert.equal(idx.get('457'), 6);
  assert.equal(idx.get('12345'), 9);
  assert.equal(idx.size, 2);
});

test('matchNayaxProduct: NayaxProductID gewinnt vor dem Namen', () => {
  const nameIdx = buildAliasIndex([{ alias: 'Falscher Name', product_id: 999 }]);
  const idIdx = buildNayaxIdIndex([{ alias: '457', product_id: 6 }]);
  // Name wuerde nicht matchen, aber die ID schon -> 6
  assert.equal(matchNayaxProduct({ nayax_product_id: '457', product_name: 'voellig anders' }, nameIdx, idIdx), 6);
});

test('matchNayaxProduct: faellt auf Namen zurueck, wenn ID unbekannt/fehlt', () => {
  const nameIdx = buildAliasIndex([{ alias: 'Snickers', product_id: 101 }]);
  const idIdx = buildNayaxIdIndex([{ alias: '457', product_id: 6 }]);
  // ID nicht im Index -> Name-Fallback
  assert.equal(matchNayaxProduct({ nayax_product_id: '999', product_name: 'Snickers' }, nameIdx, idIdx), 101);
  // gar keine ID -> Name-Fallback
  assert.equal(matchNayaxProduct({ product_name: 'Snickers' }, nameIdx, idIdx), 101);
  // leerer idIndex -> exakt altes Verhalten (rueckwaertskompatibel)
  assert.equal(matchNayaxProduct({ nayax_product_id: '457', product_name: 'Snickers' }, nameIdx, new Map()), 101);
});

test('buildNameIndex + matchNayaxProduct: Fallback ueber products.name (Produkt ohne nayax-Alias)', () => {
  // Realer Fall (Hochwald Eiskaffee / Red Bull summer edition): Nayax-Name ==
  // products.name, aber KEIN nayax-Alias gepflegt -> frueher kein_match.
  const nameIndex = buildNameIndex([
    { name: 'Hochwald Eiskaffee', product_id: 200 },
    { name: 'Red Bull summer edition', product_id: 201 },
  ]);
  // kein aliasIndex/idIndex-Treffer -> Name-Fallback greift
  assert.equal(matchNayaxProduct({ product_name: 'Hochwald Eiskaffee' }, new Map(), new Map(), nameIndex), 200);
  assert.equal(matchNayaxProduct({ product_name: 'RED BULL  summer edition' }, new Map(), new Map(), nameIndex), 201, 'normalisiert (Gross/Whitespace)');
  assert.equal(matchNayaxProduct({ product_name: 'Gibt es nicht' }, new Map(), new Map(), nameIndex), null);
});

test('matchNayaxProduct: nayax-Alias hat Vorrang vor dem Namens-Fallback', () => {
  // Alias zeigt bewusst auf ein ANDERES Produkt als der Name -> Alias gewinnt.
  const aliasIndex = buildAliasIndex([{ alias: 'Cola', product_id: 500 }]);
  const nameIndex = buildNameIndex([{ name: 'Cola', product_id: 999 }]);
  assert.equal(matchNayaxProduct({ product_name: 'Cola' }, aliasIndex, new Map(), nameIndex), 500);
});

test('buildAbgleichDiff: Namens-Fallback macht Umbuchung sichtbar (Produkt ohne nayax-Alias)', () => {
  // PG-Slot mdb 51 traegt noch das alte Produkt (Sprite); Nayax meldet dort das
  // neu eingepflegte "Hochwald Eiskaffee" (kein nayax-Alias, aber products.name).
  const pgSlots = [{ slot_assignment_id: 1, machine_key: '457107528', mdb_code: 51, product_id: 51, product_key: 'SKU_SPRITE', product_name: 'Sprite', current_machine_qty: 5, product_slot_key: 'PS_51', target_stock: 8, machine_capacity: 8 }];
  const nayaxItems = normalizeNayaxItems([{ MDBCode: 51, Name: 'Hochwald Eiskaffee', PAR: 5, MissingStockByMDB: 0 }]);
  const nameIndex = buildNameIndex([{ name: 'Hochwald Eiskaffee', product_id: 200 }, { name: 'Sprite', product_id: 51 }]);
  // OHNE nameIndex: kein_match (alt verhalten)
  const without = buildAbgleichDiff(pgSlots, nayaxItems, new Map(), { machineId: '457107528' });
  assert.equal(without.onboarding.length, 1);
  assert.equal(without.onboarding[0].reason, 'kein_match');
  assert.equal(without.assignment_changes.length, 0);
  // MIT nameIndex: saubere Umbuchung Sprite -> Hochwald Eiskaffee
  const withName = buildAbgleichDiff(pgSlots, nayaxItems, new Map(), { machineId: '457107528', nameIndex, productsById: { 200: 'Hochwald Eiskaffee' } });
  assert.equal(withName.onboarding.length, 0, 'kein Ueberspringen mehr');
  assert.equal(withName.assignment_changes.length, 1);
  assert.equal(withName.assignment_changes[0].new_product_id, 200);
  assert.equal(withName.assignment_changes[0].new_qty, 5);
});

test('buildAbgleichDiff: ID-Match macht abweichenden Namen unschaedlich (kein Fehl-Umbuchen)', () => {
  // Slot hat Produkt 6; Nayax meldet denselben Slot mit ABWEICHENDEM Namen,
  // aber passender NayaxProductID -> per ID erkannt -> unchanged, keine Umbuchung.
  const pgSlots = [{ slot_assignment_id: 1, mdb_code: 15, product_id: 6, current_machine_qty: 5, product_name: 'Snickers Creamy', product_slot_key: 'PS_1' }];
  const nayaxItems = normalizeNayaxItems([{ MDBCode: 15, NayaxProductID: 457, Name: 'Snickers Cream Peanut Butter', PAR: 5, MissingStockByMDB: 0 }]);
  const aliasIndex = buildAliasIndex([{ alias: 'Snickers Creamy', product_id: 6 }]); // Katalogname wuerde NICHT matchen
  const idIndex = buildNayaxIdIndex([{ alias: '457', product_id: 6 }]);
  const diff = buildAbgleichDiff(pgSlots, nayaxItems, aliasIndex, { machineId: '1', idIndex });
  assert.equal(diff.assignment_changes.length, 0, 'keine Umbuchung trotz Namensabweichung');
  assert.equal(diff.onboarding.length, 0, 'kein faelschliches Onboarding');
  assert.equal(diff.unchanged.length, 1);
});

// ── buildAbgleichDiff: das Herzstueck ────────────────────────────────────────

const PG_SLOTS = [
  { slot_assignment_id: 1, machine_key: '457107528', mdb_code: 11, product_id: 101, product_key: 'SKU_SNICKERS', product_name: 'Snickers', current_machine_qty: 5, product_slot_key: 'PS_a', target_stock: 10, machine_capacity: 10 },
  { slot_assignment_id: 2, machine_key: '457107528', mdb_code: 12, product_id: 102, product_key: 'SKU_KITKAT', product_name: 'KitKat', current_machine_qty: 8, product_slot_key: 'PS_b', target_stock: 10, machine_capacity: 10 },
  { slot_assignment_id: 3, machine_key: '457107528', mdb_code: 13, product_id: 104, product_key: 'SKU_MARS', product_name: 'Mars', current_machine_qty: 4, product_slot_key: 'PS_c', target_stock: 6, machine_capacity: 6 },
  { slot_assignment_id: 4, machine_key: '457107528', mdb_code: 14, product_id: 105, product_key: 'SKU_BOUNTY', product_name: 'Bounty', current_machine_qty: 3, product_slot_key: 'PS_d', target_stock: 6, machine_capacity: 6 },
];

const PRODUCT_KEY_BY_ID = { 101: 'SKU_SNICKERS', 102: 'SKU_KITKAT', 103: 'SKU_TWIX', 104: 'SKU_MARS', 105: 'SKU_BOUNTY', 106: 'SKU_PRINGLES' };

const NAYAX_ITEMS = [
  { mdb_code: 11, product_name: 'Snickers', par: 10, missing_mdb: 2, on_hand: 8 },   // Menge 5 -> 8
  { mdb_code: 12, product_name: 'Twix', par: 10, missing_mdb: 1, on_hand: 9 },        // Umbuchung KitKat->Twix, 8 -> 9
  { mdb_code: 13, product_name: 'Mars', par: 6, missing_mdb: 2, on_hand: 4 },         // unveraendert
  { mdb_code: 15, product_name: 'Pringles', par: 8, missing_mdb: 0, on_hand: 8 },     // matched, aber kein PG-Slot -> onboarding
  { mdb_code: 16, product_name: 'Unbekannt XY', par: 5, missing_mdb: 0, on_hand: 5 }, // unmatchbar -> onboarding
];

const ALIAS_INDEX = buildAliasIndex([
  { alias: 'Snickers', product_id: 101 },
  { alias: 'KitKat', product_id: 102 },
  { alias: 'Twix', product_id: 103 },
  { alias: 'Mars', product_id: 104 },
  { alias: 'Bounty', product_id: 105 },
  { alias: 'Pringles', product_id: 106 },
]);

const PRODUCTS_BY_ID = { 101: 'Snickers', 102: 'KitKat', 103: 'Twix', 104: 'Mars', 105: 'Bounty', 106: 'Pringles' };

function diff() {
  return buildAbgleichDiff(PG_SLOTS, NAYAX_ITEMS, ALIAS_INDEX, { machineId: '457107528', productsById: PRODUCTS_BY_ID });
}

test('buildAbgleichDiff: Produktwechsel im Slot -> assignment_change (Umbuchung alt->neu)', () => {
  const d = diff();
  assert.equal(d.assignment_changes.length, 1);
  const c = d.assignment_changes[0];
  assert.equal(c.mdb_code, 12);
  assert.equal(c.old_product_id, 102);
  assert.equal(c.old_product_name, 'KitKat');
  assert.equal(c.new_product_id, 103);
  assert.equal(c.new_product_name, 'Twix', 'neuer Name aus productsById aufgeloest');
  assert.equal(c.old_qty, 8);
  assert.equal(c.new_qty, 9);
});

test('buildAbgleichDiff: gleiches Produkt, andere Menge -> qty_change (Menge alt->neu)', () => {
  const d = diff();
  assert.equal(d.qty_changes.length, 1);
  const q = d.qty_changes[0];
  assert.equal(q.mdb_code, 11);
  assert.equal(q.product_id, 101);
  assert.equal(q.old_qty, 5);
  assert.equal(q.new_qty, 8);
  assert.equal(q.diff, 3);
});

test('buildAbgleichDiff: identischer Slot -> unchanged, nicht in Aenderungen', () => {
  const d = diff();
  assert.equal(d.unchanged.length, 1);
  assert.equal(d.unchanged[0].mdb_code, 13);
});

test('buildAbgleichDiff: unmatchbarer Nayax-Name -> onboarding (kein_match), kein Schreiben', () => {
  const d = diff();
  const ob = d.onboarding.find((o) => o.mdb_code === 16);
  assert.ok(ob, 'mdb 16 muss in onboarding sein');
  assert.equal(ob.product_name, 'Unbekannt XY');
  assert.equal(ob.product_id, null);
  assert.equal(ob.reason, 'kein_match');
  assert.equal(ob.on_hand, 5);
});

test('buildAbgleichDiff: Nayax-Slot ohne PG-Pendant (matched) -> onboarding (kein_pg_slot)', () => {
  const d = diff();
  const ob = d.onboarding.find((o) => o.mdb_code === 15);
  assert.ok(ob, 'mdb 15 muss in onboarding sein');
  assert.equal(ob.product_id, 106);
  assert.equal(ob.reason, 'kein_pg_slot');
});

test('buildAbgleichDiff: PG-Slot ohne Nayax-Pendant -> pg_only_slots (melden, nicht loeschen)', () => {
  const d = diff();
  assert.equal(d.pg_only_slots.length, 1);
  assert.equal(d.pg_only_slots[0].mdb_code, 14);
  assert.equal(d.pg_only_slots[0].product_id, 105);
});

test('buildAbgleichDiff: summary zaehlt korrekt', () => {
  const d = diff();
  assert.equal(d.machine_id, '457107528');
  assert.equal(d.summary.n_assignment_changes, 1);
  assert.equal(d.summary.n_qty_changes, 1);
  assert.equal(d.summary.n_onboarding, 2);
  assert.equal(d.summary.n_pg_only, 1);
  assert.equal(d.summary.n_unchanged, 1);
});

test('buildAbgleichDiff: leere Nayax-Daten -> keine Aenderungen, alle PG-Slots als pg_only', () => {
  const d = buildAbgleichDiff(PG_SLOTS, [], ALIAS_INDEX, { machineId: '457107528' });
  assert.equal(d.assignment_changes.length, 0);
  assert.equal(d.qty_changes.length, 0);
  assert.equal(d.pg_only_slots.length, 4);
});

test('buildAbgleichDiff: leere PG-Slots -> alle matchbaren Nayax-Items als onboarding (neu)', () => {
  const d = buildAbgleichDiff([], NAYAX_ITEMS, ALIAS_INDEX, { machineId: '457107528' });
  assert.equal(d.assignment_changes.length, 0);
  assert.equal(d.qty_changes.length, 0);
  assert.ok(d.onboarding.length >= 4, 'alle Nayax-Slots ohne PG-Pendant landen in onboarding');
});

test('buildAbgleichDiff: ohne productsById faellt new_product_name auf Nayax-Name zurueck', () => {
  const d = buildAbgleichDiff(PG_SLOTS, NAYAX_ITEMS, ALIAS_INDEX, { machineId: '457107528' });
  const c = d.assignment_changes[0];
  assert.equal(c.new_product_name, 'Twix');
});

// ── buildApplyPlan: nur Umbuchungen + Mengen, ohne onboarding/pg_only ─────────

test('buildApplyPlan: erzeugt Operationen nur fuer Umbuchungen und Mengenaenderungen', () => {
  const plan = buildApplyPlan(diff());
  assert.equal(plan.operations.length, 2, 'genau Umbuchung(12) + Menge(11), kein onboarding');
  const reassign = plan.operations.find((o) => o.type === 'reassign');
  const setQty = plan.operations.find((o) => o.type === 'set_qty');
  assert.ok(reassign && setQty);
  assert.equal(reassign.mdb_code, 12);
  assert.equal(reassign.old_product_id, 102);
  assert.equal(reassign.new_product_id, 103);
  assert.equal(reassign.new_qty, 9);
  assert.equal(setQty.mdb_code, 11);
  assert.equal(setQty.product_id, 101);
  assert.equal(setQty.new_qty, 8);
});

test('buildApplyPlan: onboarding-/pg_only-Slots werden NIE in den Schreibplan aufgenommen', () => {
  const plan = buildApplyPlan(diff());
  const mdbs = plan.operations.map((o) => o.mdb_code);
  assert.ok(!mdbs.includes(15), 'kein_pg_slot wird uebersprungen');
  assert.ok(!mdbs.includes(16), 'kein_match wird uebersprungen');
  assert.ok(!mdbs.includes(14), 'pg_only wird uebersprungen');
});

test('buildApplyPlan: Guard = Anzahl Aenderungen + Summe der Soll-Mengen', () => {
  const plan = buildApplyPlan(diff());
  assert.equal(plan.guard.expected_changes, 2);
  assert.equal(plan.guard.expected_qty_sum, 17, '9 (Umbuchung) + 8 (Menge)');
  assert.equal(plan.machine_id, '457107528');
});

test('buildApplyPlan: jede Operation hat einen deterministischen, idempotenten op_key', () => {
  const plan1 = buildApplyPlan(diff());
  const plan2 = buildApplyPlan(diff());
  assert.deepEqual(plan1.operations.map((o) => o.op_key), plan2.operations.map((o) => o.op_key));
  assert.ok(plan1.operations.every((o) => typeof o.op_key === 'string' && o.op_key.length > 0));
});

test('buildAbgleichDiff: traegt old_product_key fuer den Schreibpfad (Schliessen der alten Zuordnung)', () => {
  const d = diff();
  assert.equal(d.assignment_changes[0].old_product_key, 'SKU_KITKAT');
  assert.equal(d.qty_changes[0].old_product_key, 'SKU_SNICKERS');
});

test('buildApplyPlan: Operationen tragen product_slot_key + old_product_key (fuer close/open)', () => {
  const plan = buildApplyPlan(diff());
  const reassign = plan.operations.find((o) => o.type === 'reassign');
  const setQty = plan.operations.find((o) => o.type === 'set_qty');
  assert.equal(reassign.product_slot_key, 'PS_b');
  assert.equal(reassign.old_product_key, 'SKU_KITKAT');
  assert.equal(setQty.product_slot_key, 'PS_a');
  assert.equal(setQty.old_product_key, 'SKU_SNICKERS');
});

// ── buildSlotAssignmentEvents: pgw_write-konforme Events (close alt + open neu) ─
// Einheitlicher, bewaehrter slot_assignment-Pfad: pgw_write setzt
// current_machine_qty NUR beim INSERT eines neuen product_slot_key, daher wird
// jede Aenderung (Umbuchung UND Menge) als close(alt)+open(neu) ausgefuehrt.

const EVENT_CTX = {
  machineKey: '457107528',
  nowIso: '2026-05-31T14:30:00.000Z',
  batchRunId: 'abgl_2026-05-31',
  productKeyById: PRODUCT_KEY_BY_ID,
};

test('buildSlotAssignmentEvents: je Operation ein close- + ein open-Event (slot_assignment)', () => {
  const events = buildSlotAssignmentEvents(buildApplyPlan(diff()), EVENT_CTX);
  assert.equal(events.length, 4, '2 Operationen x (close+open)');
  assert.ok(events.every((e) => e.event_type === 'slot_assignment'));
  assert.ok(events.every((e) => e.batch_run_id === 'abgl_2026-05-31'));
  assert.ok(events.every((e) => e.data.machine_key === '457107528'));
});

test('buildSlotAssignmentEvents: Umbuchung schliesst alte (active=false, valid_to) + oeffnet neue', () => {
  const events = buildSlotAssignmentEvents(buildApplyPlan(diff()), EVENT_CTX);
  // Umbuchung mdb 12: KitKat(PS_b) -> Twix
  const close = events.find((e) => e.data.product_slot_key === 'PS_b');
  assert.ok(close, 'close-Event mit altem product_slot_key');
  assert.equal(close.data.active, false);
  assert.equal(close.data.valid_to, '2026-05-31T14:30:00.000Z');
  assert.equal(close.data.product_key, 'SKU_KITKAT', 'close traegt altes Produkt');

  const open = events.find((e) => e.data.active === true && e.data.product_key === 'SKU_TWIX');
  assert.ok(open, 'open-Event fuers neue Produkt');
  assert.equal(open.data.mdb_code, 12);
  assert.equal(open.data.current_machine_qty, 9, 'On-Hand wird beim INSERT gesetzt');
  assert.equal(open.data.valid_from, '2026-05-31T14:30:00.000Z');
  assert.equal(open.data.valid_to, null);
  assert.ok(/^PS_457107528_12_SKU_TWIX_/.test(open.data.product_slot_key), 'neuer deterministischer product_slot_key');
});

test('buildSlotAssignmentEvents: Mengenaenderung = close+open desselben Produkts mit neuer Menge', () => {
  const events = buildSlotAssignmentEvents(buildApplyPlan(diff()), EVENT_CTX);
  // mdb 11 Snickers 5 -> 8 (gleiches Produkt)
  const open = events.find((e) => e.data.active === true && e.data.mdb_code === 11);
  assert.ok(open);
  assert.equal(open.data.product_key, 'SKU_SNICKERS', 'gleiches Produkt');
  assert.equal(open.data.current_machine_qty, 8, 'neue Menge per INSERT gesetzt');
  assert.ok(/^PS_457107528_11_SKU_SNICKERS_/.test(open.data.product_slot_key));
});

test('buildSlotAssignmentEvents: deterministisch (gleiche nowIso -> gleiche Keys)', () => {
  const a = buildSlotAssignmentEvents(buildApplyPlan(diff()), EVENT_CTX);
  const b = buildSlotAssignmentEvents(buildApplyPlan(diff()), EVENT_CTX);
  assert.deepEqual(a.map((e) => e.data.product_slot_key), b.map((e) => e.data.product_slot_key));
});

test('buildSlotAssignmentEvents: leerer Plan -> keine Events', () => {
  assert.deepEqual(buildSlotAssignmentEvents({ operations: [] }, EVENT_CTX), []);
});

// ── validateAbgleichApply: Guard gegen leere/ungueltige Applies ───────────────

test('validateAbgleichApply: akzeptiert gueltigen Plan', () => {
  const r = validateAbgleichApply({ machine_id: '457107528', operations: [{ type: 'set_qty', mdb_code: 11 }] });
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
});

test('validateAbgleichApply: fehlende machine_id -> ungueltig', () => {
  const r = validateAbgleichApply({ operations: [{ type: 'set_qty' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.field === 'machine_id'));
});

test('validateAbgleichApply: leerer Plan (nichts abzugleichen) -> ungueltig', () => {
  const r = validateAbgleichApply({ machine_id: '457107528', operations: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.field === 'operations'));
});

// ── Payloads: preview + apply ────────────────────────────────────────────────

test('buildAbgleichPreviewPayload: mode=preview + machine_id', () => {
  const p = buildAbgleichPreviewPayload('457107528');
  assert.equal(p.mode, 'preview');
  assert.equal(p.machine_id, '457107528');
});

test('buildAbgleichApplyPayload: mode=apply, traegt Plan + Guard + triggered_by', () => {
  const plan = buildApplyPlan(diff());
  const p = buildAbgleichApplyPayload(plan, { triggered_by: 'admin@example.test' });
  assert.equal(p.mode, 'apply');
  assert.equal(p.machine_id, '457107528');
  assert.deepEqual(p.guard, plan.guard);
  assert.equal(p.operations.length, 2);
  assert.equal(p.triggered_by, 'admin@example.test');
});

test('buildAbgleichApplyPayload: idempotenter abgleich_key (gleicher Plan -> gleicher Key)', () => {
  const p1 = buildAbgleichApplyPayload(buildApplyPlan(diff()), { triggered_by: 'a' });
  const p2 = buildAbgleichApplyPayload(buildApplyPlan(diff()), { triggered_by: 'a' });
  assert.ok(typeof p1.abgleich_key === 'string' && p1.abgleich_key.length > 0);
  assert.equal(p1.abgleich_key, p2.abgleich_key);
});

// ── Audit ────────────────────────────────────────────────────────────────────

test('buildAbgleichAuditEntry: enthaelt viewer-login, timestamp, Ergebnis', () => {
  const viewer = { login: 'admin@example.test', canTriggerActions: true };
  const payload = buildAbgleichApplyPayload(buildApplyPlan(diff()), { triggered_by: 'admin@example.test' });
  const result = { ok: true, status_ref: 'abgl-123', message: 'ok' };
  const entry = buildAbgleichAuditEntry(viewer, payload, result);
  assert.equal(entry.triggered_by, 'admin@example.test');
  assert.ok(typeof entry.triggered_at === 'string');
  assert.equal(entry.machine_id, '457107528');
  assert.equal(entry.ok, true);
  assert.equal(entry.status_ref, 'abgl-123');
  assert.ok(entry.abgleich_key);
  assert.equal(entry.n_operations, 2);
});

// ── Query-Builder: parametrisch + schema-qualifiziert (Drift-Guard) ───────────

test('buildActiveSlotsQuery: joint noetige Tabellen, schema-qualifiziert, nur aktive', () => {
  const q = buildActiveSlotsQuery({ machineKey: '457107528' });
  const text = typeof q === 'string' ? q : q.text;
  for (const rel of ['slot_assignments', 'products', 'machines']) {
    assert.ok(text.includes(`automatenlager.${rel}`), `Query muss automatenlager.${rel} joinen`);
  }
  assert.ok(/\bactive\b/.test(text), 'nur aktive Slots');
  assert.ok(/product_slot_key/.test(text) && /product_key/.test(text), 'liefert product_slot_key + product_key fuer den Schreibpfad');
});

test('buildActiveSlotsQuery: machine_key parametrisch ($1), kein Hardcode', () => {
  const q = buildActiveSlotsQuery({ machineKey: '457107528' });
  assert.ok(typeof q === 'object' && Array.isArray(q.values));
  assert.ok(!q.text.includes('457107528'), 'kein Hardcode der Nayax-Nummer');
  assert.deepEqual(q.values, ['457107528']);
  assert.ok(/\$1/.test(q.text));
});

test('buildNayaxAliasesQuery: schema-qualifiziert, filtert source=nayax', () => {
  const q = buildNayaxAliasesQuery();
  const text = typeof q === 'string' ? q : q.text;
  assert.ok(text.includes('automatenlager.product_aliases'));
  assert.ok(/nayax/.test(text), 'filtert auf source nayax');
  assert.ok(/\balias\b/.test(text));
  assert.ok(/\bproduct_id\b/.test(text));
});

test('buildProductsByIdQuery: schema-qualifiziert, liefert product_id + name', () => {
  const q = buildProductsByIdQuery();
  const text = typeof q === 'string' ? q : q.text;
  assert.ok(text.includes('automatenlager.products'));
  assert.ok(/\bproduct_id\b/.test(text));
  assert.ok(/\bname\b/.test(text));
  assert.ok(/\bproduct_key\b/.test(text), 'liefert product_key (id->key fuer den Schreibpfad)');
});

// ── HTTP-Endpunkte: preview (read-only) + apply (admin-only) ──────────────────

const http = require('node:http');
const { spawn } = require('node:child_process');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET';
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: opts.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
      N8N_API_KEY: 'test-key',
      DASHBOARD_V2_PG_URL: '',
      DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

test('Endpoint: GET /api/v2/nayax-abgleich/preview ohne machine -> 400', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/preview');
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MISSING_PARAMS');
  } finally { child.kill(); }
});

test('Endpoint: GET /api/v2/nayax-abgleich/preview ohne PG -> 503 PG_UNCONFIGURED', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/preview?machine=457107528');
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
  } finally { child.kill(); }
});

test('Endpoint: POST /api/v2/nayax-abgleich/apply -> 403 fuer Gast', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'guest@example.test' },
      body: JSON.stringify({ machine: '457107528' }),
    });
    assert.equal(res.status, 403);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'READ_ONLY_FORBIDDEN');
  } finally { child.kill(); }
});

test('Endpoint: POST /api/v2/nayax-abgleich/apply (Admin) ohne machine -> 400', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MISSING_FIELDS');
  } finally { child.kill(); }
});

test('Endpoint: POST /api/v2/nayax-abgleich/apply (Admin, machine, kein PG) -> 503', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body: JSON.stringify({ machine: '457107528' }),
    });
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
  } finally { child.kill(); }
});

test('Endpoint: kein Roh-Schreibpfad (PUT /api/v2/nayax-abgleich/raw -> 404)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/raw', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
  } finally { child.kill(); }
});
