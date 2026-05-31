'use strict';

/**
 * "Aus Nayax abgleichen" - reine Abgleich-Logik (Issue #17).
 * ------------------------------------------------------------------
 * Vollabgleich von SLOTBELEGUNG (Umbuchung) UND FUELLSTAND aus Nayax/Moma
 * ins PostgreSQL. Hintergrund: Beim Auffuellen aendert sich teils auch die
 * Slotbelegung. Ein reiner Mengen-Sync wuerde die richtige Menge auf das
 * falsche Produkt schreiben -> Menge + Zuordnung MUESSEN zusammen abgeglichen
 * werden.
 *
 * Verifizierte Basis (SPEC docs/specs/nayax-bestand-drift-fix.md):
 *   - Nayax `machineProducts` liefert je MDB-Slot u.a. MDBCode, PAR,
 *     MissingStockByMDB, Produktname.
 *   - On-Hand (Ist-Bestand) = PAR - MissingStockByMDB. NUR MDB, NIE DEX.
 *   - Matching Nayax-Produktname -> products.product_id ueber product_aliases
 *     (source='nayax').
 *   - Match-Schluessel durchgaengig: machine_id (Nayax-Nummer) + mdb_code.
 *
 * Alles reine Funktionen (test-first, voll getestet, machine_id parametrisch).
 * Schreiben passiert NICHT hier: der apply-Plan wird an den bestehenden
 * append-only Umbuchungspfad (n8n WF -> WF-PGW pgw_write) uebergeben - kein
 * neuer Roh-Schreibpfad. Onboarding-/unmatchbare/PG-only-Slots werden NIE
 * geschrieben, nur gemeldet.
 */

// ── Kleinhelfer ──────────────────────────────────────────────────────────────

function toNum(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** On-Hand = PAR - MissingStockByMDB, nie negativ. NUR MDB (DEX ist tot). */
function computeOnHand(par, missingMdb) {
  return Math.max(0, toNum(par) - toNum(missingMdb));
}

/**
 * Symmetrische Namens-Normalisierung fuers Matching. Beide Seiten (Nayax-Name
 * UND gespeicherter Alias) laufen hier durch -> Vergleich ist robust gegen
 * Gross/Kleinschreibung, Whitespace und Satzzeichen. Deutsche Umlaute werden
 * VOR dem [^a-z0-9]-Filter ascii-gemappt (sonst wuerden sie weggefiltert wie
 * im historischen U+FFFD-Bug, vgl. WF4 normalize()).
 */
function normalizeName(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Nayax-Normalisierung ─────────────────────────────────────────────────────

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Rohe machineProducts-Items -> normalisierte Items. Defensiv gegen rohe
 * Nayax-Feldnamen (MDBCode/PAR/MissingStockByMDB/Name) UND bereits
 * normalisierte Keys. on_hand wird IMMER aus PAR-MissingStockByMDB neu
 * berechnet (Wahrheitsquelle), ein mitgeliefertes on_hand wird ignoriert.
 * MissingStockByDEX wird bewusst nie betrachtet.
 */
function normalizeNayaxItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((raw) => {
    const par = pick(raw, ['par', 'PAR']);
    const missingMdb = pick(raw, ['missing_mdb', 'MissingStockByMDB']);
    return {
      mdb_code: toNum(pick(raw, ['mdb_code', 'MDBCode', 'mdbCode'])),
      product_name: String(pick(raw, ['product_name', 'Name', 'ProductName', 'productName']) ?? '').trim(),
      par: toNum(par),
      missing_mdb: toNum(missingMdb),
      on_hand: computeOnHand(par, missingMdb),
    };
  });
}

// ── Produkt-Matching ueber Aliase ────────────────────────────────────────────

/** alias-Rows [{alias, product_id}] -> Map normalisierter Name -> product_id. */
function buildAliasIndex(aliasRows) {
  const index = new Map();
  for (const row of aliasRows || []) {
    const key = normalizeName(row && row.alias);
    if (!key) continue;
    const pid = Number(row.product_id);
    if (!Number.isFinite(pid)) continue;
    if (!index.has(key)) index.set(key, pid); // erster Treffer gewinnt (deterministisch)
  }
  return index;
}

/** Nayax-Item -> product_id (oder null), per normalisiertem Namen. */
function matchNayaxProduct(nayaxItem, aliasIndex) {
  if (!aliasIndex) return null;
  const key = normalizeName(nayaxItem && nayaxItem.product_name);
  if (!key) return null;
  return aliasIndex.has(key) ? aliasIndex.get(key) : null;
}

// ── Diff: das Herzstueck ─────────────────────────────────────────────────────

/**
 * Vollstaendiger Abgleich-Diff je Automat (Schluessel machine_id + mdb_code).
 * @param {Array} pgSlots   aktive slot_assignments (siehe buildActiveSlotsQuery)
 * @param {Array} nayaxItems normalisierte Nayax-Items (normalizeNayaxItems)
 * @param {Map}   aliasIndex Nayax-Name -> product_id (buildAliasIndex)
 * @param {{machineId?: string, productsById?: Object}} [opts]
 */
function buildAbgleichDiff(pgSlots, nayaxItems, aliasIndex, opts = {}) {
  const productsById = opts.productsById || {};
  const slotsByMdb = new Map();
  for (const s of pgSlots || []) slotsByMdb.set(toNum(s.mdb_code), s);

  const seenMdb = new Set();
  const assignment_changes = [];
  const qty_changes = [];
  const onboarding = [];
  const unchanged = [];

  for (const item of nayaxItems || []) {
    const mdb = toNum(item.mdb_code);
    seenMdb.add(mdb);
    const slot = slotsByMdb.get(mdb);
    const matchedId = matchNayaxProduct(item, aliasIndex);
    const onHand = toNum(item.on_hand);

    if (!slot) {
      // Nayax kennt den Slot, PG (noch) nicht -> Onboarding (nie schreiben).
      onboarding.push({
        mdb_code: mdb,
        product_name: item.product_name,
        product_id: matchedId,
        on_hand: onHand,
        reason: matchedId == null ? 'kein_match' : 'kein_pg_slot',
      });
      continue;
    }

    if (matchedId == null) {
      // PG-Slot existiert, aber Nayax-Produktname ist nicht zuordenbar ->
      // unsicher, daher nie schreiben, nur zum Onboarding melden.
      onboarding.push({
        mdb_code: mdb,
        product_name: item.product_name,
        product_id: null,
        on_hand: onHand,
        reason: 'kein_match',
      });
      continue;
    }

    const oldProductId = toNum(slot.product_id);
    const oldQty = toNum(slot.current_machine_qty);

    if (matchedId !== oldProductId) {
      // Produktwechsel -> Umbuchung (alte Zuordnung schliessen, neue oeffnen).
      assignment_changes.push({
        mdb_code: mdb,
        slot_assignment_id: slot.slot_assignment_id,
        product_slot_key: slot.product_slot_key,
        old_product_id: oldProductId,
        old_product_name: slot.product_name || '',
        new_product_id: matchedId,
        new_product_name: productsById[matchedId] || item.product_name || '',
        old_qty: oldQty,
        new_qty: onHand,
        target_stock: toNum(slot.target_stock),
        machine_capacity: toNum(slot.machine_capacity),
      });
    } else if (onHand !== oldQty) {
      // Gleiches Produkt, andere Menge -> reiner Mengen-Abgleich.
      qty_changes.push({
        mdb_code: mdb,
        slot_assignment_id: slot.slot_assignment_id,
        product_slot_key: slot.product_slot_key,
        product_id: oldProductId,
        product_name: slot.product_name || item.product_name || '',
        old_qty: oldQty,
        new_qty: onHand,
        diff: onHand - oldQty,
      });
    } else {
      unchanged.push({ mdb_code: mdb, product_id: oldProductId, qty: oldQty });
    }
  }

  // PG-Slots, die Nayax (nicht mehr) kennt -> nur melden, nie loeschen.
  const pg_only_slots = [];
  for (const s of pgSlots || []) {
    if (!seenMdb.has(toNum(s.mdb_code))) {
      pg_only_slots.push({
        mdb_code: toNum(s.mdb_code),
        product_id: toNum(s.product_id),
        product_name: s.product_name || '',
        current_machine_qty: toNum(s.current_machine_qty),
      });
    }
  }

  return {
    machine_id: opts.machineId != null ? String(opts.machineId) : null,
    assignment_changes,
    qty_changes,
    onboarding,
    pg_only_slots,
    unchanged,
    summary: {
      n_assignment_changes: assignment_changes.length,
      n_qty_changes: qty_changes.length,
      n_onboarding: onboarding.length,
      n_pg_only: pg_only_slots.length,
      n_unchanged: unchanged.length,
    },
  };
}

// ── Apply-Plan (nur Umbuchungen + Mengen, ohne onboarding/pg_only) ────────────

/**
 * Schreibplan aus dem Diff: genau die Slots, die sicher uebernommen werden
 * koennen (Umbuchungen + Mengenaenderungen). Onboarding-/unmatchbare/PG-only-
 * Slots werden NIE aufgenommen. Jede Operation traegt einen deterministischen,
 * idempotenten op_key. Guard = Anzahl + Summe der Soll-Mengen (fuer die
 * Anzahl-/Summen-Pruefung im apply-WF, sonst Rollback).
 */
function buildApplyPlan(diff) {
  const machineId = diff && diff.machine_id != null ? String(diff.machine_id) : null;
  const operations = [];

  for (const c of (diff && diff.assignment_changes) || []) {
    operations.push({
      type: 'reassign',
      op_key: `NAYAXABGL|REASSIGN|${machineId}|${c.mdb_code}|${c.new_product_id}|${c.new_qty}`,
      mdb_code: c.mdb_code,
      slot_assignment_id: c.slot_assignment_id,
      product_slot_key: c.product_slot_key,
      old_product_id: c.old_product_id,
      new_product_id: c.new_product_id,
      new_qty: c.new_qty,
      target_stock: c.target_stock,
      machine_capacity: c.machine_capacity,
    });
  }

  for (const q of (diff && diff.qty_changes) || []) {
    operations.push({
      type: 'set_qty',
      op_key: `NAYAXABGL|SETQTY|${machineId}|${q.mdb_code}|${q.product_id}|${q.new_qty}`,
      mdb_code: q.mdb_code,
      slot_assignment_id: q.slot_assignment_id,
      product_slot_key: q.product_slot_key,
      product_id: q.product_id,
      new_qty: q.new_qty,
    });
  }

  const expectedQtySum = operations.reduce((sum, op) => sum + toNum(op.new_qty), 0);

  return {
    machine_id: machineId,
    operations,
    guard: {
      expected_changes: operations.length,
      expected_qty_sum: expectedQtySum,
    },
  };
}

// ── Validierung / Guards ─────────────────────────────────────────────────────

function validateAbgleichApply(params) {
  const errors = [];
  const machineId = params && (params.machine_id ?? params.machineId);
  if (!machineId) {
    errors.push({ field: 'machine_id', message: 'machine_id erforderlich.' });
  }
  const ops = params && params.operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    errors.push({ field: 'operations', message: 'Kein abzugleichender Slot - nichts zu uebernehmen.' });
  }
  return { valid: errors.length === 0, errors };
}

// ── Webhook-Payloads ─────────────────────────────────────────────────────────

function buildAbgleichPreviewPayload(machineKey) {
  return { mode: 'preview', machine_id: String(machineKey ?? '') };
}

function buildAbgleichApplyPayload(plan, opts = {}) {
  const guard = plan.guard || { expected_changes: 0, expected_qty_sum: 0 };
  const abgleichKey = `NAYAXABGL|${plan.machine_id}|${guard.expected_changes}|${guard.expected_qty_sum}`;
  return {
    mode: 'apply',
    machine_id: plan.machine_id,
    abgleich_key: abgleichKey,
    guard,
    operations: plan.operations || [],
    triggered_by: opts.triggered_by ?? null,
    requested_at: new Date().toISOString(),
  };
}

// ── Audit ────────────────────────────────────────────────────────────────────

function buildAbgleichAuditEntry(viewer, payload, result) {
  return {
    triggered_by: viewer.login,
    triggered_at: new Date().toISOString(),
    abgleich_key: payload.abgleich_key,
    machine_id: payload.machine_id,
    n_operations: (payload.operations || []).length,
    guard: payload.guard ?? null,
    ok: result.ok,
    status_ref: result.status_ref ?? null,
    message: result.message ?? '',
  };
}

// ── SQL-Query-Builder (parametrisch, schema-qualifiziert -> Drift-Guard) ──────

/**
 * Aktive slot_assignments je Automat (Nayax-Nummer machine_key, parametrisch).
 * Liefert genau die Spalten, die buildAbgleichDiff als pgSlots konsumiert.
 */
function buildActiveSlotsQuery(opts = {}) {
  const raw = opts.machineKey;
  const machineKey = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
  const values = machineKey ? [machineKey] : [];
  const where = machineKey
    ? 'WHERE sa.active = TRUE AND m.machine_key = $1'
    : 'WHERE sa.active = TRUE';

  const text = `
    SELECT
      sa.slot_assignment_id   AS slot_assignment_id,
      m.machine_key           AS machine_key,
      sa.mdb_code             AS mdb_code,
      sa.product_id           AS product_id,
      p.name                  AS product_name,
      sa.current_machine_qty  AS current_machine_qty,
      sa.target_stock         AS target_stock,
      sa.machine_capacity     AS machine_capacity,
      sa.product_slot_key     AS product_slot_key
    FROM automatenlager.slot_assignments sa
    JOIN automatenlager.products p ON p.product_id = sa.product_id
    JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
    ${where}
    ORDER BY sa.mdb_code`;

  return { text, values };
}

/** Alle Nayax-Aliase (source='nayax') mit ihrem product_id, fuers Matching. */
function buildNayaxAliasesQuery() {
  const text = `
    SELECT
      a.alias       AS alias,
      a.product_id  AS product_id
    FROM automatenlager.product_aliases a
    WHERE a.source = 'nayax'
    ORDER BY a.product_id, a.alias`;
  return { text, values: [] };
}

/** product_id -> name, fuer die Aufloesung neuer Produktnamen im Diff. */
function buildProductsByIdQuery() {
  const text = `
    SELECT
      p.product_id  AS product_id,
      p.name        AS name
    FROM automatenlager.products p
    ORDER BY p.product_id`;
  return { text, values: [] };
}

module.exports = {
  computeOnHand,
  normalizeName,
  normalizeNayaxItems,
  buildAliasIndex,
  matchNayaxProduct,
  buildAbgleichDiff,
  buildApplyPlan,
  validateAbgleichApply,
  buildAbgleichPreviewPayload,
  buildAbgleichApplyPayload,
  buildAbgleichAuditEntry,
  buildActiveSlotsQuery,
  buildNayaxAliasesQuery,
  buildProductsByIdQuery,
};
