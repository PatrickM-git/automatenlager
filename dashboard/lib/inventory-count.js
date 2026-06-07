'use strict';

/**
 * Inline-Inventur: Lager-Chargenrest auf den gezählten Ist-Wert setzen (Issue #152).
 *
 * Setzt `stock_batches.remaining_qty` einer Charge auf den physisch gezählten
 * Lagerbestand. Ändert AUSSCHLIESSLICH `remaining_qty` (das Lager, das nur der
 * Betreiber kennt) — NIEMALS `machine_qty` („Im Automaten", das ist Nayax-
 * gesteuert). Analog `lib/write-off.js`, aber OHNE Status-Wechsel und OHNE
 * stock_movement: reine Mengen-Korrektur + Audit.
 *
 * Reine Funktionen — testbar ohne DB. Die Transaktion liegt im Endpoint
 * POST /api/v2/inventory/set-count (durch die Mandanten-Tür, db.tx).
 */

const { isAvailableBatchStatus } = require('./stock-status.js');

function clean(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Validiert den Request. new_qty muss eine ganze Zahl >= 0 sein; die Obergrenze
 * (initial_qty) wird erst gegen die DB-Zeile in canSetCount geprüft.
 */
function validateInventoryCount(input) {
  const batch_key = clean(input && input.batch_key);
  const raw = input && input.new_qty;
  const errors = [];
  if (!batch_key) errors.push({ field: 'batch_key', message: 'batch_key erforderlich.' });
  const n = Number(raw);
  const validNum = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
  if (!validNum) errors.push({ field: 'new_qty', message: 'new_qty muss eine ganze Zahl >= 0 sein.' });
  return { valid: errors.length === 0, errors, batch_key, new_qty: validNum ? n : null };
}

/**
 * Prüft gegen die SELECT … FOR UPDATE-Zeile, ob gesetzt werden darf.
 *   - NOT_FOUND: Charge existiert nicht (oder fremder Mandant ⇒ tenant-gefiltert unsichtbar)
 *   - ALREADY_WRITTEN_OFF: Status nicht mehr verfügbar (ausgesondert/leer) ⇒ via write-off behandeln
 *   - OUT_OF_RANGE: new_qty < 0 oder > initial_qty (mehr als gekauft kann nicht im Lager sein)
 *   - DRIFT: erwarteter remaining_qty stimmt nicht mit der DB überein (optimistic lock)
 */
function canSetCount(batch, newQty, expectedRemainingQty) {
  if (!batch) return { ok: false, code: 'NOT_FOUND' };
  if (!isAvailableBatchStatus(batch.status)) return { ok: false, code: 'ALREADY_WRITTEN_OFF' };
  const initial = Number(batch.initial_qty) || 0;
  const remaining = Number(batch.remaining_qty) || 0;
  if (!Number.isInteger(newQty) || newQty < 0 || newQty > initial) {
    return { ok: false, code: 'OUT_OF_RANGE', initial_qty: initial };
  }
  if (expectedRemainingQty != null && expectedRemainingQty !== '' && Number(expectedRemainingQty) !== remaining) {
    return { ok: false, code: 'DRIFT', remaining_qty: remaining };
  }
  return { ok: true, remaining_qty: remaining, initial_qty: initial };
}

/**
 * Setzt remaining_qty DURCH die Mandanten-Tür, atomar in db.tx. SELECT … FOR UPDATE
 * + UPDATE mandantengebunden (tenant_id = $1): eine fremde Charge ist im tenant-
 * gefilterten SELECT unsichtbar ⇒ NOT_FOUND, keine Änderung an fremden Daten.
 * machine_qty wird NICHT angefasst. Geschäftliche Ablehnungen werden als codierter
 * Fehler geworfen (ROLLBACK); der Aufrufer mappt auf den HTTP-Status.
 * @returns {Promise<{ok:true, product_id:number|null, previous_qty:number, new_qty:number}>}
 */
async function setBatchCountPg(db, tenant, batchKey, newQty, expectedRemaining) {
  return db.tx(tenant, async (door) => {
    const sel = await door.read({
      tables: ['stock_batches'],
      text:
        `SELECT sb.batch_id, sb.product_id, sb.remaining_qty, sb.initial_qty, sb.status
           FROM automatenlager.stock_batches sb
          WHERE sb.tenant_id = $1 AND sb.batch_key = $2
          FOR UPDATE`,
      params: [batchKey],
    });
    const batch = sel.rows[0] || null;
    const verdict = canSetCount(batch, newQty, expectedRemaining);
    if (!verdict.ok) {
      const err = new Error(verdict.code);
      err.code = verdict.code; // NOT_FOUND | ALREADY_WRITTEN_OFF | OUT_OF_RANGE | DRIFT
      err.verdict = verdict;
      throw err; // ⇒ ROLLBACK, keine Teil-Schreibung
    }
    const prev = verdict.remaining_qty;
    await door.write({
      tables: ['stock_batches'],
      text:
        `UPDATE automatenlager.stock_batches sb
            SET remaining_qty = $3, updated_at = now()
          WHERE sb.tenant_id = $1 AND sb.batch_id = $2`,
      params: [batch.batch_id, newQty],
    });
    return { ok: true, product_id: Number(batch.product_id) || null, previous_qty: prev, new_qty: newQty };
  });
}

function buildInventoryCountAuditEntry(viewer, input, result) {
  return {
    timestamp: new Date().toISOString(),
    actor: (viewer && viewer.login) || 'unknown',
    action: 'inventory_set_count',
    batch_key: clean(input && input.batch_key),
    product_id: result && result.product_id != null ? result.product_id : null,
    previous_qty: result && result.previous_qty != null ? result.previous_qty : null,
    new_qty: result && result.new_qty != null ? result.new_qty : null,
    ok: !!(result && result.ok),
    message: (result && result.message) || '',
  };
}

module.exports = {
  validateInventoryCount,
  canSetCount,
  setBatchCountPg,
  buildInventoryCountAuditEntry,
};
