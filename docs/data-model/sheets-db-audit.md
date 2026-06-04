# Vollständigkeits-Audit: Google Sheets → SQL-DB (Issue #61)

> Reproduzierbar via `dashboard/scripts/sheets-db-audit/generate-audit.js`.
> Quellen: XLSX-Snapshot (`16` Tabs) + Live-DB-Introspektion (`21` Relationen).
> Erzeugt aus committeten Snapshots — Live neu ziehen mit `dump-db-inventory.js` (PG-Tunnel) / `dump-sheet-inventory.js` (XLSX).

## `Produkte`  — QUELLDATEN  (20 Spalten, 47+ Zeilen)

Stammdaten + aktive Slot-Zuordnung gemischt (DB: products + slot_assignments + prices).

Primäre DB-Tabelle: `automatenlager.products` (45 Zeilen)

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `product_key` | ✅ | products.product_key |
| `machine_id` | ✅ | slot_assignments.machine_id |
| `mdb_code` | ✅ | slot_assignments.mdb_code |
| `nayax_product_name` | ✅ | product_aliases.alias |
| `internal_product_name` | ✅ | products.name |
| `sale_price_eur` | ✅ | prices.sale_price_gross |
| `valid_from` | ✅ | slot_assignments.valid_from |
| `valid_to` | ✅ | slot_assignments.valid_to |
| `active` | ✅ | slot_assignments.active |
| `replenishment_status` | ❌ FEHLT | keine DB-Zielspalte |
| `min_stock` | ❌ FEHLT | keine DB-Zielspalte |
| `target_stock` | ✅ | slot_assignments.target_stock |
| `current_machine_qty` | ✅ | slot_assignments.current_machine_qty |
| `machine_capacity` | ✅ | slot_assignments.machine_capacity |
| `stock_source` | ❌ FEHLT | keine DB-Zielspalte |
| `notes` | ✅ | products.notes |
| `product_slot_id` | ✅ | slot_assignments.product_slot_key |
| `valid_from_datetime` | ✅ | slot_assignments.valid_from |
| `valid_to_datetime` | ✅ | slot_assignments.valid_to |
| `last_change_id` | — | Sheet-Bookkeeping (kein Migrationsgut) |

## `Lagerchargen`  — QUELLDATEN  (14 Spalten, 45+ Zeilen)

Primäre DB-Tabelle: `automatenlager.stock_batches` (56 Zeilen)

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `batch_id` | ✅ | stock_batches.batch_key |
| `product_key` | ✅ | products.product_key |
| `purchase_date` | ✅ | stock_batches.received_at |
| `mhd` | ✅ | stock_batches.mhd_date |
| `initial_qty` | ✅ | stock_batches.initial_qty |
| `remaining_qty` | ✅ | stock_batches.remaining_qty |
| `unit_cost` | ✅ | stock_batches.unit_cost_net |
| `supplier` | ✅ | invoices.supplier_id |
| `storage_location` | ❌ FEHLT | keine DB-Zielspalte |
| `status` | ✅ | stock_batches.status |
| `notes` | ❌ FEHLT | keine DB-Zielspalte |
| `source_invoice` | ✅ | invoices.invoice_key |
| `source_item` | ✅ | invoice_items.description_raw |
| `confidence` | — | Sheet-Bookkeeping (kein Migrationsgut) |

## `Produkt_Aliase`  — QUELLDATEN  (11 Spalten, 3+ Zeilen)

Primäre DB-Tabelle: `automatenlager.product_aliases` (88 Zeilen)

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `alias_name` | ✅ | product_aliases.alias |
| `normalized_alias` | ❌ FEHLT | keine DB-Zielspalte |
| `product_key` | ✅ | products.product_key |
| `source` | ✅ | product_aliases.source |
| `confidence` | — | Sheet-Bookkeeping (kein Migrationsgut) |
| `approved` | — | Sheet-Bookkeeping (kein Migrationsgut) |
| `created_at` | ✅ | product_aliases.created_at |
| `last_seen_at` | ❌ FEHLT | keine DB-Zielspalte |
| `supplier` | ❌ FEHLT | keine DB-Zielspalte |
| `invoice_item_example` | ❌ FEHLT | keine DB-Zielspalte |
| `notes` | ❌ FEHLT | keine DB-Zielspalte |

## `Verarbeitete_Transaktionen`  — QUELLDATEN  (9 Spalten, 49+ Zeilen)

Primäre DB-Tabelle: `automatenlager.sales_transactions` (342 Zeilen)

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `transaction_id` | ✅ | sales_transactions.nayax_transaction_id |
| `machine_id` | ✅ | sales_transactions.machine_id |
| `nayax_product_name` | ✅ | sales_transactions.product_name_raw |
| `product_key` | ✅ | products.product_key |
| `quantity` | ✅ | sales_transactions.quantity |
| `settlement_datetime_gmt` | ✅ | sales_transactions.settlement_at |
| `processed_at` | ✅ | sales_transactions.imported_at |
| `status` | ✅ | sales_transactions.processing_status |
| `notes` | ✅ | sales_transactions.processing_note |

## `Fehler_und_Hinweise`  — QUELLDATEN  (9 Spalten, 49+ Zeilen)

Primäre DB-Tabelle: `automatenlager.warnings` (389 Zeilen)

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `created_at` | ✅ | warnings.created_at |
| `type` | ✅ | warnings.warning_type |
| `severity` | ✅ | warnings.severity |
| `machine_id` | ✅ | warnings.machine_id |
| `product_key` | ✅ | products.product_key |
| `nayax_product_name` | ❌ FEHLT | keine DB-Zielspalte |
| `message` | ✅ | warnings.message |
| `resolved` | ✅ | warnings.resolved |
| `change_id` | — | Sheet-Bookkeeping (kein Migrationsgut) |

## `Produktwechsel_Log`  — QUELLDATEN  (20 Spalten, 8+ Zeilen)

Produktwechsel; DB-Abbildung verteilt auf stock_movements / product_change_proposals.

Primäre DB-Tabelle: `automatenlager.stock_movements` (24 Zeilen)

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `changed_at` | ✅ | stock_movements.occurred_at |
| `machine_id` | ✅ | slot_assignments.machine_id |
| `mdb_code` | ✅ | slot_assignments.mdb_code |
| `old_product_key` | ❌ FEHLT | keine DB-Zielspalte |
| `old_product_name` | ❌ FEHLT | keine DB-Zielspalte |
| `new_product_key` | ❌ FEHLT | keine DB-Zielspalte |
| `new_product_name` | ❌ FEHLT | keine DB-Zielspalte |
| `reason` | ✅ | stock_movements.reason |
| `action_required` | ❌ FEHLT | keine DB-Zielspalte |
| `change_id` | ✅ | stock_movements.movement_key |
| `changed_at_utc` | ✅ | stock_movements.occurred_at |
| `source` | ✅ | stock_movements.source |
| `detected_reason` | ❌ FEHLT | keine DB-Zielspalte |
| `old_mdb_code` | ❌ FEHLT | keine DB-Zielspalte |
| `new_mdb_code` | ❌ FEHLT | keine DB-Zielspalte |
| `change_type_de` | ❌ FEHLT | keine DB-Zielspalte |
| `change_type_internal` | ✅ | product_change_proposals.proposal_type |
| `valid_from_utc` | ❌ FEHLT | keine DB-Zielspalte |
| `status` | ❌ FEHLT | keine DB-Zielspalte |
| `notes` | ❌ FEHLT | keine DB-Zielspalte |

## `Bestandsaufnahme_Handschrift`  — QUELLDATEN  (8 Spalten, 29+ Zeilen)

Manuelle Inventur-Erfassung (29 Zeilen). KEINE DB-Tabelle vorhanden.

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `article_written` | ❌ FEHLT | keine DB-Zielspalte |
| `mapped_product_key` | ❌ FEHLT | keine DB-Zielspalte |
| `mapped_name` | ❌ FEHLT | keine DB-Zielspalte |
| `quantity_total` | ❌ FEHLT | keine DB-Zielspalte |
| `mhd` | ❌ FEHLT | keine DB-Zielspalte |
| `source` | ❌ FEHLT | keine DB-Zielspalte |
| `confidence` | ❌ FEHLT | keine DB-Zielspalte |
| `notes` | ❌ FEHLT | keine DB-Zielspalte |

## `Einstellungen`  — QUELLDATEN  (3 Spalten, 10+ Zeilen)

Key/Value-Konfiguration (10 Zeilen) — u. a. kleinunternehmer_aktiv, mwst_snack/getraenk. WF8 liest diese aus dem Sheet. DB hat classification_settings (JSONB), aber NICHT als Spiegel dieser Keys.

| Sheet-Spalte | Status | DB-Ziel / Hinweis |
|---|---|---|
| `key` | ❌ FEHLT | keine DB-Zielspalte |
| `value` | ❌ FEHLT | keine DB-Zielspalte |
| `description` | ❌ FEHLT | keine DB-Zielspalte |

## `Produkt_Aenderungsvorschlaege`  — STAGING (transient)  (17 Spalten, 3+ Zeilen)

Primäre DB-Tabelle: `automatenlager.product_change_proposals` (0 Zeilen)

_Nicht Cutover-relevant: Workflow-Zwischenstand, wird neu erzeugt._

## `Rechnungseingang_Pruefung`  — STAGING (transient)  (50 Spalten, 3+ Zeilen)

Primäre DB-Tabelle: `automatenlager.invoices` (1 Zeilen)

_Nicht Cutover-relevant: Workflow-Zwischenstand, wird neu erzeugt._

## `Lagerchargen_Vorschlaege`  — STAGING (transient)  (19 Spalten, 0+ Zeilen)

Primäre DB-Tabelle: `automatenlager.stock_batches` (56 Zeilen)

_Nicht Cutover-relevant: Workflow-Zwischenstand, wird neu erzeugt._

## `Offene_Eingaben`  — STAGING (transient)  (5 Spalten, 0+ Zeilen)

_Nicht Cutover-relevant: Workflow-Zwischenstand, wird neu erzeugt._

## `Dashboard`  — META/berechnet  (3 Spalten, 6+ Zeilen)

Berechnete KPIs.

_Nicht Cutover-relevant: berechnet/Meta._

## `Workflow_Anpassungen`  — META/berechnet  (3 Spalten, 9+ Zeilen)

Entwicklungs-Notizen.

_Nicht Cutover-relevant: berechnet/Meta._

## `Quellen_und_Pruefung`  — META/berechnet  (4 Spalten, 4+ Zeilen)

Evidenz/Doku.

_Nicht Cutover-relevant: berechnet/Meta._

## `System_Status`  — META/berechnet  (4 Spalten, 0+ Zeilen)

Lauf-Zeitstempel der Workflows.

_Nicht Cutover-relevant: berechnet/Meta._

## Lücken-Zusammenfassung (Cutover-Risiko)

Spalten mit Quelldaten, die NUR im Sheet leben (kein DB-Ziel) — vor #9 zu schließen:

| Tab | Sheet-Spalte | Hinweis |
|---|---|---|
| `Produkte` | `replenishment_status` | keine DB-Zielspalte |
| `Produkte` | `min_stock` | keine DB-Zielspalte |
| `Produkte` | `stock_source` | keine DB-Zielspalte |
| `Lagerchargen` | `storage_location` | keine DB-Zielspalte |
| `Lagerchargen` | `notes` | keine DB-Zielspalte |
| `Produkt_Aliase` | `normalized_alias` | keine DB-Zielspalte |
| `Produkt_Aliase` | `last_seen_at` | keine DB-Zielspalte |
| `Produkt_Aliase` | `supplier` | keine DB-Zielspalte |
| `Produkt_Aliase` | `invoice_item_example` | keine DB-Zielspalte |
| `Produkt_Aliase` | `notes` | keine DB-Zielspalte |
| `Fehler_und_Hinweise` | `nayax_product_name` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `old_product_key` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `old_product_name` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `new_product_key` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `new_product_name` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `action_required` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `detected_reason` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `old_mdb_code` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `new_mdb_code` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `change_type_de` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `valid_from_utc` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `status` | keine DB-Zielspalte |
| `Produktwechsel_Log` | `notes` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `article_written` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `mapped_product_key` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `mapped_name` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `quantity_total` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `mhd` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `source` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `confidence` | keine DB-Zielspalte |
| `Bestandsaufnahme_Handschrift` | `notes` | keine DB-Zielspalte |
| `Einstellungen` | `key` | keine DB-Zielspalte |
| `Einstellungen` | `value` | keine DB-Zielspalte |
| `Einstellungen` | `description` | keine DB-Zielspalte |

**34 offene Lücken** über 7 Tabs. `produktart` ist NICHT mehr darunter (über #62 erledigt).

## Empfehlung für den Cutover (#9)

Nach Migrations-Priorität gruppiert — vor dem Sheets-Abschalten zu schließen:

### A. Echte Quelldaten ohne DB-Heimat (HOCH — sonst Datenverlust)
- **`Bestandsaufnahme_Handschrift`** (29 Zeilen): komplette manuelle Inventur-Erfassung, KEINE DB-Tabelle. Braucht ein eigenes Zielmodell (z. B. `inventory_counts`).
- **`Einstellungen`** (Key/Value): Konfig wie `kleinunternehmer_aktiv`, `mwst_snack/getraenk` — WF8 liest sie aus dem Sheet. Single-Source-Lücke (vgl. #56): vor Cutover in DB-Config (`classification_settings` o. ä.) spiegeln, sonst verliert WF8 seine Steuer-/MwSt-Parameter.
- **`Lagerchargen.storage_location`**: Lagerort je Charge — reales Stammdatum, fehlt in `stock_batches`.

### B. Audit-/Historien-Daten (MITTEL — Nachvollziehbarkeit)
- **`Produktwechsel_Log`** (alt/neu-Produkt, Gründe): `stock_movements` bildet nur Mengenbewegung ab, nicht die Wechsel-Historie. Bei Bedarf erweitern.
- **`Produkt_Aliase`** (`supplier`, `last_seen_at`, `invoice_item_example`): Zusatzkontext zum Alias, fehlt in `product_aliases`.
- **`Lagerchargen.notes`**, **`Fehler_und_Hinweise.nayax_product_name`**: Freitext/Kontext.

### C. Ableitbar / niedrig (NIEDRIG — meist kein echter Verlust)
- `Produkte.replenishment_status` / `min_stock` / `stock_source`, `Produkt_Aliase.normalized_alias`: berechenbar/ableitbar oder Anzeige-Status; vor Cutover bewerten, ob überhaupt nötig.

> Nächster Schritt: je Bucket-A-Punkt ein Migrations-Issue unter #9 anlegen (z. B. via `spec-to-issue`). Dieses Audit ist die Grundlage; es verändert KEINE Produktionsdaten.
