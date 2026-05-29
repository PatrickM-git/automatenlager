'use strict';

function buildSlotAssignPreview(productRow, machineRows) {
  return {
    product: {
      product_id:  productRow.product_id,
      name:        productRow.name,
      product_key: productRow.product_key ?? null,
    },
    machines: (machineRows || []).map((m) => ({
      machine_id: m.machine_id,
      label:      m.label || m.machine_id,
      area:       m.area ?? null,
    })),
  };
}

function validateSlotAssign(params) {
  const errors = [];
  if (!params.machine_id) {
    errors.push({ field: 'machine_id', message: 'Automat erforderlich.' });
  }
  if (params.mdb_code === undefined || params.mdb_code === null || params.mdb_code === '') {
    errors.push({ field: 'mdb_code', message: 'MDB-Code erforderlich.' });
  }
  if (params.qty === undefined || params.qty === null || params.qty === '') {
    errors.push({ field: 'qty', message: 'Startmenge erforderlich.' });
  } else if (Number(params.qty) < 0) {
    errors.push({ field: 'qty', message: 'Startmenge darf nicht negativ sein.' });
  }
  if (!params.start_date) {
    errors.push({ field: 'start_date', message: 'Startdatum erforderlich.' });
  }
  return { valid: errors.length === 0, errors };
}

function buildSlotAssignPayload(productRow, params) {
  const productId = String(productRow.product_id ?? '');
  const machineId = String(params.machine_id ?? '');
  const mdbCode   = String(params.mdb_code ?? '');
  const assignKey = `SLOTASSIGN|${productId}|${machineId}|${mdbCode}`;
  return {
    assign_key:  assignKey,
    product_id:  Number(productId),
    product_key: productRow.product_key ?? null,
    machine_id:  machineId,
    mdb_code:    Number(mdbCode),
    qty:         Number(params.qty ?? 0),
    start_date:  String(params.start_date ?? ''),
  };
}

function buildSlotAssignAuditEntry(viewer, payload, result) {
  return {
    triggered_by:  viewer.login,
    triggered_at:  new Date().toISOString(),
    assign_key:    payload.assign_key,
    product_id:    payload.product_id,
    product_key:   payload.product_key,
    machine_id:    payload.machine_id,
    mdb_code:      payload.mdb_code,
    qty:           payload.qty,
    start_date:    payload.start_date,
    ok:            result.ok,
    status_ref:    result.status_ref ?? null,
    message:       result.message ?? '',
  };
}

module.exports = {
  buildSlotAssignPreview,
  validateSlotAssign,
  buildSlotAssignPayload,
  buildSlotAssignAuditEntry,
};
