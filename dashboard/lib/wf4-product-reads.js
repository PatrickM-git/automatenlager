'use strict';

/**
 * WF4: Ersatz der zwei Google-Sheets-Reads durch PostgreSQL-Reads
 * (SQL-only-Migration Schritt 1, Issue #14, behebt #12).
 *
 * Das "Produkte"-Sheet mischt Stammdaten + Slot-Daten; in PG liegen die
 * Stammdaten in `products`, die Slot-Daten in `slot_assignments`, die
 * Nayax-Maschinennummer in `machines.machine_key` und der Nayax-Name als
 * `product_aliases`-Eintrag mit `source='nayax'`. Diese Map-Funktionen
 * überführen rohe DB-Rows in EXAKT das Sheet-Schema, damit der nachgelagerte
 * WF4-Code (der überall `clean()` aufruft) unverändert bleibt. Google Sheets
 * liefert nur Strings -> wir normalisieren ebenso auf Strings.
 */

function s(value) {
  return value == null ? '' : String(value).trim();
}

// boolean active -> Sheet-String ("TRUE"/"FALSE"); String wird durchgereicht
function activeToSheet(value) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return s(value);
}

/**
 * Read 1 ("Produkte lesen"): rohe Join-Rows -> Sheet-Schema je Slot.
 * Erwartete rohe Spalten (siehe buildProductsReadQuery):
 *   product_key, name, nayax_alias, mdb_code, machine_key, active,
 *   product_slot_key, sale_price_gross, current_machine_qty,
 *   machine_capacity, target_stock
 */
function mapProductsRows(rows) {
  return (rows || []).map((row) => ({
    product_key: s(row.product_key),
    internal_product_name: s(row.name),
    nayax_product_name: s(row.nayax_alias),
    mdb_code: s(row.mdb_code),
    machine_id: s(row.machine_key),
    active: activeToSheet(row.active),
    product_slot_id: s(row.product_slot_key),
    sale_price_eur: s(row.sale_price_gross),
    current_machine_qty: s(row.current_machine_qty),
    machine_capacity: s(row.machine_capacity),
    target_stock: s(row.target_stock),
  }));
}

/**
 * Read 2 ("Produkt_Aliase lesen"): rohe Join-Rows -> Sheet-Schema.
 * Erwartete rohe Spalten (siehe buildAliasesReadQuery): alias, product_key.
 */
function mapAliasesRows(rows) {
  return (rows || []).map((row) => ({
    alias_name: s(row.alias),
    product_key: s(row.product_key),
  }));
}

/**
 * Read 1 SQL ("Produkte lesen" Ersatz). Liefert eine Zeile je slot_assignment
 * (aktiv UND inaktiv — wie das append-only "Produkte"-Sheet; der WF4-Code
 * filtert selbst per isActive und braucht die historischen Zeilen). Die
 * LATERAL-Subqueries (max. 1 Zeile) verhindern Zeilen-Vervielfachung beim
 * Nayax-Alias und beim aktuellen Preis. Optional je Nayax-Maschinennummer
 * gefiltert (parametrisch, kein Hardcode -> multi-automaten-fähig).
 * @param {{machineKey?: string}} [opts]
 * @returns {{text: string, values: any[]}}
 */
function buildProductsReadQuery(opts = {}) {
  const raw = opts.machineKey;
  const machineKey = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
  const values = machineKey ? [machineKey] : [];
  const where = machineKey ? 'WHERE m.machine_key = $1' : '';

  const text = `
    SELECT
      p.product_key            AS product_key,
      p.name                   AS name,
      na.alias                 AS nayax_alias,
      sa.mdb_code              AS mdb_code,
      m.machine_key            AS machine_key,
      sa.active                AS active,
      sa.product_slot_key      AS product_slot_key,
      pr.sale_price_gross      AS sale_price_gross,
      sa.current_machine_qty   AS current_machine_qty,
      sa.machine_capacity      AS machine_capacity,
      sa.target_stock          AS target_stock
    FROM automatenlager.slot_assignments sa
    JOIN automatenlager.products p ON p.product_id = sa.product_id
    JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
    LEFT JOIN LATERAL (
      SELECT pa.alias
        FROM automatenlager.product_aliases pa
       WHERE pa.product_id = p.product_id
         AND pa.source = 'nayax'
         AND pa.is_primary = TRUE
       ORDER BY pa.alias
       LIMIT 1
    ) na ON TRUE
    LEFT JOIN LATERAL (
      SELECT pc.sale_price_gross
        FROM automatenlager.prices pc
       WHERE pc.slot_assignment_id = sa.slot_assignment_id
         AND pc.valid_to IS NULL
       ORDER BY pc.valid_from DESC
       LIMIT 1
    ) pr ON TRUE
    ${where}
    ORDER BY m.machine_key, sa.mdb_code, sa.active DESC`;

  return { text, values };
}

/**
 * Read 2 SQL ("Produkt_Aliase lesen" Ersatz). Alle Aliase mit ihrem
 * product_key (wie das Sheet), für das Alias-Scoring in WF4.
 * @returns {{text: string, values: any[]}}
 */
function buildAliasesReadQuery() {
  const text = `
    SELECT
      a.alias        AS alias,
      p.product_key  AS product_key
    FROM automatenlager.product_aliases a
    JOIN automatenlager.products p ON p.product_id = a.product_id
    ORDER BY p.product_key, a.alias`;

  return { text, values: [] };
}

module.exports = {
  mapProductsRows,
  mapAliasesRows,
  buildProductsReadQuery,
  buildAliasesReadQuery,
};
