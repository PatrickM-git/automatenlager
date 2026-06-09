'use strict';

/**
 * Einzige Quelle der Wahrheit: welche `warnings.warning_type`-Werte die DB
 * akzeptiert (CHECK `warnings_warning_type_check`). Verifiziert gegen die echte
 * Mini-DB (Pre-Flight). Schreiber, die früher nach Google Sheets schrieben
 * (WF3/WF4, kein Check), müssen auf diese Taxonomie mappen — sonst bricht der
 * INSERT (Befund Slice 2: NACHFUELLUNG/PICKLISTE_* verletzten den Check).
 */

const ALLOWED_WARNING_TYPES = new Set([
  'LOW_BATCH', 'MHD_NEAR', 'MHD_EXPIRED', 'CONTAINER_DOWN', 'PG_UNREACHABLE',
  'WORKFLOW_ERROR', 'AUTH_ERROR', 'BACKUP_STALE', 'BACKUP_FAIL', 'BACKUP_OK',
  'SCHEDULE_GAP', 'ERROR_RATE_SPIKE', 'WORKFLOW_DAILY_FAIL', 'UNMATCHED_PRODUCT',
  'UNKNOWN_PRODUCT', 'MDB_CODE_CHANGED_FOR_PRODUCT', 'LOW_STOCK', 'BACKSTOCK_OVERFLOW',
  'INSUFFICIENT_BATCH_STOCK', 'VALIDATION_DRIFT_SHEETS_PG',
]);

// Nicht-Taxonomie-Typen aus der Sheets-Ära auf erlaubte Typen abbilden, wo
// semantisch eindeutig. Alles andere ⇒ kein PG-Warnungs-INSERT (return null).
const WARNING_TYPE_MAP = {
  MHD_WARNING: 'MHD_NEAR',
  MDB_PRODUCT_MAPPING_MISMATCH: 'MDB_CODE_CHANGED_FOR_PRODUCT',
};

/**
 * @param {string} type Roh-Warnungstyp (Sheets-Ära oder bereits taxonomisch).
 * @returns {string|null} erlaubter warning_type ODER null (⇒ Warnung NICHT in PG schreiben).
 */
function toAllowedWarningType(type) {
  const t = String(type == null ? '' : type).trim().toUpperCase();
  if (ALLOWED_WARNING_TYPES.has(t)) return t;
  return WARNING_TYPE_MAP[t] || null;
}

module.exports = { ALLOWED_WARNING_TYPES, WARNING_TYPE_MAP, toAllowedWarningType };
