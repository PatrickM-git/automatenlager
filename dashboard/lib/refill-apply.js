'use strict';

/**
 * WF7 Nachfüllung — In-Process-Port (Issue #162, Stufe 6 Slice 2).
 *
 * Ersetzt den `fetch(/webhook/nachfuellung)`-Trigger auf n8n-WF7. Der
 * Schreibpfad läuft durch die Mandanten-Tür (`db.tx`):
 *   1. slot_assignments.current_machine_qty = newQty (Direkt-SQL)
 *   2. warnings: offene auflösbare Hinweise resolve + NACHFUELLUNG-Audit INSERT
 *   3. stock_movement via `automatenlager.pgw_write('stock_movement', …)` —
 *      identische DB-seitige Logik wie der bisherige WF7 → WF-PGW-Pfad, jetzt
 *      In-Process und innerhalb der RLS-gescopeten Transaktion.
 *
 * `computeRefillPlan` ist die REINE Logik (kein DB). Verhaltensgetreu abgeleitet
 * aus der authoritativen Mini-WF7-Definition:
 *   - newQty = qty!=null ? min(qty, capacity) : capacity
 *   - stock_movement (movement_type 'refill') nur bei delta>0 + FIFO-Charge
 *     (älteste MHD, dann batch_key)
 *   - resolvable Warnungstypen: EMPTY_BATCH, LOW_STOCK, INSUFFICIENT_BATCH_STOCK, LOW_BATCH
 */

const { isAvailableBatchStatus, availableBatchStatusSqlList } = require('./stock-status.js');

const RESOLVABLE_WARNING_TYPES = ['EMPTY_BATCH', 'LOW_STOCK', 'INSUFFICIENT_BATCH_STOCK', 'LOW_BATCH'];

function clean(value) {
  return String(value == null ? '' : value).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function num(value) {
  const n = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function sanitize(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Wählt die FIFO-Charge für einen product_key: verfügbarer Status, remaining>0,
 * sortiert nach MHD (älteste zuerst), dann batch_key. Gibt null zurück, wenn keine.
 */
function pickFifoBatch(batches, productKey) {
  const pk = clean(productKey);
  return (batches || [])
    .filter((b) => clean(b.product_key) === pk)
    .filter((b) => isAvailableBatchStatus(b.status))
    .filter((b) => (num(b.remaining_qty) ?? 0) > 0)
    .sort((a, b) => clean(a.mhd_date).localeCompare(clean(b.mhd_date)) || clean(a.batch_key).localeCompare(clean(b.batch_key)))[0] || null;
}

/**
 * Reine Logik: aus Slot + Chargen + offenen Warnungen + Menge den Schreibplan
 * ableiten. Keine DB-Zugriffe — vollständig unit-testbar.
 */
function computeRefillPlan({ slot, batches = [], openWarnings = [], qty = null, notes = '', nowIso } = {}) {
  if (!slot || !slot.product_slot_key) {
    throw new Error('computeRefillPlan: slot mit product_slot_key erforderlich');
  }
  const at = nowIso || new Date().toISOString();
  const capacity = num(slot.machine_capacity) ?? 0;
  const current = num(slot.current_machine_qty) ?? 0;
  const qtyIn = qty == null || qty === '' ? null : num(qty);
  const newQty = qtyIn !== null ? Math.min(qtyIn, capacity) : capacity;
  const delta = newQty - current;
  const productName = clean(slot.product_name || slot.product_key || slot.product_slot_key);

  const slotUpdate = {
    product_slot_key: clean(slot.product_slot_key),
    current_machine_qty: newQty,
    last_stock_update_source: 'WF6_NACHFUELLUNG',
    last_stock_update_at: at,
  };

  const resolveWarningKeys = (openWarnings || [])
    .filter((w) => RESOLVABLE_WARNING_TYPES.includes(clean(w.warning_type)))
    .map((w) => clean(w.warning_key))
    .filter(Boolean);

  const message = `Nachfüllung erfasst für ${productName}. Slot aktualisiert: ${clean(slot.product_slot_key)}=${newQty}`
    + (clean(notes) ? `. Bemerkung: ${clean(notes)}` : '');

  const auditWarning = {
    warning_type: 'NACHFUELLUNG',
    severity: 'info',
    message,
    product_key: clean(slot.product_key),
    machine_key: clean(slot.machine_key),
    resolved: true,
    created_at: at,
  };

  let stockMovement = null;
  if (delta > 0) {
    const batch = pickFifoBatch(batches, slot.product_key);
    if (batch) {
      const dateStr = at.slice(0, 10);
      const movementKey = ['MOV', 'REFILL', slot.product_slot_key, batch.batch_key, dateStr, delta]
        .map(sanitize).join('_');
      stockMovement = {
        event_type: 'stock_movement',
        batch_run_id: `wf7_${dateStr}`,
        data: {
          movement_key: movementKey,
          batch_key: clean(batch.batch_key),
          product_slot_key: clean(slot.product_slot_key),
          movement_type: 'refill',
          quantity_delta_total: 0,
          quantity_delta_slot: delta,
          reason: message,
          source: 'wf7_nachfuellung',
          occurred_at: at,
        },
      };
    }
  }

  return {
    slotUpdate,
    resolveWarningKeys,
    auditWarning,
    stockMovement,
    summary: {
      slots_updated: 1,
      hints_resolved: resolveWarningKeys.length,
      delta,
    },
  };
}

/**
 * In-Process-Schreibpfad WF7 durch die Mandanten-Tür (`db.tx`). Ersetzt den
 * `fetch(/webhook/nachfuellung)`-Aufruf. ALLE Schreibzugriffe in EINER
 * Transaktion (TOCTOU-Schutz + RLS-GUC einmal gesetzt).
 *
 * @param {object} db   tenant-db-Tür (createTenantDb / forViewer) mit tx()
 * @param {string} tenant Mandant
 * @param {object} input { machineKey, mdbCode, productId, qty, notes, nowIso }
 * @returns {Promise<{ok, code?, slots_updated, hints_resolved, stock_movement, product_slot_key?, new_qty?}>}
 */
async function applyRefill(db, tenant, { machineKey, mdbCode, productId, qty = null, notes = '', nowIso } = {}) {
  if (!db || typeof db.tx !== 'function') throw new TypeError('applyRefill: db mit tx() erforderlich');
  const at = nowIso || new Date().toISOString();
  return db.tx(tenant, async (door) => {
    // 1) Aktiven Slot + Kontext auflösen (machine_key + mdb_code + product_id).
    const slotRes = await door.read({
      tables: ['slot_assignments', 'machines', 'products'],
      text: `SELECT sa.product_slot_key, sa.current_machine_qty, sa.machine_capacity,
                    sa.product_id, sa.machine_id,
                    p.product_key, p.name AS product_name, m.machine_key
               FROM automatenlager.slot_assignments sa
               JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
               JOIN automatenlager.products  p ON p.product_id  = sa.product_id
              WHERE sa.tenant_id = $1 AND m.machine_key = $2 AND sa.mdb_code = $3
                AND sa.product_id = $4 AND sa.active = TRUE
              ORDER BY sa.valid_from DESC NULLS LAST
              LIMIT 1`,
      params: [String(machineKey), Number(mdbCode), Number(productId)],
    });
    if (!slotRes.rows.length) {
      return { ok: false, code: 'SLOT_NOT_FOUND', slots_updated: 0, hints_resolved: 0, stock_movement: false };
    }
    const slot = slotRes.rows[0];

    // 2) Verfügbare Chargen des Produkts (FIFO-Basis).
    const batchRes = await door.read({
      tables: ['stock_batches', 'products'],
      text: `SELECT sb.batch_key, p.product_key, sb.remaining_qty,
                    to_char(sb.mhd_date,'YYYY-MM-DD') AS mhd_date, sb.status
               FROM automatenlager.stock_batches sb
               JOIN automatenlager.products p ON p.product_id = sb.product_id
              WHERE sb.tenant_id = $1 AND p.product_key = $2
                AND sb.status IN (${availableBatchStatusSqlList()}) AND sb.remaining_qty > 0`,
      params: [slot.product_key],
    });

    // 3) Offene Warnungen des Produkts (resolvable-Filter passiert in der reinen Logik).
    const warnRes = await door.read({
      tables: ['warnings', 'products'],
      text: `SELECT w.warning_key, w.warning_type
               FROM automatenlager.warnings w
               JOIN automatenlager.products p ON p.product_id = w.product_id
              WHERE w.tenant_id = $1 AND p.product_key = $2 AND w.resolved = FALSE`,
      params: [slot.product_key],
    });

    const plan = computeRefillPlan({
      slot, batches: batchRes.rows, openWarnings: warnRes.rows, qty, notes, nowIso: at,
    });

    // 4) Slot-Update (verhaltensgetreu: NUR current_machine_qty, wie WF7s Postgres-Node).
    await door.write({
      tables: ['slot_assignments'],
      text: `UPDATE automatenlager.slot_assignments
                SET current_machine_qty = $2
              WHERE tenant_id = $1 AND product_slot_key = $3`,
      params: [plan.slotUpdate.current_machine_qty, plan.slotUpdate.product_slot_key],
    });

    // 5) Offene auflösbare Warnungen resolve.
    let hintsResolved = 0;
    if (plan.resolveWarningKeys.length) {
      const r = await door.write({
        tables: ['warnings'],
        text: `UPDATE automatenlager.warnings
                  SET resolved = TRUE, resolved_at = NOW()
                WHERE tenant_id = $1 AND warning_key = ANY($2) AND resolved = FALSE`,
        params: [plan.resolveWarningKeys],
      });
      hintsResolved = r.rowCount || 0;
    }

    // (Kein warnings-Audit-INSERT: WF7s 'NACHFUELLUNG'-Audit verletzt den aktuellen
    //  CHECK-Constraint warnings_warning_type_check (NACHFUELLUNG ist KEIN erlaubter
    //  Typ) und schlägt produktiv still fehl. Das Audit liegt korrekt im JSONL
    //  refill-actions.jsonl des Endpunkts (buildRefillAuditEntry). Bewusste, in der
    //  HANDOVER dokumentierte Abweichung vom toten Original-Node.)

    // 6) stock_movement (faithful zum pgw_write-Zweig: batch_key→batch_id,
    //    product_slot_key→slot_assignment_id, ON CONFLICT(movement_key) DO NOTHING) —
    //    direkt durch die Tür mit EXPLIZITEM tenant_id (RLS-sauber, kein BYPASS).
    let stockMovement = false;
    if (plan.stockMovement) {
      const d = plan.stockMovement.data;
      const mv = await door.write({
        tables: ['stock_movements'],
        text: `INSERT INTO automatenlager.stock_movements
                 (movement_key, batch_id, slot_assignment_id, movement_type,
                  quantity_delta_total, quantity_delta_slot, reason, source, occurred_at, tenant_id)
               SELECT $2, sb.batch_id, sa.slot_assignment_id, $5, $6::integer, $7::integer, $8, $9, $10::timestamptz, $1
                 FROM automatenlager.stock_batches sb
                 LEFT JOIN automatenlager.slot_assignments sa
                        ON sa.product_slot_key = $4 AND sa.tenant_id = $1
                WHERE sb.batch_key = $3 AND sb.tenant_id = $1
                LIMIT 1
               ON CONFLICT (movement_key) DO NOTHING`,
        params: [d.movement_key, d.batch_key, d.product_slot_key, d.movement_type,
          d.quantity_delta_total, d.quantity_delta_slot, d.reason, d.source, d.occurred_at],
      });
      stockMovement = (mv.rowCount || 0) > 0;
    }

    return {
      ok: true,
      slots_updated: 1,
      hints_resolved: hintsResolved,
      stock_movement: stockMovement,
      product_slot_key: slot.product_slot_key,
      new_qty: plan.slotUpdate.current_machine_qty,
    };
  });
}

module.exports = {
  RESOLVABLE_WARNING_TYPES,
  computeRefillPlan,
  pickFifoBatch,
  applyRefill,
};
