# `remaining_qty`-Semantik & Bestands-Modell

> Folgedokumentation zu **Issue #21** (Bestand aussortieren/ausbuchen).
> Erfüllt das Akzeptanzkriterium „`remaining_qty`-Semantik dokumentiert; kein
> neuer Sheet↔PG-Drift". Stand: 2026-06-01.

Dieses Dokument hält fest, was `stock_batches.remaining_qty` bedeutet, wo die
Interpretation im System **uneinheitlich** ist, und warum das Ausbuchen
(Aussortieren) bewusst **read-side** statt durch Daten-Mutation gelöst wird.

---

## 1. Das Feld

`automatenlager.stock_batches.remaining_qty` ist eine **pro-Charge**-Restmenge.
Eine Charge (`batch_key`) gehört zu genau einem `product_id`, trägt ein `mhd_date`
und einen Freitext-`status` (siehe [`dashboard/lib/stock-status.js`](../../dashboard/lib/stock-status.js)
für die als *verfügbar* zählenden Status-Werte).

Daneben existiert die **Maschinen-Menge** `slot_assignments.current_machine_qty`:
wie viele Stück physisch im Automaten-Slot liegen. Sie stammt aus dem
„Produkte"-Google-Sheet und wird per Workflow nach PostgreSQL gespiegelt.

> **Merksatz:** `remaining_qty` = Charge (Lager-/Bestands-Buchhaltung).
> `current_machine_qty` = was im Automaten steckt. Beide zusammen ergeben den
> physischen Gesamtbestand eines Produkts — *wenn* `remaining_qty` als
> Gesamt-Modell geführt wird (siehe unten).

---

## 2. Zwei widersprüchliche Interpretationen

Historisch wird `remaining_qty` an verschiedenen Stellen **unterschiedlich**
verstanden. Das ist die eigentliche Drift-Ursache (vgl. Issue #20/#21).

### a) Gesamt-Modell — „remaining_qty zählt Maschine **und** Lager"

- **WF3 (Nayax FIFO-Verkauf)** zieht bei *jedem Verkauf* von `remaining_qty` ab
  (`batch.remaining_qty = available - deduct`; bei `<= 0` → `status='leer'`).
  Verkäufe entnehmen physisch aus dem Automaten — wenn das `remaining_qty`
  reduziert, dann zählt `remaining_qty` die im Automaten liegende Ware mit.
- **`dashboard/lib/inventory-mhd.js`** rechnet konsistent dazu:
  `backstock_qty = SUM(remaining_qty) − current_machine_qty`
  (die Maschinen-Menge wird abgezogen, um den reinen **Lager-Rest** zu zeigen).

### b) Lager-Modell — „remaining_qty zählt **nur** das Lager (Backstock)"

- **`dashboard/lib/refill.js`** (`buildRefillDetails`) nimmt
  `totalBackstock = SUM(remaining_qty)` **ohne** Maschinen-Abzug —
  behandelt `remaining_qty` also direkt als Backstock-Menge.
- **WF7 (Nachfüllung melden)** setzt beim Nachfüllen `current_machine_qty`
  hoch und bucht eine **Refill-Movement** (Lager → Maschine) an die
  PG-Writer-Pipeline (`WF-PGW`). In einem reinen Lager-Modell sinkt dabei die
  Charge-Restmenge.

> **Konflikt:** Für dieselbe Charge liefert `inventory-mhd` (Gesamt-Modell) und
> `refill` (Lager-Modell) einen unterschiedlichen „Backstock". Je nach
> Charge-Historie (durchlief sie schon WF3-Verkäufe? schon WF7-Nachfüllungen?)
> bedeutet `remaining_qty` faktisch mal das eine, mal das andere.

---

## 3. Verbindliche Lesart (bis zur Reconciliation)

Bis ein dediziertes Reconciliation-/Datenmodell-Issue das vereinheitlicht, gilt
für **neue** Features:

1. **Maßgeblich ist das Gesamt-Modell** (WF3 + `inventory-mhd`): `remaining_qty`
   führt den Gesamtbestand der Charge; der Lager-Rest ist
   `remaining_qty − current_machine_qty` (nie negativ → `GREATEST(…,0)`).
2. **Keine neuen Stellen einführen, die `remaining_qty` direkt als Backstock
   anzeigen**, ohne `current_machine_qty` abzuziehen (sonst neuer Drift wie in
   `refill.js`).
3. **Schreibpfade auf `remaining_qty` müssen die Lesart respektieren.** Wer
   `remaining_qty` mutiert (z. B. Ausbuchen), muss wissen, ob er Gesamt- oder
   Lager-Menge schreibt.

---

## 4. Ausbuchen / Aussortieren (Issue #21)

Das Ausbuchen einer Charge (`POST /api/v2/inventory/write-off`,
[`dashboard/lib/write-off.js`](../../dashboard/lib/write-off.js)) setzt:

- `stock_batches.status = 'ausgesondert'`
- `stock_batches.remaining_qty = 0`

**PG-direkt, kein Google-Sheet-Patch** (Projektregel „keine automatischen
Lager-Patches"). Guard: `SELECT … FOR UPDATE` + optimistic lock über
`expected_remaining_qty`; Gäste erhalten `403`; jede Aktion landet im Audit-Log
(`dashboard/logs/writeoff-actions.jsonl`).

### Warum keine Mutation der inaktiven Slot-Menge?

Ein physisch entnommener Artikel kann eine **inaktive** Slotzeile
(`slot_assignments.active = FALSE`) mit `current_machine_qty > 0` hinterlassen
(Issue-#21-Beispiele: Nick Nacks Slot 21 = 5, Twix Slot 6 = 12).

Würde man diese Menge beim Ausbuchen in PG auf 0 setzen, kehrt der Drift zurück:
`current_machine_qty` stammt aus dem „Produkte"-Sheet und wird per Workflow
re-synchronisiert → der nächste Sync importiert die alte Menge wieder. Ein
Sheet-Patch ist per Projektregel ausgeschlossen.

**Entscheidung (2026-06-01): read-side statt Mutation.** Alle bestands- und
restmengen-anzeigenden Queries filtern bereits `active = TRUE` und zählen
inaktive Slots damit gar nicht erst mit. Das ist drift-frei (keine Daten-
Änderung, kein Sheet-Eingriff) und durch einen Regressions-Guard abgesichert
([`dashboard/tests/dashboard-inactive-slot-stock-invariant.test.js`](../../dashboard/tests/dashboard-inactive-slot-stock-invariant.test.js)).

#### Invariant

> Jede Query, die `slot_assignments.current_machine_qty` als verfügbaren
> Maschinen-/Restbestand liest, **muss** auf `active = TRUE` filtern.

Bewusste Ausnahmen (kein Bestands-Read):

| Stelle | Zweck |
|---|---|
| `lib/wf4-product-reads.js` | Spiegelt das append-only „Produkte"-Sheet (aktiv **und** inaktiv) für WF4 — keine Bestandsanzeige. |
| `server.js` Slot-Wechsel-Preview | Einzel-Slot-Lookup per Schlüssel (`slot_assignment_id` bzw. `machine_id+mdb_code`), kein Aggregat. |

---

## 5. Offen (separates Issue)

- **Reconciliation `remaining_qty`:** WF7-Lager-Modell und `refill.js` auf das
  Gesamt-Modell vereinheitlichen, damit der Backstock überall identisch
  gerechnet wird.
- **Sheet↔PG-Konvergenz:** Restmengen inaktiver Slots im „Produkte"-Sheet
  manuell bereinigen (nicht automatisiert — Projektregel).
