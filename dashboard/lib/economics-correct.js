'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// G&V VK/EK-Korrektur (#193) — Stammdaten-Korrektur durch die Mandanten-Tür.
//
// Daten­qualitäts-Fix (z. B. EK-Platzhalter): EK = stock_batches.unit_cost_net der
// aktiven Charge(n) des Produkts; VK = prices.sale_price_gross der aktiven Preiszeile
// der aktiven Slots des Produkts. **go-forward** (AC #193): künftige GuV nutzt den Wert;
// bereits gebuchte guv_daily-Zeilen bleiben (historisches Restatement getrennt, #175–#180).
//
// Alles durch die Tür (db.tx, explizites tenant_id, RLS-sauber). Reine Validierung
// getrennt. KEIN rohes pg (#107-rein). Audit erfolgt im Endpunkt (server.js).
// ─────────────────────────────────────────────────────────────────────────────

const { availableBatchStatusSqlList } = require('./stock-status.js');

const CORRECTABLE_FIELDS = new Set(['ek', 'vk']);

/** Reine Validierung. value muss eine endliche Zahl > 0 sein; field ∈ {ek,vk}. */
function validateCorrection({ field, value, productId } = {}) {
  const errors = [];
  if (!CORRECTABLE_FIELDS.has(String(field))) errors.push('field muss "ek" oder "vk" sein');
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) errors.push('value muss eine Zahl > 0 sein');
  if (!(Number.isFinite(Number(productId)) && Number(productId) > 0)) errors.push('productId erforderlich');
  return { ok: errors.length === 0, errors, value: n };
}

const EK_UPDATE_SQL = `
  UPDATE automatenlager.stock_batches
     SET unit_cost_net = $2::numeric, updated_at = now()
   WHERE tenant_id = $1 AND product_id = $3::bigint
     AND status IN (${availableBatchStatusSqlList()}) AND remaining_qty > 0`;

const VK_UPDATE_SQL = `
  UPDATE automatenlager.prices
     SET sale_price_gross = $2::numeric
   WHERE tenant_id = $1 AND valid_to IS NULL
     AND slot_assignment_id IN (
       SELECT slot_assignment_id FROM automatenlager.slot_assignments
        WHERE tenant_id = $1 AND product_id = $3::bigint AND active = TRUE)`;

/** EK (unit_cost_net) der aktiven Chargen des Produkts korrigieren. go-forward. */
async function applyEkCorrection(db, tenant, { productId, unitCostNet } = {}) {
  return db.tx(tenant, async (door) => {
    const r = await door.write({ tables: ['stock_batches'], text: EK_UPDATE_SQL, params: [unitCostNet, productId] });
    return { batchesUpdated: r.rowCount || 0 };
  });
}

/** VK (sale_price_gross) der aktiven Preiszeilen der aktiven Slots korrigieren. go-forward. */
async function applyVkCorrection(db, tenant, { productId, salePriceGross } = {}) {
  return db.tx(tenant, async (door) => {
    const r = await door.write({ tables: ['prices', 'slot_assignments'], text: VK_UPDATE_SQL, params: [salePriceGross, productId] });
    return { pricesUpdated: r.rowCount || 0 };
  });
}

module.exports = { validateCorrection, applyEkCorrection, applyVkCorrection, CORRECTABLE_FIELDS, EK_UPDATE_SQL, VK_UPDATE_SQL };
