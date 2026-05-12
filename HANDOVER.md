# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-12 (Session 5 – Historische Daten + GuV-Rekonstruktion gestartet)

### Aktuelles Vorhaben (laufend)

User moechte alle historischen Daten ab Oktober 2025 rekonstruieren, damit die GuV
rueckwirkend berechnet werden kann. Dafuer hat er folgende Quellen bereitgestellt:

**Hochgeladene Dateien (User):**
- 7 Metro-Rechnungen (PDF):
  `2025-09-24`, `2025-09-30`, `2026-01-24`, `2026-02-28`, `2026-04-22`, `2026-05-04`, `2026-05-11`
  Pfad: `C:/Users/patri/Proton Drive/.../03 Füllmaterial/02 Rechnungen/01 Metro/`
- 1 Lebensmittel-Sonderposten-Rechnung (PDF): `2026-03-07`
- Metro-Preisliste mit Netto+Brutto: `01 Bestellungen/Preisliste_Metro_KALKU_2026-1.xlsx`
  → 51 Produkte mit `preis_netto_stk`, `preis_brutto_stk`, `mwst`, `inhalt_karton`, `ean`, `mhd`, `vk_preis`
- Nayax-Transaktionsexport (alle historischen Verkaeufe):
  `DynamicTransactionsMonitorMega_2026-05-12T155903.xlsx`

**Aufgabenliste:**
1. ⏳ Lagerchargen-`unit_cost` ergaenzen (32 von 46 Chargen ohne Cost)
   - Quelle: 8 PDFs + Preisliste
   - Bei Abweichungen den User fragen
   - unit_cost in Lagerchargen ist **per Einzelstueck Brutto** (nicht per Pack)
2. ⏳ Fehlende historische Lagerchargen anlegen (fuer 5 Rechnungen ohne Lagercharge):
   - 2025-09-24, 2025-09-30, 2026-01-24, 2026-02-28, 2026-04-22
3. ⏳ Historische Verkaeufe aus Nayax-Export in `Verarbeitete_Transaktionen` schreiben
   - Pro Verkauf: nayax_product_name, product_key (matching), settlement_datetime_gmt,
     quantity, vk_preis_brutto, umsatz_brutto, mdb_code_extracted, batch_id_abgebucht (FIFO)
4. ⏳ WF8 erneut laufen lassen → komplette GuV ab Oktober 2025

**Helper-Daten (zwischengespeichert in guv_check_tmp/):**
- `_preisliste.json` – 51 Metro-Preislisten-Eintraege
- `_lagerchargen.json` – aktueller Zustand 46 Chargen
- `_produkte.json` – aktueller Zustand 48 Produkte
- `_rechnungen.json` – geparste Rechnungen: Metro 04.05., Metro 11.05., Sonderposten 03.07.
- `_proposal.json` – komplette Korrektur-/Befuellungs-Vorschlag-Tabelle + offene Fragen an User
- `xlsx` npm-Paket installiert in guv_check_tmp/node_modules

**Stand 2026-05-12 (nach User-Antwort) – Lagerchargen + Produkte komplett gepflegt:**

Phase 1 abgeschlossen:
- 5 von 8 PDFs gelesen (Metro 04.05., 11.05., 22.04., 28.02. + Sonderposten 03.07.)
- WF_TEMP (`m6hTE6lCQfdefP15`) per SDK gebaut und ausgefuehrt:
  - Alle 46 Lagerchargen mit korrektem `unit_cost` (Brutto pro Verkaufseinheit) +
    `mwst_satz` (7 fuer Snacks, 19 fuer Getraenke) gepflegt
  - Alle 48 Produkte mit `produktart` (snack/getraenk) gepflegt
- Konsistenz-Check: 0 Fehler (alle Chargen haben unit_cost > 0 und mwst_satz, alle
  Produkte haben produktart, produktart vs Lagercharge-mwst konsistent)

**Konvention final:**
- `Lagerchargen.unit_cost` = BRUTTO pro Verkaufseinheit (Stueck im Automaten)
- `Lagerchargen.mwst_satz` = 7 oder 19 je nach Produktart
- `Produkte.produktart` = 'snack' oder 'getraenk' (Getraenke: Cola, Cola Zero, Fanta,
  Sprite, Red Bull, Red Bull Spring, Lichtenauer Medium/Still, Capri Sun Safari/Kirsch)

**Sonderfaelle aus User-Antworten:**
- KINDER BUENO KLASSIK: Doppelpack = Verkaufseinheit → 0,8453 brutto
- KITKAT CHUNKY = KITKAT CH FUNKY (Metro 28.02., 0,49 netto + 7%)
- KITKAT NORMAL = KITKAT CH CLASSIC (Metro 22.04., 0,49 netto + 7%)
- SNICKERS + TWIX SING: rabattiert auf 0,45 netto (Metro 28.02.)
- DUPLO ORIGINAL: 10er Pack 2,99 netto = 0,299 / Stueck (Metro 28.02.)
- SNICKERS CREAMY: 24x36,5g 0,52 netto + 7% (Metro 22.04.)
- RED BULL SPRING: 1,23 netto + 19% (Metro 28.02.) – ohne Pfand
- MANNER MINIS: 60x15g = 16,49 netto, 0,2748 netto / Stueck (Metro 28.02.)
- LEIBNIZ KEKN CREAM: User-Korrektur initial_qty 77→18, remaining 15
- DUPLO WHITE: aus Sortiment entfernt (kein SKU im System)

**Helper-Daten (zwischengespeichert in guv_check_tmp/):**
- `_preisliste.json` – 51 Metro-Preislisten-Eintraege
- `_lagerchargen.json` – aktueller Zustand 46 Chargen (alle gepflegt)
- `_produkte.json` – aktueller Zustand 48 Produkte (alle gepflegt)
- `_rechnungen.json` – geparste Rechnungen
- `_proposal.json` – Korrektur-/Befuellungs-Vorschlag-Tabelle
- `wf_update_data.js` – SDK-Code des WF_TEMP fuer Audit-Trail
- WF_TEMP `m6hTE6lCQfdefP15` als inaktiver Workflow in n8n stehen geblieben

**Pfand-Korrektur 2026-05-12 (User-Feedback):**
VK-Preise am Automaten enthalten Pfand, der nicht zurueck zu Faltrix fliesst.
Daher muss `unit_cost` der Pfand-pflichtigen Getraenke das Pfand enthalten.
8 Lagerchargen aktualisiert (+0,2975 brutto = 0,25 netto + 19% MwSt laut METRO):
- Coca-Cola: 1,2852 | Coca-Cola Zero: 1,1900 | Fanta Exotic: 1,2852 | Sprite: 1,2852
- Red Bull: 1,2852 | Red Bull Spring: 1,7612
- Lichtenauer Medium/Still: 0,8782
Trinkpaeckchen (Capri-Sonne) bleiben unveraendert (kein Pfand).

**Phase 2 Datenerfassung abgeschlossen 2026-05-12 (sehr spaet):**

User wählte **Option A** (saubere Vollrekonstruktion). Pfand-Wert bestätigt: 0,2975 brutto.

**Alle Daten gesammelt:**

`guv_check_tmp/_rechnungen.json` – alle 8 Rechnungen geparst (71 Positionen):
- metro_2025_09_24: 39 Pos (grosse Initial-Bestellung)
- metro_2025_09_30: 3 Pos (Hanuta, Mr.Toms, Capri Safari)
- metro_2026_01_24: 3 Pos (Kinder Country, Cola, Cola Zero)
- metro_2026_02_28: 9 Pos
- metro_2026_04_22: 5 Pos
- metro_2026_05_04: 3 Pos
- metro_2026_05_11: 1 Pos
- sonderposten_2026_03_07: 8 Pos

`guv_check_tmp/_nayax_sales.json` – 518 historische Verkaufstransaktionen geparst:
- Datumsbereich: 22.09.2025 - 12.05.2026
- Maschinenname: "CR-FCRvMMfAiraF" (Nayax-Display, intern: machine_id=457107528)
- 62 unique (Produkt, MDB-Code) Kombinationen
- Format: `produkt_info` enthält "Name(MDB  Preis)"

**16 neue SKUs zum Anlegen in Produkte:**
Aus Metro 24.09.2025 + Nayax-Verkaufsliste identifiziert:
KNOPPERS, HARIBO_COLOR_RADO, DUPLO_WHITE (historisch), FF_UNGARISCH (ChipsFrisch ungarisch),
BALISTO_YOBERRY, LION, PRINGLES_SOUR_CREAM, PRINGLES_SWEET, DINKELCHEN, TOBLERONE,
KITKAT_PEANUT (historisch), CRUNCHIPS, LIPTON_PEACH, BIFI_CARAZZA (Carazza), BIFI_ROLL, BIFI_ORIGINAL

Aus Nayax-Verkäufen kommen weitere historische Namen:
- Buenos white(45  2.00) → SKU_BUENO_WHITE
- Snickers Cream Peanut Butter(12  1.00) → SKU_SNICKERS_CREAMY
- Falcone XXL-Cookies Cranberry(22  und 26) – 2 verschiedene MDBs?
- Crunchips Original(22  1.80) → SKU_CRUNCHIPS

**60 historische Lagerchargen zum Anlegen:**
- 24.09.2025: 39 Chargen
- 30.09.2025: 3
- 24.01.2026: 3 (Kinder Country + 2 Cola rabattiert)
- 28.02.2026: 9
- 22.04.2026: 5
- Bestehende Lagerchargen vom 04.05./11.05. + Sonderposten 03.07. bleiben unverändert
- Bestehende Inventur-Chargen vom 02.05. bleiben unverändert (sind Bestandsaufnahme,
  ergaenzen historische Lieferungen)

**Wichtige Erkenntnisse:**
- Bei Cola: Preise schwanken stark wegen Mengenrabatten:
  - 24.09.2025: 0,52 netto → 0,9163 inkl Pfand
  - 24.01.2026: 0,58 netto → 0,9877 inkl Pfand
- Snickers/Twix kommen mit und ohne Rabatt
- Croissants 4er-Pack: 1,75 netto/Pack im Februar, 1,89 ab April
- KitKat CH PEANUT BU (24.09.) ≠ KitKat CH FUNKY (28.02.) ≠ KitKat CH CLASSIC (22.04.)
  → 3 verschiedene KitKats über Zeit

**Implementation-Plan (in 4 Schritten, NEUE SESSION empfohlen wegen Context):**

Schritt 1 – `WF_TEMP2 - Anlage 16 SKUs + 60 historische Chargen`:
  - Code-Node mit Hardcoded 16 SKU-Items (product_key, internal_name, produktart, active=FALSE)
  - Google Sheets append zu Produkte
  - Code-Node mit Hardcoded 60 Lagercharge-Items (batch_id, product_key, purchase_date,
    unit_cost, mwst_satz, initial_qty, remaining_qty=0, supplier, source_invoice)
  - Google Sheets append zu Lagerchargen

Schritt 2 – FIFO-Algorithmus in JS:
  - Lade alle Lagerchargen (historisch + Inventur)
  - Lade alle Nayax-Verkäufe sortiert nach Datum
  - Für jeden Verkauf: finde älteste Charge mit `purchase_date <= sale_date AND remaining_qty > 0`
  - Setze `batch_id_abgebucht`, reduziere remaining_qty
  - Output: 518 Sales mit batch_id-Zuordnung
  - Output: log von remaining_qty Ende (Discrepanz vs. Inventur)

Schritt 3 – `WF_TEMP3 - Append 518 historische Verkaeufe`:
  - Code-Node mit 518 sale-items (aus FIFO-Algorithmus)
  - Google Sheets append zu Verarbeitete_Transaktionen
  - Achtung: bestehende ~150 Zeilen NICHT überschreiben

Schritt 4 – WF8 Re-Run:
  - Manuell triggern
  - Verify GuV_Tagesposten zeigt alle Tage seit Oktober 2025

**Nayax-Verkauf → SKU-Matching:**
Hierfür braucht's ein Mapping `nayax_product_name` → `product_key`. Vorschlag: in den
neuen SKUs setzen wir `nayax_product_name` aus der Verkaufsstatistik
(z.B. "Snickers" → SKU_SNICKERS, "Bueno" → SKU_BUENO, "Buenos white" → SKU_BUENO_WHITE).

**Helper-Daten:**
- `_preisliste.json` – 51 Metro-Preisliste-Einträge
- `_rechnungen.json` – alle 8 Rechnungen (71 Positionen)
- `_nayax_sales.json` – 518 historische Verkäufe
- `_lagerchargen.json` – aktuelle 46 Chargen (alle gepflegt)
- `_produkte.json` – aktuelle 48 Produkte (alle mit produktart)
- `_proposal.json` – Korrekturvorschlag-Tabelle (Phase 1)

**Verteilung der bestehenden Lagerchargen (purchase_date → Chargen):**
- 2026-03-07: 5 (passt zu Lebensmittel-Sonderposten-PDF)
- 2026-05-02: 35 (vermutlich Inventur-Bulk-Anlage, kein passendes PDF)
- 2026-05-04: 2 (passt zu Metro-PDF 04.05.)
- 2026-05-11: 1 (passt zu Metro-PDF 11.05.)
- + 3 weitere verstreut

**WICHTIG bei Datenrekonstruktion:**
- MHD-Ablauf ist KEIN sicheres Indiz fuer Aussortierung – User hat in Vergangenheit
  auch ueber MHD hinaus verkauft. Erst ab jetzt wird sofort aussortiert.
- Bei Preisabweichungen User fragen, nicht raten.

---

## Stand: 2026-05-11 (Session 4 – GuV-System Phase A3)

### Kurzfassung

Das Projekt ist ein n8n-basiertes Automatenlager-System mit Google Sheets als Arbeits- und Logschicht.
Es verarbeitet Rechnungen, Produktvorschlaege, Nayax-Verkaeufe, FIFO-Lagerchargen, MDB-/Slot-Historisierung
und MHD-/Bestandswarnungen. In Session 3+4 wurde das GuV-System aufgebaut (Phasen A1–A3 abgeschlossen).

### Was in dieser Session passiert ist

#### Phase A1: GuV-Sheets Setup (WF7) – abgeschlossen

WF7 wurde per n8n MCP erstellt (ID: `d6JoXqhfTOuvRKVv`) und einmalig ausgefuehrt.
Folgende neue Google-Sheets-Tabs wurden angelegt und mit Spaltenkoepfen versehen:

- **`GuV_Tagesposten`**: 17 Spalten:
  `date, machine_id, mdb_code, product_slot_id, product_key, nayax_product_name, produktart,
  quantity_sold, vk_preis_brutto, umsatz_brutto, ek_preis_netto, mwst_satz_einkauf,
  ek_preis_brutto, wareneinsatz_brutto, guv, kleinunternehmer_aktiv, aggregiert_am`

- **`GuV_Konfiguration`**: vorab befuellt:
  `kleinunternehmer_aktiv=TRUE`, `mwst_snack=7`, `mwst_getraenk=19`

- **`Standorte`**: vorbereitet fuer Phase B

- **`Maschinen_Standort`**: vorbereitet fuer Phase B

Folgende Spalten wurden bestehenden Sheets manuell ergaenzt:
- `Produkte` + Spalte `produktart`
- `Lagerchargen` + Spalte `mwst_satz`
- `Verarbeitete_Transaktionen` + Spalten `vk_preis_brutto, umsatz_brutto, batch_id_abgebucht, mdb_code_extracted`

#### Phase A2: WF3 erweitern – abgeschlossen

WF3 (`2PFfPf0sVmMW7Fpp`) wurde per n8n REST API direkt gepatcht (nicht per SDK-Rewrite):

**Aenderungen am FIFO-Code-Node (`Code - FIFO berechnen`):**
1. **SettlementValue-Filter**: Transaktionen mit `SettlementValue <= 0` werden stillschweigend
   uebersprungen (Prepaid Credits, Stornos, Testtransaktionen). Kein Log, keine FIFO-Abbuchung.
   Wasserzeichen (`maxProcessedSaleDate`) wird trotzdem vorgerueckt.
2. **`getSoldQty()` vereinfacht**: Nayax-API liefert immer `Quantity=0`. Multivend-Pruefung bleibt,
   Fallback ist `default_quantity_per_sale` (= 1 in Config). Keine harte `qty=1`-Ueberschreibung.
3. **`vkPreisBrutto`**: `Number(sale.SettlementValue)` = tatsaechlicher Verkaufspreis in EUR.
4. **`mdbExtracted`**: Aus `sale.mdb_code_extracted` (bereits durch den vorgelagerten
   `Code in JavaScript`-Node aus dem ProductName-Muster extrahiert).
5. **`deductedBatches`**: Liste der `batch_id`s, aus denen wirklich abgebucht wurde.
6. **Alle `transactionLogs`-Eintraege** enthalten jetzt 4 neue Felder:
   `vk_preis_brutto, umsatz_brutto, mdb_code_extracted, batch_id_abgebucht`

**Aenderungen am Google-Sheets-Node (`Google Sheets - Transaktionen anhaengen`):**
4 neue Spaltenmappings: `vk_preis_brutto, umsatz_brutto, mdb_code_extracted, batch_id_abgebucht`

WF3 wurde ausserdem von n8n-API MIT korrekter Credential
(`5XfHt3SzjHCj8B5H = Sheets Automatenlager`) gespeichert.
Lokale JSON-Datei aktualisiert + Nayax-Token-Platzhalter gesetzt.

**Erledigt im Codex-Nachtrag:** Der echte Nayax-Bearer-Token wurde im live WF3 von einem
statischen Header-Parameter auf eine n8n HTTP-Header-Auth-Credential umgestellt.

#### Phase A3: WF2 erweitern – MwSt-Satz in Lagerchargen – abgeschlossen

WF2 (`wGDkVMoPN2Ed88TO`) wurde per n8n REST API gepatcht (Skript: `guv_check_tmp/patch_wf2_a3.js`).

**Aenderungen (4 Nodes):**

1. **`Code - Produktvorschlaege vorbereiten`**:
   - `produktart` wird jetzt in `candidates` und `allProducts` mitgefuehrt.
   - `default_mwst_satz` wird aus `produktart` des besten Kandidaten berechnet:
     Snack/Riegel → 7 %, Getraenk/Drink → 19 %, unbekannt → 19 %.
   - `default_mwst_satz` ist im return-Objekt verfuegbar (fuer Form-Default).

2. **`Form - Produktentscheidung`**:
   - Neues Zahlenfeld `mwst_satz` nach `unit_cost_override` eingefuegt.
   - Default-Wert: `={{ $json.default_mwst_satz }}` (aus dem Prep-Node).
   - Placeholder: `7 (Snack) oder 19 (Getränk)`.
   - Benutzer kann den Wert vor der Freigabe korrigieren.

3. **`Code - Entscheidung auswerten`**:
   - Liest `formDecision.mwst_satz` (Komma-tolerant, numeric).
   - Fallback-Kette: Formulareingabe → produktart des gewahlten Produkts → `default_mwst_satz` → 19.
   - `mwst_satz` im return-Objekt vor `status: 'aktiv'` eingefuegt.

4. **`Google Sheets - Lagercharge anlegen`**:
   - Spaltenmapping `mwst_satz` hinzugefuegt:
     `={{ $('Code - Entscheidung auswerten').item.json.mwst_satz }}`
   - Schema-Eintrag (type: number) ergaenzt.

Lokale WF2-JSON-Datei nach dem Patch aktualisiert.

**Hinweis fuer naechsten WF2-Lauf:**
Im n8n-UI den Node `Google Sheets - Lagercharge anlegen` oeffnen,
Columns/Fields einmal refreshen und speichern – sonst kann `Column names were updated` auftreten
(gleicher Effekt wie bei WF3 nach Phase A2, da das Schema-Feld neu ist).

#### Phase A4: WF8 GuV Tagesposten Aggregator – gebaut, ungetestet

WF8 (`qwpQMhZqDAIs8Wi9`) wurde komplett per n8n MCP SDK erstellt.

**Funktion:**
Taeglich um 02:00 Uhr aggregiert WF8 alle Verkaufstransaktionen aus
`Verarbeitete_Transaktionen` pro `(date × machine_id × product_key)` und
schreibt eine Zeile pro Aggregat in `GuV_Tagesposten`.

**Nodes (8):**
1. `Cron - Taeglich 02:00` (scheduleTrigger)
2. `Read - Verarbeitete_Transaktionen` – alle Verkaeufe
3. `Read - Lagerchargen` (executeOnce) – fuer EK-Lookup ueber batch_id
4. `Read - Produkte` (executeOnce) – fuer Produktart-Fallback
5. `Read - GuV_Konfiguration` (executeOnce) – Kleinunternehmer-Status, MwSt-Defaults
6. `Read - GuV_Tagesposten (vorhanden)` (executeOnce, alwaysOutputData) – Idempotenz-Check
7. `Code - GuV aggregieren` (runOnceForAllItems) – die Berechnung
8. `Append - GuV_Tagesposten` (autoMapInputData) – schreibt das Ergebnis

**Berechnung pro Transaktion:**
- `qty` × `vk_preis_brutto` → `umsatz_brutto`
- `batch_id_abgebucht[0]` → Lagercharge → `unit_cost` (= EK brutto pro Stueck)
- `qty` × `unit_cost` → `wareneinsatz_brutto`
- `mwst_satz` aus Lagercharge, Fallback Produktart → Defaults aus Konfig
- `ek_preis_netto = ek_brutto / (1 + mwst/100)`
- `guv = umsatz_brutto - wareneinsatz_brutto`

**Idempotenz:**
Vor der Aggregation werden alle bestehenden GuV-Schluessel
`(date|machine_id|product_key)` geladen. Schluessel, die bereits existieren,
werden uebersprungen → kein Doppel-Buchen bei mehrfachem Ausfuehren.

**Aktueller Status:**
Workflow ist inaktiv und ungestetestet. Erster manueller Test steht aus.
Workflow wurde via Schedule Trigger gebaut – nach erfolgreichem manuellem
Lauf einfach im n8n UI auf "active" setzen.

**Bekannte Vereinfachungen (fuer V1 akzeptabel):**
- Mehrfach-Batch-Abbuchungen (`batch_id_abgebucht` mit mehreren IDs) werden
  aktuell nur ueber den ERSTEN Batch bewertet. Genaue Anteilsverteilung
  waere praeziser, aber selten relevant.
- `ek_preis_netto`/`ek_preis_brutto`/`mwst_satz_einkauf` sind pro Aggregat
  als qty-gewichtete Mittelwerte gespeichert (mehrere Chargen mit
  unterschiedlichen Preisen ergeben Durchschnitt).

#### Phase A3c: unit_cost-Normalisierung – abgeschlossen

Nach Phase A3b war `initial_qty` per-Stueck (16), `unit_cost` aber weiterhin
per-Pack aus der Rechnung – inkonsistent.

**Fix in WF2 `Code - Entscheidung auswerten`:**
- `unitCostPerPiece = unitCostRaw / packSize` (wenn packSize > 1)
- `unit_cost` in Lagercharge ist jetzt immer per Einzelstueck
- form_info zeigt "Einzelkosten (Pack): X EUR → pro Stueck: Y EUR"

WF8 kann jetzt rechnen: `wareneinsatz = qty × Lagercharge.unit_cost`.

#### Phase A3b: pack_size + mwst_satz aus Rechnung – abgeschlossen

WF1 (`dKNRRxkCPmVsArJ0`) und WF2 (`wGDkVMoPN2Ed88TO`) wurden so erweitert,
dass MwSt-Satz und Stueckzahl pro Packung direkt aus der Rechnung gelesen werden.

**Aenderungen WF1:**
- Claude-Prompt extrahiert jetzt zusaetzlich:
  - `pack_size`: Stueck pro Verkaufspackung (Default 1). Beispiele:
    `30x2x21,5g` → quantity=30, pack_size=2; `4x4x40g` → quantity=4, pack_size=4.
  - `mwst_satz`: aus Steuersatz-Spalte der Rechnung, 7 oder 19. 0 wenn unklar.
- Merge-Node (`Code - Rechnung gegen Stammdaten pruefen`) schreibt jetzt
  `detected_pack_size` und `detected_mwst_satz` in `Rechnungseingang_Pruefung`.

**Aenderungen WF2:**
- `Code - Produktvorschlaege vorbereiten`:
  - Berechnet `totalQty = quantityPacks * packSize`
  - `default_quantity` ist jetzt Einzeleinheiten (nicht mehr Packungen)
  - `default_mwst_satz` Reihenfolge: Rechnung > Produktart > 19
  - `form_info` zeigt Aufschluesselung "4 Packungen x 4 Stueck = 16 Einzeleinheiten"
    und "MwSt laut Rechnung: 7%"
- `Code - Entscheidung auswerten`:
  - `mwstFallback` priorisiert `invoiceMwst > 0 ? invoiceMwst : produktart-fallback`

**Manuelle Aktion noetig (User):**
- In `Rechnungseingang_Pruefung` zwei Spalten am Ende anlegen:
  - `detected_pack_size`
  - `detected_mwst_satz`
- Sonst verwirft autoMapInputData die neuen Felder.

#### WF2 Bugfixes 2026-05-11 (Phase A3 Nachfolge) – abgeschlossen

Beim ersten WF2-Testlauf nach Phase A3 traten 3 Probleme auf:

1. **`Alias existiert noch nicht?` wurde nie ausgefuehrt:**
   - `Produktalias` (Google Sheets) gab 0 Items zurueck → n8n fuehrt
     IF-Nodes mit 0 Items nicht aus.
   - Fix: `alwaysOutputData: true` auf `Produktalias` Node + IF-Bedingung
     von `$input.all().length === 0` auf `!$input.first()?.json.product_key` umgestellt.

2. **`Google Sheets - Lagercharge anlegen` mit leerem sheetName:**
   - Live WF2 hatte irgendwann `sheetName.value = ""` → PUT mit
     Phase-A3-Aenderungen ging trotzdem durch, n8n hat aber spaeter
     bei der Validierung blockiert.
   - Fix: `sheetName.value = "=Lagerchargen"` wiederhergestellt.

3. **`columns`-Objekt im Lagercharge-Node komplett geloescht:**
   - n8n hat das gesamte columns-Mapping (inkl. mwst_satz Eintrag aus
     Phase A3) silently gestrippt, vermutlich ausgeloest durch (2).
   - Folge: WF2-Lauf bricht mit `Could not get parameter: columns.schema`.
   - Fix: columns aus git commit 233b4dd (Phase A3) restauriert; nach
     erneutem PUT bleibt das Objekt persistent (14 Felder inkl. mwst_satz).

**Erfolgreicher End-to-End-Test danach:** WF2 laeuft komplett durch,
Alias-Pfad wird korrekt getriggert, Lagercharge wird mit mwst_satz geschrieben.

#### Codex-Nachtrag 2026-05-11 Abend – WF3 Credential + Sheets-Schema – abgeschlossen

**Nayax-Token aus WF3 entfernt / n8n-Credential eingerichtet:**
- Hilfsskript `guv_check_tmp/setup_nayax_credential.js` wurde repariert und erfolgreich genutzt.
- Urspruenglicher Fehler `settings is not defined` kam daher, dass beim Workflow-`PUT`
  `settings` statt `wf.settings` gesendet wurde.
- Zweiter Fehler `request/body/settings must NOT have additional properties` kam daher, dass
  n8n beim `GET` interne Settings liefert, die beim `PUT` nicht wieder akzeptiert werden.
- Fix im Skript:
  - Workflow-Settings werden ueber `getWritableWorkflowSettings(wf.settings)` gefiltert.
  - Das Skript sucht zuerst eine vorhandene `Nayax Bearer` Credential und aktualisiert sie per
    `PATCH`, statt bei jedem Lauf eine neue Credential anzulegen.
  - Token wird interaktiv in PowerShell eingegeben und nicht in Chat, Log oder Workflow-JSON
    fest gespeichert.
- Live-WF3 wurde erfolgreich auf `credentials.httpHeaderAuth = { name: 'Nayax Bearer' }`
  umgestellt. Der statische Authorization-Header im Node `Nayax - Last Sales` ist nicht mehr
  fuehrend.

**WF3 Google-Sheets-Fehler behoben:**
- Beim ersten WF3-Lauf nach Phase A2 kam im Node `Google Sheets - Transaktionen anhaengen`:
  `Column names were updated after the node's setup`.
- Ursache war eine vertauschte Spaltenreihenfolge zwischen echtem Sheet-Header und n8n-Node-Schema:
  - Google Sheet: `..., vk_preis_brutto, umsatz_brutto, batch_id_abgebucht, mdb_code_extracted`
  - n8n-Node-Cache: `..., vk_preis_brutto, umsatz_brutto, mdb_code_extracted, batch_id_abgebucht`
- n8n blockiert dann den Append, weil die gespeicherte Spaltenliste nicht mehr zu den realen
  Google-Sheets-Headern passt.
- Fix: Im Node `Google Sheets - Transaktionen anhaengen` die Spaltenliste/Fields aktualisiert
  und die Mappings fuer `mdb_code_extracted` und `batch_id_abgebucht` korrekt gesetzt.
- Nutzer hat bestaetigt: WF3 laeuft danach komplett.

### Was bisher gebaut wurde

#### Workflows

- `WF0` – product_slot_id Backfill (einmalig, abgeschlossen)
- `WF1` – Rechnungseingang automatisch mit Claude
- `WF1` – Rechnungseingang automatisch mit Claude **(Phase A3b erweitert)**
  - Claude extrahiert zusaetzlich `pack_size` und `mwst_satz` pro Rechnungsposition
  - Pruefung-Sheet erhaelt `detected_pack_size` + `detected_mwst_satz`
- `WF2` – Smart Product Selection / Rechnungsvorschlaege **(Phase A3 + A3b erweitert)**
  - Phase A3: `mwst_satz` wird in neue Lagerchargen geschrieben
  - Phase A3b: `initial_qty = quantity × pack_size` (Einzeleinheiten statt Packungen);
    MwSt-Default priorisiert Rechnung > Produktart > 19
  - Form `Produktentscheidung` zeigt Aufschluesselung "X Packungen × Y Stueck = Z Einzeleinheiten"
- `WF3` – Nayax Lynx FIFO Lagerbestand **(Phase A2 erweitert)**
  - Jetzt: `vk_preis_brutto`, `umsatz_brutto`, `mdb_code_extracted`, `batch_id_abgebucht`
  - Nayax-Credential: erledigt, live WF3 nutzt n8n HTTP-Header-Auth-Credential `Nayax Bearer`
- `WF4` – MDB Produktzuordnung bearbeiten (Slot-Historisierung)
- `WF5` – MHD und niedrige Lagercharge ueberwachen
- `WF7` – GuV Sheets Setup (ID: `d6JoXqhfTOuvRKVv`, einmalig ausgefuehrt)
- `WF8` – GuV Tagesposten Aggregator (ID: `qwpQMhZqDAIs8Wi9`, Phase A4)
  - Cron taeglich 02:00, inaktiv. Aggregiert Verkaufstransaktionen zu GuV-Tagesposten

#### Dashboard (`dashboard/`)

- Node.js-Server + HTML/CSS/JS-Frontend, Port 8787
- Live Google Sheets, Fallback XLSX
- Einstellungsseite fuer API-Key
- Autostart via Task Scheduler

### Was funktioniert (geprueft 2026-05-11)

- Phase A1: GuV-Sheets in Google Sheets angelegt, Spaltenkoepfe gesetzt.
- Phase A2: WF3 live in n8n aktualisiert, neue Felder werden beim naechsten Verkaufslauf
  in `Verarbeitete_Transaktionen` geschrieben.
- Google-Sheets-Credentials korrekt in WF3 hinterlegt.
- Nayax-Bearer-Token ist jetzt als n8n HTTP-Header-Auth-Credential `Nayax Bearer` hinterlegt;
  WF3 nutzt diese Credential statt eines statischen Klartext-Headers.
- `Google Sheets - Transaktionen anhaengen` hat aktualisierte Spalten-Mappings und appends
  wieder erfolgreich in `Verarbeitete_Transaktionen`.
- Phase A3: WF2 live getestet, laeuft komplett. `mwst_satz` wird in Lagerchargen
  geschrieben. Drei initiale Bugs (Alias-IF, sheetName, columns-Strip) wurden
  identifiziert und gefixt.
- Phase A3b: WF1 + WF2 Code-Patches angewendet (pack_size + mwst_satz aus Rechnung).
  Noch nicht live getestet – User braucht eine neue Rechnung dafuer.
  **TODO vor erstem Test**: In `Rechnungseingang_Pruefung` zwei Spalten anlegen:
  `detected_pack_size`, `detected_mwst_satz`.

### Naechste konkrete Schritte (nach Phase A4)

#### Phase A4 Test (anstehend)
- WF8 manuell triggern (oeffne im n8n UI, "Execute workflow")
- Pruefen ob bestehende Verarbeitete_Transaktionen-Eintraege korrekt aggregiert werden
- Bei Erfolg WF8 auf "active" setzen

#### Phase A5: Dashboard `/api/guv` Endpoint
- Liest `GuV_Tagesposten`, aggregiert nach Zeitraum und Maschine
- Gibt KPI-Tiles zurueck: Umsatz, Wareneinsatz, GuV, Anzahl Verkaeufe

#### Phase A6: Dashboard GuV-Section
- Zeitraum-Selector (Woche/Monat/Quartal/Custom)
- Maschinen-Dropdown
- KPI-Tiles + Produkttabelle

#### Phase A7: WF5 Tagesumsatz in Mail
- WF5 Mail um Tagesverkaufsliste pro Maschine + Gesamtsumme erweitern

#### Phase A8: Historische 2026-Daten importieren
- Die 12 GuV-Excel-Dateien aus Proton Drive (Jan–Dez 2026) wurden in Google Drive kopiert
- Import-Workflow oder Skript noetig, um Verkaufsdaten in `GuV_Tagesposten` zu laden

### Bekannte Probleme und technische Schulden

- **Erledigt 2026-05-11:** Nayax-Token im live WF3 wurde von statischem Header auf n8n
  HTTP-Header-Auth-Credential `Nayax Bearer` umgestellt.
- **TODO vor erstem WF2-Lauf nach Phase A3:** Node `Google Sheets - Lagercharge anlegen`
  in n8n UI oeffnen, Columns/Fields refreshen, speichern. Sonst kommt
  `Column names were updated after the node's setup` (gleicher Effekt wie WF3 nach A2).
- Bei zukuenftigen Google-Sheets-Spaltenerweiterungen in n8n immer den betroffenen
  Google-Sheets-Node oeffnen, Fields/Columns refreshen und neu speichern.
- WF5 lokal korrigiert (Bestandslogik), aber noch nicht in n8n live getestet/importiert.
- Phase A4–A8 noch offen.
- Langfristig: Trennung von Produktstamm und Slot-Historie waere sauberer.

### Google Sheets – Tabs im Ueberblick

| Tab | Zweck |
|-----|-------|
| `Produkte` | Aktive Slotbelegungen (WF4 fuehrend) |
| `Lagerchargen` | FIFO-Chargen inkl. `mwst_satz` (neu) |
| `Verarbeitete_Transaktionen` | WF3-Log inkl. GuV-Felder (neu: vk_preis, umsatz, batch) |
| `Produkt_Aliase` | Namensaliase fuer WF2/WF3-Matching |
| `Produktwechsel_Log` | WF4-Historisierungslog |
| `Fehler_und_Hinweise` | WF3/WF5-Warnungen |
| `Produkt_Aenderungsvorschlaege` | WF3→WF4-Vorschlaege |
| `GuV_Tagesposten` | GuV-Aggregat pro Tag/Maschine (WF8, neu) |
| `GuV_Konfiguration` | `kleinunternehmer_aktiv`, MwSt-Saetze (neu) |
| `Standorte` | Standorte (vorbereitet, Phase B) |
| `Maschinen_Standort` | Maschine↔Standort-Zuordnung (Phase B) |

### Fachliche Regeln

- WF2: Produktstamm, Alias, Lagercharge, Rechnungsvorschlaege.
- WF2: Nicht zustaendig fuer `active`, `machine_id`, `mdb_code`, `product_slot_id`.
- WF4: Einzige Quelle fuer aktive MDB-/Slot-Zuordnungen.
- `active = TRUE` = aktive Slotbelegung, nicht Produktexistenz.
- Kein Token/Secret direkt in Workflow-JSON – immer n8n-Credential.
- Keine automatische produktive Aenderung in Nayax/Moma.
- Google Sheets wird ausschliesslich ueber n8n Forms und Workflows gepflegt.
- Kleinunternehmer-Status (`kleinunternehmer_aktiv`) aus `GuV_Konfiguration` lesen,
  nicht hardcoden. Status kann sich aendern (2000-EUR-Umsatzgrenze je Monat).

### Hinweise fuer Claude Code

1. Zuerst `README.md`, `ARCHITECTURE.md` und `CLAUDE.md` lesen.
2. Keine Tokens oder Secrets in Workflow-JSONs schreiben – immer n8n-Credential.
3. Vor Workflow-Aenderungen klaeren: lokale JSON oder live n8n fuehrend?
4. WF3-Patches via n8n REST API (`PUT /api/v1/workflows/<id>`) sind bewaehrt –
   nicht via SDK rewrite (zu viele Nodes, zu fehleranfaellig).
   Achtung: Beim PUT nur erlaubte Workflow-Settings senden; nicht blind `wf.settings`
   aus einem GET zurueckschreiben.
5. n8n API-Key: in `dashboard/.dashboard-config.json` gespeichert (gitignored).
6. Google-Sheets-Credential ID fuer PUT-Requests: `5XfHt3SzjHCj8B5H` (Sheets Automatenlager).
7. WF2/WF4-Eigentuemer beachten: WF2 = Produkt/Lager/Rechnung, WF4 = Slot/Historie.
8. Patch-Skripte ablegen unter `guv_check_tmp/` (gitignored).
