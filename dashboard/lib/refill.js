'use strict';

const { isAvailableBatchStatus } = require('./stock-status.js');

function searchRefillTargets(query, slotRows) {
  if (!query || !query.trim()) return slotRows.slice();
  const q = query.toLowerCase().trim();
  return slotRows.filter((row) => {
    return (
      (row.product_name || '').toLowerCase().includes(q) ||
      (row.machine_id || '').toLowerCase().includes(q) ||
      (row.machine_label || '').toLowerCase().includes(q) ||
      (row.location_name || '').toLowerCase().includes(q) ||
      String(row.mdb_code) === q
    );
  });
}

function buildRefillDetails(slotRow, batchRows, today = new Date()) {
  const freeCap = (slotRow.capacity || 0) - (slotRow.current_machine_qty || 0);
  const activeBatches = (batchRows || []).filter((b) => isAvailableBatchStatus(b.status));
  // Gesamt-Modell (#36, docs/data-model/remaining-qty-semantics.md): remaining_qty
  // führt den GESAMTbestand der Charge (Maschine + Lager). Nachfüllbarer Lager-Rest
  // = Gesamt − Maschinen-Bestand, nie negativ — konsistent zur kanonischen Formel
  // in inventory-mhd.js (GREATEST(SUM(remaining_qty) − current_machine_qty, 0)).
  const totalRemaining = activeBatches.reduce((sum, b) => sum + (Number(b.remaining_qty) || 0), 0);
  const totalBackstock = Math.max(totalRemaining - (slotRow.current_machine_qty || 0), 0);

  const mhdBatches = activeBatches
    .filter((b) => b.mhd_date != null)
    .map((b) => {
      const mhd = new Date(b.mhd_date);
      const msPerDay = 86400 * 1000;
      const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const mhdMs = Date.UTC(mhd.getFullYear(), mhd.getMonth(), mhd.getDate());
      const daysUntilMhd = Math.round((mhdMs - todayMs) / msPerDay);
      return {
        batch_key: b.batch_key,
        mhd_date: b.mhd_date,
        remaining_qty: Number(b.remaining_qty),
        days_until_mhd: daysUntilMhd,
      };
    })
    .sort((a, b) => a.mhd_date.localeCompare(b.mhd_date));

  return {
    slot: {
      machine_id: slotRow.machine_id,
      mdb_code: slotRow.mdb_code,
      product_id: slotRow.product_id,
      product_name: slotRow.product_name,
      current_machine_qty: slotRow.current_machine_qty || 0,
      target_stock: slotRow.target_stock || 0,
      capacity: slotRow.capacity || 0,
      free_capacity: freeCap,
    },
    backstock: {
      total_qty: totalBackstock,
      batches_count: activeBatches.length,
    },
    mhd_batches: mhdBatches,
    warnings: [],
  };
}

function validateRefillQty(details, qty) {
  const errors = [];
  const warnings = [];

  if (!qty || qty <= 0) {
    errors.push('Menge muss mindestens 1 sein.');
  } else {
    const freeCap = details.slot.free_capacity;
    if (qty > freeCap) {
      warnings.push(`Menge übersteigt freie Kapazität (${freeCap} frei).`);
    }
    if (details.backstock.total_qty <= 0) {
      warnings.push('Kein Backstock verfügbar.');
    } else if (qty > details.backstock.total_qty) {
      warnings.push(`Menge übersteigt verfügbaren Backstock (${details.backstock.total_qty} Stk.).`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function buildRefillAuditEntry(viewer, input, result) {
  return {
    timestamp: new Date().toISOString(),
    actor: viewer.login,
    action: 'refill_trigger',
    input,
    result,
    status_ref: result?.status_ref || null,
  };
}

module.exports = { searchRefillTargets, buildRefillDetails, validateRefillQty, buildRefillAuditEntry };
