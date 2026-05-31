'use strict';

/**
 * Bulk-Refill-Plan — „Automat voll auffüllen". Reine Planungslogik für die
 * v3-Slots-Seite: füllt jeden Slot Richtung Kapazität auf, aber HART begrenzt
 * durch den real verfügbaren Lagerbestand (available_backstock) je Produkt.
 *
 * Kernregel: Teilen sich mehrere Slots dasselbe Produkt, wird dessen Lager-
 * bestand als EIN gemeinsamer Pool über die Slots aufgeteilt — nie doppelt
 * gezählt, nie mehr als verfügbar. Der Plan löst keinen neuen Schreibpfad aus;
 * jeder geplante Slot trägt die Parameter des bestehenden /api/v2/refill/trigger.
 */

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function desiredFill(slot) {
  const cap = num(slot.capacity);
  const cur = num(slot.current_machine_qty);
  const free = slot.free_capacity != null ? num(slot.free_capacity) : (cap - cur);
  return Math.max(0, free);
}

function buildBulkRefillPlan(slots = []) {
  const list = Array.isArray(slots) ? slots : [];

  // Geteilter Lagerbestands-Pool je Produkt (einmalig initialisiert).
  const available = new Map();   // product_id -> Anfangs-Lagerbestand
  const remaining = new Map();   // product_id -> noch verfügbarer Lagerbestand
  const requested = new Map();   // product_id -> insgesamt gewünschte Menge
  const nameOf = new Map();
  const order = [];

  for (const slot of list) {
    const pid = num(slot.product_id);
    if (pid <= 0 || available.has(pid)) { continue; }
    const stock = Math.max(0, num(slot.available_backstock));
    available.set(pid, stock);
    remaining.set(pid, stock);
    requested.set(pid, 0);
    nameOf.set(pid, slot.product_name || '');
    order.push(pid);
  }

  let totalRefill = 0, slotsPlanned = 0, cappedCount = 0;

  const planSlots = list.map((slot) => {
    const pid = num(slot.product_id);
    const desired = pid > 0 ? desiredFill(slot) : 0;
    if (pid > 0) { requested.set(pid, requested.get(pid) + desired); }

    let qty = 0, capped = false;
    if (pid > 0 && desired > 0) {
      const pool = remaining.get(pid);
      qty = Math.min(desired, pool);
      remaining.set(pid, pool - qty);
      capped = qty < desired;
    }
    if (qty > 0) { totalRefill += qty; slotsPlanned += 1; }
    if (capped) { cappedCount += 1; }

    return {
      machine_id: slot.machine_id,
      mdb_code: slot.mdb_code,
      product_id: pid,
      product_name: slot.product_name || '',
      current_machine_qty: num(slot.current_machine_qty),
      capacity: num(slot.capacity),
      desired,
      refill_qty: qty,
      qty,                                        // Alias für /api/v2/refill/trigger
      available_backstock: pid > 0 ? available.get(pid) : 0,
      capped_by_stock: capped,
    };
  });

  const byProduct = order.map((pid) => {
    const avail = available.get(pid);
    const alloc = avail - remaining.get(pid);
    const req = requested.get(pid);
    return {
      product_id: pid,
      product_name: nameOf.get(pid),
      requested: req,
      allocated: alloc,
      available: avail,
      short: alloc < req,
    };
  });

  return { slots: planSlots, totalRefill, slotsPlanned, cappedCount, byProduct };
}

module.exports = { buildBulkRefillPlan };
