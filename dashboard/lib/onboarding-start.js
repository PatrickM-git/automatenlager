'use strict';

function buildOnboardingStartPayload(unknownCase) {
  const productKey = String(unknownCase.product_key ?? '');
  return {
    action_key: `ONBOARDING|${productKey}`,
    product_key: productKey,
    case_id: String(unknownCase.case_id ?? ''),
    machine_id: unknownCase.machine_id ?? null,
    mdb_code: unknownCase.mdb_code ?? null,
  };
}

function validateOnboardingStart(params) {
  const errors = [];
  if (!params.product_key || String(params.product_key).trim() === '') {
    errors.push({ field: 'product_key', message: 'Nayax-Produktname erforderlich.' });
  }
  return { valid: errors.length === 0, errors };
}

function buildOnboardingStartAuditEntry(viewer, payload, result) {
  return {
    triggered_by: viewer.login,
    triggered_at: new Date().toISOString(),
    action_key: payload.action_key,
    product_key: payload.product_key,
    case_id: payload.case_id,
    machine_id: payload.machine_id,
    mdb_code: payload.mdb_code,
    ok: result.ok,
    message: result.message ?? '',
  };
}

module.exports = {
  buildOnboardingStartPayload,
  validateOnboardingStart,
  buildOnboardingStartAuditEntry,
};
