'use strict';

/**
 * Slot-Editor-Logik (Dashboard v3, Seite "Sortiment & Slots").
 * Reine Datenfunktionen ohne Seiteneffekte – die UI (public/v3.js) und der
 * Server rufen diese Funktionen, schreiben aber ausschliesslich ueber den
 * bestehenden Slot-Assign-Vorgang.
 *
 * MDB-Slot-Code-Schema: erste Ziffer = Etage, folgende Ziffern = Position.
 * Etage 1 ist die oberste Etage ("oberste Reihe zuerst").
 */

const { buildSlotAssignPayload, validateSlotAssign } = require('./slot-assign-inline.js');
const { buildSlotChangePayload } = require('./slot-change.js');
const { validateRefillQty } = require('./refill.js');

function digitsOnly(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

/** Liefert eine endliche Zahl oder null (leere/ungueltige Werte -> null). */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Zerlegt einen MDB-Slot-Code in Etage und Position.
 * @param {number|string} mdbCode
 * @returns {{ floor: number, position: number, raw: string }}
 */
function parseSlotCode(mdbCode) {
  const raw = digitsOnly(mdbCode);
  const floor = raw.length ? Number(raw[0]) : 0;
  const position = raw.length > 1 ? Number(raw.slice(1)) : 0;
  return { floor, position, raw };
}

/**
 * Bestimmt Etage und Position eines Slots. Bevorzugt eine bereits gespeicherte
 * floor/position (rueckwaertskompatibel, keine DB-Migration noetig); fehlt
 * sie, wird sie aus dem MDB-Slot-Code abgeleitet.
 * @param {object} slot
 * @returns {{ floor: number, position: number }}
 */
function resolveSlotPosition(slot) {
  const derived = parseSlotCode(slot.mdb_code);
  return {
    floor: finiteOrNull(slot.floor) ?? derived.floor,
    position: finiteOrNull(slot.position) ?? derived.position,
  };
}

/**
 * Gruppiert Slots zu Etagen. Oberste Etage (1) zuerst, Slots je Etage nach
 * Position aufsteigend.
 * @param {Array<object>} slots  Roh-Slots mit mindestens mdb_code.
 * @returns {Array<{ floor: number, slots: Array<object> }>}
 */
function buildFloorLayout(slots) {
  const byFloor = new Map();
  (slots || []).forEach((slot) => {
    const { floor, position } = resolveSlotPosition(slot);
    const enriched = { ...slot, floor, position };
    if (!byFloor.has(floor)) byFloor.set(floor, []);
    byFloor.get(floor).push(enriched);
  });

  return [...byFloor.keys()]
    .sort((a, b) => a - b)
    .map((floor) => ({
      floor,
      slots: byFloor.get(floor).sort((a, b) => a.position - b.position),
    }));
}

/**
 * Erzeugt ziehbare Produkt-Kacheln aus den Ergebnissen der vorhandenen
 * Produkt-/Refill-Suche. Dedupliziert nach Produkt, Zeilen ohne Produkt-ID
 * werden ignoriert.
 * @param {Array<object>} searchResults
 * @returns {Array<{ product_id: number, product_key: string|null, name: string, label: string }>}
 */
function buildPaletteItems(searchResults) {
  const byProduct = new Map();
  (searchResults || []).forEach((row) => {
    const productId = Number(row.product_id);
    if (!productId) return;
    if (byProduct.has(productId)) return;
    const name = String(row.product_name ?? '').trim();
    byProduct.set(productId, {
      product_id: productId,
      product_key: row.product_key ?? null,
      name,
      label: name,
    });
  });
  return [...byProduct.values()];
}

/**
 * Erzeugt die Vorschau einer Slot-Zuordnung aus einem Drag&Drop- ODER
 * Touch-Tap-Vorgang. Beide Bedienpfade rufen diese Funktion mit denselben
 * Argumenten – es gibt damit genau einen getesteten Kern. Die Zuordnung
 * laeuft ueber den bestehenden Slot-Assign-Vorgang: derselbe idempotente
 * Schluessel (buildSlotAssignPayload) und dieselbe Validierung
 * (validateSlotAssign). KEIN neuer Roh-Schreibpfad.
 *
 * @param {object}        opts
 * @param {object}        opts.item        Palette-Kachel: { product_id, product_key, name }
 * @param {object}        opts.slot        Ziel-Slot: { mdb_code, ... }
 * @param {string}        opts.machine_id  Automat
 * @param {number|string} [opts.qty=0]     Startmenge
 * @param {string}        [opts.start_date='']  Startdatum
 * @returns {{ product, slot, assign, assign_key, valid, errors }}
 */
function buildDropPreview({ item, slot, machine_id, qty = 0, start_date = '' }) {
  const product = {
    product_id: item.product_id,
    product_key: item.product_key ?? null,
    name: item.name ?? '',
  };
  const { floor, position } = parseSlotCode(slot.mdb_code);
  const assignParams = { machine_id, mdb_code: slot.mdb_code, qty, start_date };

  const payload = buildSlotAssignPayload(
    { product_id: product.product_id, product_key: product.product_key },
    assignParams,
  );
  const validation = validateSlotAssign(assignParams);

  return {
    product,
    slot: { mdb_code: payload.mdb_code, floor, position, machine_id },
    assign: {
      product_id: payload.product_id,
      product_key: payload.product_key,
      machine_id: payload.machine_id,
      mdb_code: payload.mdb_code,
      qty: payload.qty,
      start_date: payload.start_date,
    },
    assign_key: payload.assign_key,
    valid: validation.valid && Boolean(product.product_id),
    errors: validation.errors,
  };
}

function slotQty(slot) {
  return Number(slot.current_machine_qty != null ? slot.current_machine_qty : (slot.qty != null ? slot.qty : 0));
}

/**
 * Plant den Tausch zweier belegter Slots. Beide behalten ihre Position
 * (mdb_code), tauschen aber Produkt UND Menge (der Bestand wandert mit dem
 * Produkt mit). Umgesetzt als zwei Slot-Change-Vorgaenge ueber den
 * bestehenden, idempotenten Pfad (buildSlotChangePayload) – kein neuer
 * Roh-Schreibpfad. Tauschbar sind nur zwei verschiedene, belegte Slots.
 *
 * @param {object} slotA  { slot_assignment_id, machine_id, mdb_code, product_id, current_machine_qty }
 * @param {object} slotB  dito
 * @param {string} startDate
 * @returns {{ valid: boolean, errors: string[], changes: object[] }}
 */
function buildSwapPlan(slotA, slotB, startDate) {
  const errors = [];
  if (!(Number(slotA.product_id) > 0) || !(Number(slotB.product_id) > 0)) {
    errors.push('Tauschen ist nur zwischen zwei belegten Slots möglich.');
  }
  if (String(slotA.machine_id) === String(slotB.machine_id) && String(slotA.mdb_code) === String(slotB.mdb_code)) {
    errors.push('Quell- und Ziel-Slot sind identisch.');
  }
  if (errors.length) {
    return { valid: false, errors, changes: [] };
  }

  // machine_ref = interne sa.machine_id (für Writes); Fallback auf machine_id.
  const refA = slotA.machine_ref || slotA.machine_id;
  const refB = slotB.machine_ref || slotB.machine_id;
  const changeA = buildSlotChangePayload(
    { slot_assignment_id: slotA.slot_assignment_id, machine_id: refA, mdb_code: slotA.mdb_code, product_id: slotA.product_id },
    { new_product_id: slotB.product_id, new_qty: slotQty(slotB), start_date: startDate },
  );
  const changeB = buildSlotChangePayload(
    { slot_assignment_id: slotB.slot_assignment_id, machine_id: refB, mdb_code: slotB.mdb_code, product_id: slotB.product_id },
    { new_product_id: slotA.product_id, new_qty: slotQty(slotA), start_date: startDate },
  );
  return { valid: true, errors: [], changes: [changeA, changeB] };
}

/**
 * Menge, die einen Slot bis zur Kapazität auffuellt ("Voll auffuellen").
 * Nie negativ.
 * @param {object} details  Antwort von /api/v2/refill/details ({ slot: {...} })
 * @returns {number}
 */
function fillToCapacityQty(details) {
  const slot = (details && details.slot) || {};
  if (slot.free_capacity != null) { return Math.max(0, Number(slot.free_capacity)); }
  return Math.max(0, Number(slot.capacity || 0) - Number(slot.current_machine_qty || 0));
}

/**
 * Baut die Parameter des bestehenden Nachfuell-Vorgangs (Refill/WF7) fuer
 * einen Slot plus die Validierung der Menge.
 * @param {object} details  Antwort von /api/v2/refill/details
 * @param {number} addQty   nachzufuellende Menge
 * @returns {{ params: object, validation: object }}
 */
function buildRefillPlan(details, addQty) {
  const slot = (details && details.slot) || {};
  return {
    params: {
      machine_id:   slot.machine_ref || slot.machine_id,
      mdb_code:     Number(slot.mdb_code),
      product_id:   Number(slot.product_id),
      product_name: slot.product_name || '',
      qty:          Number(addQty),
    },
    validation: validateRefillQty(details, Number(addQty)),
  };
}

module.exports = {
  parseSlotCode,
  resolveSlotPosition,
  buildFloorLayout,
  buildPaletteItems,
  buildDropPreview,
  buildSwapPlan,
  fillToCapacityQty,
  buildRefillPlan,
};
