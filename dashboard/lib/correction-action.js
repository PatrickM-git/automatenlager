'use strict';

function buildProductSuggestion(correctionCase, allProducts) {
  const products = (allProducts || []).map((p) => ({ product_id: p.product_id, name: p.name }));

  let suggestion = null;
  if (correctionCase.suggested_product_id != null) {
    const match = products.find((p) => p.product_id === correctionCase.suggested_product_id);
    suggestion = match
      ? { product_id: match.product_id, name: match.name }
      : { product_id: correctionCase.suggested_product_id, name: correctionCase.suggested_product_name ?? '' };
  }

  return { suggestion, products };
}

function validateCorrectionAction(params) {
  const errors = [];
  if (!params.confirmed_product_id) {
    errors.push({ field: 'confirmed_product_id', message: 'Bestätigtes Produkt erforderlich.' });
  }
  return { valid: errors.length === 0, errors };
}

function buildCorrectionActionPayload(correctionCase, params) {
  const caseId = String(correctionCase.case_id ?? '');
  const confirmedProductId = Number(params.confirmed_product_id ?? 0);
  const actionKey = `CORR|${caseId}|${confirmedProductId}`;

  return {
    action_key: actionKey,
    case_id: caseId,
    case_type: correctionCase.case_type ?? null,
    machine_id: correctionCase.machine_id ?? null,
    mdb_code: correctionCase.mdb_code ?? null,
    old_product_id: correctionCase.product_id ?? null,
    confirmed_product_id: confirmedProductId,
    slot_assignment_id: correctionCase.slot_assignment_id ?? null,
  };
}

function buildCorrectionActionAuditEntry(viewer, payload, result) {
  return {
    triggered_by: viewer.login,
    triggered_at: new Date().toISOString(),
    action_key: payload.action_key,
    case_id: payload.case_id,
    case_type: payload.case_type,
    machine_id: payload.machine_id,
    mdb_code: payload.mdb_code,
    old_product_id: payload.old_product_id,
    confirmed_product_id: payload.confirmed_product_id,
    slot_assignment_id: payload.slot_assignment_id,
    ok: result.ok,
    status_ref: result.status_ref ?? null,
    message: result.message ?? '',
  };
}

module.exports = {
  buildProductSuggestion,
  validateCorrectionAction,
  buildCorrectionActionPayload,
  buildCorrectionActionAuditEntry,
};
