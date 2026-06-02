'use strict';

/**
 * WF5 (#41): Ersatz des Google-Sheets-Reads "Lagerchargen lesen" durch einen
 * PostgreSQL-Read aus `stock_batches` (SQL-only-Migration, Schwester von
 * WF3/#39 und WF4/#14).
 *
 * Problem: WF5 ("Automatenlager Check"-Mail) las die Lagerchargen aus dem Sheet.
 * Write-offs (#21) wurden PG-direkt geschrieben (status='ausgesondert'), das
 * Sheet nie nachgezogen -> ausgebuchte Chargen (Nick Nacks, Twix salted caramel)
 * standen im Sheet noch als 'aktiv' und wurden weiter als "MHD abgelaufen"
 * gemeldet. Aus PG gelesen verschwinden sie korrekt.
 *
 * Verfügbar-Status: zentrale `stock-status.js` (aktiv/active/reserve).
 * 'ausgesondert'/'leer'/'wartet_nachkauf' werden ausgeschlossen — konsistent
 * zur Dashboard-/MHD-Sicht (`inventory-mhd.js`).
 *
 * WICHTIG (Sheet-Treue): WF5s `Code - MHD und Lagercharge pruefen` lässt pro
 * Charge nur Status in ['aktiv','leer'] durch (sonst `continue`). Die PG-Status
 * 'active' und 'reserve' werden deshalb auf 'aktiv' normalisiert, sonst würden
 * verfügbare Chargen (z. B. die Pick-Up-reserve-Charge, 22 Stk.) fälschlich
 * übersprungen. Das MHD-Datum kommt aus der Spalte `mhd_date` (nicht `mhd`).
 *
 * Nicht Teil von #41: Hinweis-Schreibpfad + Auflöse-Logik bleiben unverändert.
 */

const { availableBatchStatusSqlList } = require('./stock-status.js');
const { toIsoDate } = require('./inventory-mhd.js');

function s(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Lagerchargen-Read ("Lagerchargen lesen"-Ersatz). Eine Zeile je verfügbare
 * Charge mit genau den Spalten, die `mapLagerchargenRows` konsumiert. Optional
 * je Nayax-Maschinennummer gefiltert (parametrisch, kein Hardcode); ohne
 * machineKey alle verfügbaren Chargen (Lagerchargen sind nicht zwingend einem
 * Slot zugeordnet -> Filter per LEFT JOIN, damit ungebundene Chargen nicht
 * verloren gehen).
 * @param {{machineKey?: string}} [opts]
 * @returns {{text: string, values: any[]}}
 */
function buildLagerchargenReadQuery(opts = {}) {
  const raw = opts.machineKey;
  const machineKey = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
  const values = machineKey ? [machineKey] : [];
  const where = machineKey
    ? `AND (m.machine_key = $1 OR m.machine_key IS NULL)`
    : '';

  const text = `
    SELECT
      sb.batch_id        AS batch_id,
      sb.batch_key       AS batch_key,
      p.product_key      AS product_key,
      p.name             AS product_name,
      sb.status          AS status,
      sb.mhd_date        AS mhd_date,
      sb.remaining_qty   AS remaining_qty
    FROM automatenlager.stock_batches sb
    JOIN automatenlager.products p ON p.product_id = sb.product_id
    LEFT JOIN automatenlager.slot_assignments sa
      ON sa.product_id = p.product_id AND sa.active = TRUE
    LEFT JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
    WHERE sb.status IN (${availableBatchStatusSqlList()})
      ${where}
    ORDER BY p.name, sb.mhd_date ASC NULLS LAST`;

  return { text, values };
}

// Alle verfügbaren PG-Status werden auf 'aktiv' normalisiert: WF5 zählt sie als
// aktiven Bestand (Filter ['aktiv','leer']). Schon-'aktiv' bleibt 'aktiv'.
function normalizeStatus() {
  return 'aktiv';
}

/**
 * Rohe stock_batches-Rows -> Sheet-Schema "Lagerchargen", wie WF5 es konsumiert.
 * Google Sheets liefert nur Strings -> wir normalisieren ebenso auf Strings.
 * `batch_id` trägt den string-`batch_key` (der Charge-Bezeichner, den das Sheet
 * führte und den WF5 als Dedup-Anker für Alerts nutzt).
 */
function mapLagerchargenRows(rows) {
  return (rows || []).map((row) => ({
    batch_id: s(row.batch_key != null ? row.batch_key : row.batch_id),
    product_key: s(row.product_key),
    product_name: s(row.product_name),
    status: normalizeStatus(row.status),
    mhd: toIsoDate(row.mhd_date),
    remaining_qty: s(row.remaining_qty),
  }));
}

module.exports = {
  buildLagerchargenReadQuery,
  mapLagerchargenRows,
};
