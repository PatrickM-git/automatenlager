# Audit: Google Sheets → SQL Vollständigkeit (2026-06-04)

Status: Erster vollständiger Mapping-Durchgang · Issue #88

Grundlage: Code-Analyse (WF1–WF9, dashboard/lib/, db-schema.js),
Spec `docs/specs/sql-only-migration.md`, Live-Befunde aus vorangegangenen Sessions.

---

## Sheets-Inventar (alle aktiven Tabellenblätter)

| # | Sheet-Tab | Schreibt | Liest | PG-Entsprechung | Status |
|---|-----------|----------|-------|-----------------|--------|
| 1 | **Produkte** | WF2 (Stammdaten), WF4 (Slot) | WF3, WF4, WF5, WF9, WF-Val | `products`, `slot_assignments`, `prices` | ⚠ Teils |
| 2 | **Produkt_Aliase** | WF2 | WF3, WF4 | `product_aliases` | ✅ Vollständig (WF4 liest PG seit #14) |
| 3 | **Lagerchargen** | WF2 (anlegen), WF3 (FIFO-Abbuchung) | WF3, WF5, WF9, WF-Val | `stock_batches`, `stock_movements` | ⚠ Teils (Drift #87) |
| 4 | **Verarbeitete_Transaktionen** | WF3 | WF-Val | `sales_transactions` | ✅ PG-primär (WF3 schreibt PG first) |
| 5 | **GuV_Tagesposten** | WF8 | WF-Val | `guv_daily` | ✅ PG-primär (WF8 schreibt PG first) |
| 6 | **Hinweise** (WF9-Input) | WF9 (Hinweise auflösen) | WF9 | — | ❌ Nur Sheet |
| 7 | **Rechnungen** (WF1-Audit) | WF1 | WF1 | `invoices`, `invoice_items`, `suppliers` | ⚠ Teils |

---

## Domäne 1: Produkte

### Sheet-Felder → PG-Spalten

| Sheet-Feld | PG-Spalte | Tabelle | Status |
|------------|-----------|---------|--------|
| `product_key` (SKU) | `product_key` | `products` | ✅ |
| `product_name` / Klartext | `name` | `products` | ✅ (#5 erledigt) |
| `category` | `category` | `products` | ✅ (#62 erledigt) |
| `active` (Slot-Status) | `active` | `slot_assignments` | ✅ |
| `machine_id` (Nayax-Nr) | `machine_key` → FK | `machines` | ✅ |
| `mdb_code` | `mdb_code` | `slot_assignments` | ✅ |
| `target_stock` | `target_stock` | `slot_assignments` | ✅ |
| `current_machine_qty` | `current_machine_qty` | `slot_assignments` | ✅ (Nayax-Abgleich #17) |
| `price_gross` (VK brutto) | `sale_price_gross` | `prices` | ❌ **LEER** (kritisch) |
| Nayax-Alias | `alias` WHERE source='nayax' | `product_aliases` | ✅ |

### Lücken & Risiken

**`prices`-Tabelle ist leer.** Das Dashboard liest `prices.sale_price_gross` an mehreren Stellen
(assortment-slots, economics). Bisher liefert der Join kein Ergebnis → die Preisanzeige fehlt im
Sortiment. VK-Preise liegen im Sheet `Produkte.price_gross` und werden heute von WF3 aus dem Sheet
gelesen, um den Umsatz brutto zu berechnen.

**Folge-Issue benötigt:** `prices`-Tabelle befüllen (Migration Sheet `Produkte.price_gross` → PG `prices`).

---

## Domäne 2: Produkt_Aliase

### Status: ✅ ERLEDIGT

- WF4 liest Aliase seit #14 direkt aus PG (`product_aliases`)
- Backfill der `nayax_id`-Aliase (35 Stück) erfolgte in #18
- Sheet `Produkt_Aliase` ist jetzt **read-only Legacy-Spiegel**

**Nächster Schritt:** Sheet-Write in WF2 für neue Aliase auf PG-Write umstellen (niedrige Prio,
da Sheet-Reads schon eliminiert).

---

## Domäne 3: Lagerchargen

### Sheet-Felder → PG-Spalten

| Sheet-Feld | PG-Spalte | Tabelle | Status |
|------------|-----------|---------|--------|
| `batch_key` | `batch_key` | `stock_batches` | ✅ |
| `product_key` | `product_id` (über products) | `stock_batches` | ✅ |
| `initial_qty` | `initial_qty` | `stock_batches` | ✅ |
| `remaining_qty` | `remaining_qty` | `stock_batches` | ⚠ Driftet (#87) |
| `unit_cost` (EK netto) | `unit_cost_net` | `stock_batches` | ✅ (#51 erledigt) |
| `mhd_date` | `mhd_date` | `stock_batches` | ✅ |
| `status` | `status` | `stock_batches` | ✅ |
| `invoice_id` | `invoice_item_id` | `stock_batches` | ⚠ Teils NULL (manuelle Chargen) |
| `purchase_date` | — | — | ❌ **FEHLT in PG** |
| `supplier` | `supplier_id` (über suppliers) | `stock_batches` | ⚠ Kein Direkt-Link in stock_batches |
| `machine_id` (Lagerort) | — | — | ❌ **FEHLT in PG** (nur via slot_assignments erreichbar) |
| `notes` | `notes` | `stock_batches` | ✅ |

### Lücken & Risiken

1. **`remaining_qty` driftet** (Wurzel-#87): WF3 bucht FIFO ins Sheet, aber kein verlässlicher
   Abbuchpfad nach PG. Root-Fix = DB-Trigger `stock_movements → remaining_qty`.

2. **`purchase_date` fehlt in PG**: Kaufdatum je Charge nicht in `stock_batches`. Wäre relevant
   für Lieferfristenanalyse und Steuerberater-Export.

3. **Lagerort (Automat/Lager) fehlt**: Sheet hat `machine_id` je Charge für „wo liegt die Ware".
   In PG gibt es nur `slot_assignments.current_machine_qty` (wie viel im Automaten), aber kein
   `stock_batches.machine_id` (wo lagert der Rest). Bei mehreren Automaten / echtem Backstock
   wichtig.

4. **Write-Pfad noch Sheet-first**: WF2 schreibt neue Chargen ins Sheet, PGW spiegelt. Nach
   Cutover: WF2 schreibt direkt PGW/PG, Sheet fällt weg.

**Folge-Issues benötigt:**
- Root-Fix `remaining_qty` (separate Session, mit physischen Zählwerten)
- `purchase_date` + Lagerort-Spalte in `stock_batches` ergänzen
- WF2 Write-Pfad auf PG-first umstellen

---

## Domäne 4: Verarbeitete_Transaktionen

### Status: ✅ PG-PRIMÄR

- WF3 schreibt Transaktionen mit `UNIQUE nayax_transaction_id` in `sales_transactions`
- Dashboard liest ausschließlich aus PG
- Sheet `Verarbeitete_Transaktionen` = read-only Spiegel (WF-Val nutzt es für Drift-Check)

**Nächster Schritt:** WF-Val-Drift-Check auf PG↔PG umstellen; danach Sheet-Write aus WF3 entfernen.

---

## Domäne 5: GuV_Tagesposten

### Status: ✅ PG-PRIMÄR

- WF8 schreibt täglich in `guv_daily` (Dedup-Key `date|machine_id|product_key`)
- Dashboard liest nur PG
- Sheet `GuV_Tagesposten` = read-only Spiegel

**Nächster Schritt:** Sheet-Write aus WF8 entfernen (nur PG-Write behalten).

---

## Domäne 6: Hinweise / WF9 Pickliste

### Status: ❌ VOLLSTÄNDIG SHEET-ABHÄNGIG

WF9 liest und schreibt ausschließlich Google Sheets:
- Liest `Produkte` + `Lagerchargen` (noch Sheet-abhängig)
- Schreibt Slot-Updates und Hinweise zurück ins Sheet
- Kein PG-Write-Pfad

**Folge-Issue benötigt:** WF9-Refactoring auf PG-Reads + PG-Write. Ist ein eigenes System
(PDF-Parsing + Slot-Update via Claude), das komplett neu angebunden werden muss.
Scope: hoch. Priorität: nach Domäne 1+3.

---

## Domäne 7: Rechnungen (WF1/WF2)

### PG-Abdeckung

| Sheet-Konzept | PG-Tabelle | Status |
|---------------|------------|--------|
| Rechnungskopf | `invoices` | ✅ |
| Rechnungspositionen | `invoice_items` | ✅ |
| Lieferant | `suppliers` | ✅ |
| EK je Position | `invoice_items.unit_cost` | ✅ |
| Freigabe-Status | `invoices.status` | ✅ |

### Lücken

- WF1 schreibt Rechnungen **zuerst ins Sheet**, PGW spiegelt → Sheet noch Lead
- Einige `stock_batches.invoice_item_id` NULL (manuelle Chargen ohne Rechnung)
- Sheet hat UI-/Freigabe-Funktion (WF2 liest Sheet für Genehmigungsworkflow)

**Nächster Schritt (niedriger Prio):** WF1/WF2-Freigabe-Workflow ins Dashboard heben.

---

## Prioritäts-Reihenfolge Cutover

| Prio | Domäne | Blocker | Aufwand |
|------|--------|---------|---------|
| 1 | **prices-Tabelle befüllen** | VK-Preise nirgendwo in PG | Klein |
| 2 | **remaining_qty Root-Fix** (#87) | Drift → falsche Bestände | Mittel |
| 3 | **WF3 Sheet-Write entfernen** (TX, GuV) | Sheets noch beschrieben | Klein |
| 4 | **purchase_date + Lagerort in stock_batches** | Chargen-Info unvollständig | Klein |
| 5 | **WF2 auf PG-first umstellen** | Chargen noch Sheet-first angelegt | Mittel |
| 6 | **WF9 Refactoring** | Pickliste vollständig Sheet-abhängig | Groß |
| 7 | **WF1/WF2 Freigabe ins Dashboard** | Sheet hat UI-Funktion | Groß |

---

## Folge-Issues (empfohlen nach diesem Audit)

1. **`prices`-Tabelle befüllen** — Sheet `Produkte.price_gross` → `prices.sale_price_gross` einmalig
   migrieren; WF2 schreibt Preise bei neuen Produkten künftig direkt in PG.
2. **`purchase_date` und `machine_id`(Lagerort) in `stock_batches` ergänzen** — beide Felder fehlen
   in PG; Schema-Erweiterung + WF2-Anpassung.
3. **WF3 Sheet-Write-Nodes deaktivieren** (nach remaining_qty Root-Fix) — `Verarbeitete_Transaktionen`
   und FIFO-Sheet-Abbuchung entfernen, da PG-primär.
4. **WF9 auf PG-Reads umstellen** — `Produkte` + `Lagerchargen`-Reads im WF9 auf PG migrieren
   (ähnlich WF4 in #14).
