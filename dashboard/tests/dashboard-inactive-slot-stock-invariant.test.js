'use strict';

// Issue #21 (Folge) — SQL-Contract-Guard für das read-side Bestands-Invariant.
//
//   "Jede Query, die slot_assignments.current_machine_qty als VERFÜGBAREN
//    Maschinen-/Restbestand liest, MUSS auf active = TRUE filtern."
//
// Hintergrund: Ein physisch entnommener Artikel kann eine inaktive Slotzeile
// (active = FALSE) mit current_machine_qty > 0 hinterlassen. current_machine_qty
// stammt aus dem "Produkte"-Sheet und wird per Workflow nach PG gespiegelt —
// ein PG-seitiges Nullen würde durch den nächsten Sync wieder überschrieben
// (Sheet↔PG-Drift), und ein Sheet-Patch ist per Projektregel ausgeschlossen.
// Deshalb wird der "Geisterbestand" read-side gelöst: inaktive Slots werden in
// den Bestands-/Restmengen-Queries gar nicht erst mitgezählt. Dieser Guard
// nagelt das fest, damit kein künftiger Refactor den active-Filter still
// entfernt. Vollständige Begründung: docs/data-model/remaining-qty-semantics.md.
//
// Der Guard prüft Quelltext-Artefakte (wie tests/encoding-umlaut-fix.test.js),
// nicht eine laufende DB.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(DASHBOARD_ROOT, rel), 'utf8');

// active = TRUE / active = true (mit oder ohne sa.-Prefix)
const ACTIVE_FILTER = /(?:sa\.)?active\s*=\s*(?:TRUE|true)/;

// Bestands-Queries: jede MUSS current_machine_qty lesen UND active filtern.
// `anchor` ist ein stabiler Schnipsel der konkreten Query; verschwindet er,
// schlägt der Test laut an (Query verschoben/umbenannt → Guard neu prüfen),
// statt still durchzulaufen.
const STOCK_QUERIES = [
  { file: 'lib/inventory-mhd.js', anchor: 'AS backstock_qty' },
  { file: 'lib/overview-monitoring.js', anchor: 'FROM automatenlager.slot_assignments sa' },
  { file: 'lib/assortment-slots.js', anchor: 'FROM automatenlager.slot_assignments sa' },
  { file: 'lib/nayax-abgleich.js', anchor: 'AS current_machine_qty' },
];

for (const q of STOCK_QUERIES) {
  test(`Bestands-Query in ${q.file} schließt inaktive Slots aus (active-Filter)`, () => {
    const src = read(q.file);
    assert.ok(
      src.includes(q.anchor),
      `Anker "${q.anchor}" nicht mehr in ${q.file} gefunden — Bestands-Query verschoben/umbenannt? Guard manuell prüfen.`,
    );
    assert.ok(
      src.includes('current_machine_qty'),
      `${q.file} liest current_machine_qty nicht mehr — Guard manuell prüfen.`,
    );
    assert.match(
      src,
      ACTIVE_FILTER,
      `${q.file}: slot_assignments-Bestands-Query ohne active-Filter → inaktive Slots würden als Bestand mitgezählt (Geisterbestand).`,
    );
  });
}

// server.js führt mehrere slot_assignments-Queries. Die beiden Refill-Queries
// (Suche + Details) MÜSSEN active = true filtern; die Slot-Wechsel-Preview
// (Einzel-Lookup per Schlüssel, kein Bestands-Aggregat) ist bewusst ausgenommen
// und filtert über die dynamische ${whereClause}.
test('server.js: beide Refill-Slot-Queries schließen inaktive Slots aus', () => {
  const src = read('server.js');
  const blocks = src.match(/FROM automatenlager\.slot_assignments sa[\s\S]{0,400}?active\s*=\s*true/gi) || [];
  assert.ok(
    blocks.length >= 2,
    `Erwartet >= 2 Refill-Slot-Queries mit active = true, gefunden ${blocks.length}. Ein Bestands-Read ohne active-Filter würde inaktive Slots mitzählen.`,
  );
});

// Dokumentierte Ausnahme: WF4-Reads spiegeln das append-only "Produkte"-Sheet
// bewusst inklusive inaktiver Zeilen (KEINE Bestandsanzeige). Wir pinnen, dass
// das eine bewusste Ausnahme bleibt — wird sie zur Bestandsanzeige umgewidmet,
// muss zuerst die Invariant-Doku angefasst werden.
test('wf4-product-reads bleibt bewusster Sheet-Spiegel (aktiv + inaktiv)', () => {
  const src = read('lib/wf4-product-reads.js');
  assert.ok(src.includes('sa.active'), 'WF4-Reads sollten active als Spalte mitführen (Sheet-Spiegel).');
  assert.ok(src.includes('append-only'), 'Doku-Kommentar zum append-only Sheet-Spiegel fehlt — Invariant-Doku prüfen.');
});
