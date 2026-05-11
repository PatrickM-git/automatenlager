# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-11 (Session 3 – GuV-System)

### Kurzfassung

Das Projekt ist ein n8n-basiertes Automatenlager-System mit Google Sheets als Arbeits- und Logschicht.
Es verarbeitet Rechnungen, Produktvorschlaege, Nayax-Verkaeufe, FIFO-Lagerchargen, MDB-/Slot-Historisierung
und MHD-/Bestandswarnungen. In dieser Session wurde das GuV-System (Gewinn und Verlust) begonnen.

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
- `WF2` – Smart Product Selection / Rechnungsvorschlaege
- `WF3` – Nayax Lynx FIFO Lagerbestand **(Phase A2 erweitert)**
  - Jetzt: `vk_preis_brutto`, `umsatz_brutto`, `mdb_code_extracted`, `batch_id_abgebucht`
  - Nayax-Credential: erledigt, live WF3 nutzt n8n HTTP-Header-Auth-Credential `Nayax Bearer`
- `WF4` – MDB Produktzuordnung bearbeiten (Slot-Historisierung)
- `WF5` – MHD und niedrige Lagercharge ueberwachen
- `WF7` – GuV Sheets Setup (ID: `d6JoXqhfTOuvRKVv`, einmalig ausgefuehrt)

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

### Naechste konkrete Schritte (nach Phase A2)

#### Phase A3: WF1/WF2 erweitern – MwSt und Netto-EK aus Rechnung
- In WF2 beim Anlegen/Aktualisieren von Lagerchargen: `mwst_satz` schreiben
  (7 % fuer Snacks, 19 % fuer Getraenke – aus Rechnungsposition oder aus Produkt-Stammdaten)
- In WF2: Netto-EK (`ek_preis_netto`) aus Rechnungsbetrag / (1 + MwSt) berechnen

#### Phase A4: WF8 GuV-Aggregator bauen
- Taeglich per Cron (z.B. 02:00 Uhr)
- Fuer jeden Verkaufstag / jede Maschine: FIFO-Wareneinsatz berechnen
  - `wareneinsatz_brutto = sum(qty * ek_preis_brutto)` aus abgebuchten Chargen
  - `kleinunternehmer_aktiv` aus `GuV_Konfiguration` lesen
  - `guv = umsatz_brutto - wareneinsatz_brutto`
- Ergebnisse in `GuV_Tagesposten` schreiben

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
- Bei zukuenftigen Google-Sheets-Spaltenerweiterungen in n8n immer den betroffenen
  Google-Sheets-Node oeffnen, Fields/Columns refreshen und neu speichern. Sonst kann n8n mit
  `Column names were updated after the node's setup` abbrechen.
- WF5 lokal korrigiert (Bestandslogik), aber noch nicht in n8n live getestet/importiert.
- Phase A3–A8 noch offen.
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
