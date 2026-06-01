'use strict';

/**
 * Aussortieren / Ausbuchen einer Lagercharge (Issue #21).
 *
 * Wenn Ware physisch entnommen wird (z. B. MHD abgelaufen, Bruch, Schwund),
 * wird die Charge in `stock_batches` auf `status='ausgesondert'` gesetzt und
 * `remaining_qty=0` geschrieben. Der Status `ausgesondert` existiert bereits im
 * Datenmodell und wird von allen Bestands-Queries korrekt ausgeblendet
 * (siehe lib/stock-status.js). Schreibweg ist PG-direkt (kein Google-Sheet-Patch).
 *
 * Reine Funktionen — testbar ohne DB. Die eigentliche Transaktion liegt im
 * Endpoint POST /api/v2/inventory/write-off.
 */

const { isAvailableBatchStatus } = require('./stock-status.js');

const WRITE_OFF_STATUS = 'ausgesondert';

// Vorschlagsliste für die UI; freier Text bleibt erlaubt (nur nicht leer).
const WRITE_OFF_REASONS = [
  'MHD abgelaufen',
  'Bruch / Beschädigung',
  'Schwund',
  'Rückruf',
  'Sonstiges',
];

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function validateWriteOff(input) {
  const batch_key = clean(input && input.batch_key);
  const reason = clean(input && input.reason);
  const errors = [];
  if (!batch_key) errors.push({ field: 'batch_key', message: 'batch_key erforderlich.' });
  if (!reason) errors.push({ field: 'reason', message: 'Grund erforderlich.' });
  return { valid: errors.length === 0, errors, batch_key, reason };
}

/**
 * Prüft den aktuellen Charge-Zustand (aus SELECT … FOR UPDATE), ob ausgebucht
 * werden darf. Verhindert doppeltes/sinnloses Ausbuchen und macht die Aktion
 * idempotent.
 *   - NOT_FOUND: Charge existiert nicht
 *   - ALREADY_WRITTEN_OFF: Status zählt nicht mehr als verfügbar (z. B. schon ausgesondert/leer)
 *   - EMPTY: remaining_qty <= 0
 *   - DRIFT: erwartete Menge stimmt nicht mit der DB überein (optimistic lock)
 */
function canWriteOff(batch, expectedRemainingQty) {
  if (!batch) return { ok: false, code: 'NOT_FOUND' };
  if (!isAvailableBatchStatus(batch.status)) return { ok: false, code: 'ALREADY_WRITTEN_OFF' };
  const remaining = Number(batch.remaining_qty) || 0;
  if (remaining <= 0) return { ok: false, code: 'EMPTY' };
  if (expectedRemainingQty != null && expectedRemainingQty !== '' && Number(expectedRemainingQty) !== remaining) {
    return { ok: false, code: 'DRIFT', remaining_qty: remaining };
  }
  return { ok: true, remaining_qty: remaining };
}

function buildWriteOffAuditEntry(viewer, input, result) {
  return {
    timestamp: new Date().toISOString(),
    actor: (viewer && viewer.login) || 'unknown',
    action: 'inventory_write_off',
    batch_key: clean(input && input.batch_key),
    product_id: result && result.product_id != null ? result.product_id : null,
    reason: clean(input && input.reason),
    written_off_qty: result && result.written_off_qty != null ? result.written_off_qty : null,
    ok: !!(result && result.ok),
    message: (result && result.message) || '',
  };
}

module.exports = {
  WRITE_OFF_STATUS,
  WRITE_OFF_REASONS,
  validateWriteOff,
  canWriteOff,
  buildWriteOffAuditEntry,
};
