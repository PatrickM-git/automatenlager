'use strict';

/**
 * WF3 (#39): Ersatz des Google-Sheets-Reads "Produkte lesen" durch einen
 * PostgreSQL-Read im Verkaufs-Matching-Pfad (SQL-only-Migration, Schwester
 * von WF4/#14 und WF5/#41).
 *
 * WF3 matcht Nayax-Verkäufe gegen den Produktstand und liest dafür die
 * Produkt-Stammdaten + den primären Nayax-Alias. Solange das aus dem "Produkte"-
 * Sheet kam, drifteten neu in PG angelegte Slots (z. B. Haribo Goldbären MDB 34)
 * weg -> `UNKNOWN_PRODUCT`, 0 € Umsatz. WF3 verbraucht dieselbe Datenform wie WF4
 * (`Code - FIFO berechnen` liest nayax_product_name / internal_product_name /
 *  product_key / product_slot_id / machine_id / mdb_code / active "TRUE|FALSE"),
 * deshalb wird der verifizierte Read-Vertrag aus `wf4-product-reads.js`
 * wiederverwendet (eine Quelle der Wahrheit für das Mapping).
 *
 * WICHTIG für WF3: `buildProductsReadQuery` nimmt den Nayax-Alias mit
 * `source='nayax' AND is_primary=TRUE` — das ist der NAME ("Haribo Goldbären"),
 * NICHT der numerische NayaxProductID-Alias (`source='nayax_id'`). Andernfalls
 * stünde im `nayax_product_name` eine Zahl und WF3s `namesMatch` würde brechen.
 *
 * Nicht Teil von #39: Lagerchargen-/Transaktions-/Workflow-State-Reads und alle
 * Sheet-Writes bleiben unverändert (schrittweise Migration, FIFO unangetastet).
 */

const {
  mapProductsRows,
  buildProductsReadQuery,
} = require('./wf4-product-reads.js');

module.exports = {
  mapProductsRows,
  buildProductsReadQuery,
};
