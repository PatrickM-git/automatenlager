'use strict';

/**
 * Produkt-Katalog für die Sortiment-/Slot-Palette (Issue v3 Folgefix #5).
 *
 * Anders als die Refill-Suche (`refill.js`), die nur Produkte auf AKTIVEN Slots
 * liefert, speist dieser Katalog die Palette aus ALLEN Produkten des Stamms.
 * Erst dadurch lassen sich Produkte zuweisen, die noch auf keinem Slot liegen
 * (z. B. „Twix Original"). Reine Funktion ohne DB-Abhängigkeit (testbar); die
 * SQL-Abfrage im Server liest `automatenlager.products` ohne Slot-Join.
 *
 * Anzeigename wie überall über `formatProductName` (SKU_… → „Klartext"); fehlt
 * der Name, wird die Produkt-ID als letzter Fallback gezeigt.
 */

const { formatProductName } = require('./economics.js');

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function buildProductCatalog(rows, query) {
  const q = clean(query).toLowerCase();
  const items = (rows || [])
    .map((row) => {
      const name = formatProductName(clean(row.name)) || String(row.product_id ?? '');
      return {
        product_id: Number(row.product_id),
        product_key: row.product_key != null ? row.product_key : null,
        name,
        label: name,
      };
    })
    .filter((it) => it.product_id);

  const filtered = q
    ? items.filter((it) =>
        it.name.toLowerCase().includes(q)
        || String(it.product_key || '').toLowerCase().includes(q))
    : items;

  return filtered.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

module.exports = { buildProductCatalog };
