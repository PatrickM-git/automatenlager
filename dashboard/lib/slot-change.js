'use strict';

function buildSlotChangePreview(slotRow, allProducts) {
  const currentProductId = Number(slotRow.product_id);
  return {
    current_slot: {
      slot_assignment_id: slotRow.slot_assignment_id,
      machine_id: slotRow.machine_id,
      machine_label: slotRow.machine_label || slotRow.machine_id,
      mdb_code: slotRow.mdb_code,
      product_id: currentProductId,
      product_name: slotRow.product_name,
      current_machine_qty: slotRow.current_machine_qty ?? 0,
      target_stock: slotRow.target_stock ?? 0,
      machine_capacity: slotRow.machine_capacity ?? 0,
      location_name: slotRow.location_name || '',
    },
    products: (allProducts || [])
      .filter((p) => Number(p.product_id) !== currentProductId)
      .map((p) => ({ product_id: p.product_id, name: p.name })),
  };
}

function validateSlotChange(params) {
  const errors = [];
  if (!params.new_product_id) {
    errors.push({ field: 'new_product_id', message: 'Neues Produkt erforderlich.' });
  }
  if (!params.start_date) {
    errors.push({ field: 'start_date', message: 'Startdatum erforderlich.' });
  }
  if (params.new_qty === undefined || params.new_qty === null || params.new_qty === '') {
    errors.push({ field: 'new_qty', message: 'Startmenge erforderlich.' });
  } else if (Number(params.new_qty) < 0) {
    errors.push({ field: 'new_qty', message: 'Startmenge darf nicht negativ sein.' });
  }
  return { valid: errors.length === 0, errors };
}

function buildSlotChangePayload(slotRow, params) {
  const machineId = String(slotRow.machine_id ?? '');
  const mdbCode = String(slotRow.mdb_code ?? '');
  const newProductId = String(params.new_product_id ?? '');
  const startDate = String(params.start_date ?? '');
  const changeKey = `SLOTCHG|${machineId}|${mdbCode}|${newProductId}|${startDate}`;
  return {
    change_key: changeKey,
    slot_assignment_id: slotRow.slot_assignment_id,
    machine_id: machineId,
    mdb_code: Number(mdbCode),
    old_product_id: Number(slotRow.product_id),
    new_product_id: Number(newProductId),
    new_qty: Number(params.new_qty ?? 0),
    start_date: startDate,
  };
}

function buildSlotChangeAuditEntry(viewer, payload, result) {
  return {
    triggered_by: viewer.login,
    triggered_at: new Date().toISOString(),
    change_key: payload.change_key,
    machine_id: payload.machine_id,
    mdb_code: payload.mdb_code,
    old_product_id: payload.old_product_id,
    new_product_id: payload.new_product_id,
    new_qty: payload.new_qty,
    start_date: payload.start_date,
    ok: result.ok,
    status_ref: result.status_ref ?? null,
    message: result.message ?? '',
  };
}

module.exports = {
  buildSlotChangePreview,
  validateSlotChange,
  buildSlotChangePayload,
  buildSlotChangeAuditEntry,
};
