# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-24 (Session 20 – Read-Only-Gastzugriff auf Mini deployed)

### Diese Session

1. **Dashboard auf HP Mini aktualisiert**
   - `dashboard/server.js`, `dashboard/public/*`, `dashboard/package.json` und `dashboard/tests/*` nach `C:\homelab\projekte\automatenlager\dashboard` kopiert.
   - `C:\homelab\docker-compose.yml` aktualisiert und `DASHBOARD_ADMIN_LOGIN` an den Container durchgereicht.
   - `homelab-dashboard` per Docker Compose neu gebaut/gestartet.

2. **Read-Only-Sicherheit nachgeschaerft**
   - `Tailscale-User-Login: lantspeku@gmail.com` wird als `guest` erkannt.
   - `POST /api/actions/invoice-intake/trigger` gibt fuer diesen Gast `403` zurueck.
   - Tailnet-Hosts ohne Identity-Header laufen jetzt ebenfalls als `unknown-guest`; nur `localhost`/`127.0.0.1` ohne Header bleibt lokaler Admin-Modus.

3. **Tests**
   - Lokal im Repo: `npm test` unter `dashboard` -> **7/7 gruen**.
   - Live im Container: `npm test` unter `homelab-dashboard` -> **7/7 gruen**.
   - Live ueber Tailscale-IP: ohne Header `unknown-guest`, mit `lantspeku@gmail.com` Gast; beide Trigger-POSTs auf `invoice-intake` -> `403`.

### Nächster Schritt

- Finale Tailscale-Invite/ACL-Aktivierung wurde am 2026-05-24 durchgefuehrt.
- Echtes Gastgeraet `galaxy-xcover7` ist im Tailnet sichtbar und Dashboard-Zugriff funktioniert.
- Issue #11 kann geschlossen werden.

---

## Stand: 2026-05-23 (Session 19 – Snickers/Creamy Produktmapping korrigiert)

### Diese Session

1. **Nayax-XLSX gegen Google Sheets vollstaendig revalidiert**
   - Quelle: `C:/Users/patri/Downloads/DynamicTransactionsMonitorMega_2026-05-22T183329.xlsx`
   - Erfolgreiche Nayax-Transaktionen im Zeitraum 01.05.–22.05.2026: **157**
   - Umsatzsumme: **207,80 EUR**
   - Produktmapping-Check gegen `Verarbeitete_Transaktionen`: nach Fix **0 Mismatches**

2. **Snickers Cream Peanut Butter korrekt umgebucht**
   - Falsch zugeordnet waren genau 2 Transaktionen:
     - `6779304800`
     - `63107529742`
   - Beide wurden von `SKU_SNICKERS` auf `SKU_SNICKERS_CREAMY` korrigiert.
   - `mdb_code_extracted` wurde auf `12` gesetzt.
   - `batch_id_abgebucht` wurde auf `B_SNICKERS_CREAMY_20260502_1` gesetzt.
   - Creamy-Charge `B_SNICKERS_CREAMY_20260502_1`: `remaining_qty` von 23 auf **21** korrigiert.

3. **Mai-GuV neu aufgebaut**
   - Alle Mai-Zeilen in `GuV_Tagesposten` wurden per temporaerem n8n-Workflow geloescht und aus korrigierten Transaktionen neu aufgebaut.
   - Ergebnis fuer 01.05.–23.05.2026:
     - Umsatz: **207,80 EUR**
     - Wareneinsatz: **109,57 EUR**
     - GuV: **98,23 EUR**
     - Stueck verkauft: **157**
   - Snickers-Aggregat:
     - `SKU_SNICKERS`: **20 Stück**
     - `SKU_SNICKERS_CREAMY`: **2 Stück**

### Nächster Schritt

- Dashboard hart neu laden und Zeitraum `2026-05-01` bis `2026-05-23` prüfen.
- Erwartung: Snickers = 20 Stück, Snickers Cream Peanut Butter = 2 Stück.
- Tailscale-/Guest-Access-Aktivierung bleibt weiterhin separat und erst nach Patricks Signal.

---

## Stand: 2026-05-23 (Session 18 – Dashboard Read-Only-Gastzugriff)

### Diese Session

1. **Issue #11 Dashboard-Auth umgesetzt**
   - Dashboard liest `Tailscale-User-Login`.
   - Kein Header bleibt lokaler Admin-Modus.
   - Logins aus `DASHBOARD_ADMIN_LOGIN` oder beginnend mit `patrick` sind Admins.
   - Alle anderen Logins sind Gaeste/Read-Only.

2. **Gast-Trigger serverseitig blockiert**
   - `POST /api/actions/:id/trigger` antwortet fuer Gaeste mit `403`.
   - Admins koennen runnable Workflow-Aktionen weiterhin starten.

3. **Read-Only-UI ergaenzt**
   - Workflow-Triggerbuttons werden fuer Gaeste nicht gerendert.
   - Renderlogik liegt in `dashboard/public/workflow-actions-view.js` und wird separat getestet.

4. **Gast-Audit vorbereitet**
   - Gastzugriffe werden als JSONL unter `dashboard/logs/guest-access.jsonl` geschrieben.
   - Pfad ist per `DASHBOARD_AUDIT_LOG` ueberschreibbar.

5. **Tests eingefuehrt**
   - `dashboard/package.json`: `npm test` nutzt `node --test`.
   - Tests liegen unter `dashboard/tests/`.
   - Abgedeckt: Gast-403, Admin-Trigger, Viewer-Permissions, Gast-Audit, Read-Only-Rendering.

### Nächster Schritt

- Browser-QA lokal durchfuehren.
- Danach Dashboard auf den HP Mini deployen.
- `DASHBOARD_ADMIN_LOGIN` auf dem Mini setzen.
- Tailscale-ACL laut `homelab/docs/runbooks/guest-access.md` erst mit echtem Gast-Login und auf Patricks Signal aktivieren.

---

## Stand: 2026-05-23 (Session 17 – GuV Mai-Reconciliation + WF8 Safe Append)

### Diese Session

1. **Mai-Umsatz gegen Nayax-XLSX vollständig abgeglichen**
   - Quelle: `C:/Users/patri/Downloads/DynamicTransactionsMonitorMega_2026-05-22T183329.xlsx`
   - Nayax Mai 2026: **164 Verkaufstransaktionen / 207,80 EUR**
   - Nach Fix live verifiziert:
     - `Verarbeitete_Transaktionen` Mai: **207,80 EUR**
     - `GuV_Tagesposten` Mai: **207,80 EUR**
     - `GuV aggregate diffs vs VT`: keine Differenzen

2. **Fehlende/fehlerhafte VT-Zeilen korrigiert**
   - Neu/korrekt in `Verarbeitete_Transaktionen`:
     - `63121531754` – Skittles fruit, 08.05.2026, 1,00 EUR
     - `63121597180` – Red Bull Spring, 08.05.2026, 2,00 EUR
     - `63121611502` – Nick Nacks, 08.05.2026, 1,40 EUR
   - Bestehende VT-Zeilen korrigiert:
     - `6724461310` – Falcone Nussnougat, `umsatz_brutto` von 0 auf 1,20 EUR
     - `6751983710` – M&M's MDB 64, GuV-Umsatz 1,20 EUR gesetzt; Lagerbestand laut User verifiziert, kein zusätzlicher Lagerabzug

3. **`GuV_Tagesposten` für Mai sauber neu aufgebaut**
   - 114 fehlerhafte Mai-GuV-Zeilen gelöscht
   - 115 korrekte Mai-Aggregate aus `Verarbeitete_Transaktionen` neu geschrieben
   - Ergebnis: `GuV_Tagesposten` Mai = **207,80 EUR**

4. **WF8-Ursache behoben**
   - Ursache: Google-Sheets-Node `appendOrUpdate` mit mehreren `matchingColumns` (`date`, `machine_id`, `product_key`) verhält sich nicht als sicherer Composite-Key und überschreibt falsche Produktzeilen.
   - Fix live auf HP Mini WF8 `AMXktRs6Z28FuzSE` eingespielt und lokales JSON aktualisiert:
     - zurück auf `operation: append`
     - Existing-Key-Skip im Code wieder aktiviert
     - Preis-Fallback aus `Produkte.sale_price_eur` beibehalten
   - Live verifiziert: WF8 aktiv, Operation `append`, `matchingColumns=[]`, Existing-Key-Skip und Preis-Fallback vorhanden.

5. **Temporäre n8n-Backfill-Workflows bereinigt**
   - Temporäre Workflows wurden deaktiviert und gelöscht:
     - `AIvVCQ4NcnBsjRlh`
     - `5OFAl3jhMM5RNjMT`
     - `uxjwtA4dchicWKe7`

### Nächster Schritt

- Dashboard prüfen: Zeitraum Mai/Gesamt muss jetzt 207,80 EUR Umsatz für Mai zeigen.
- WF8 nach dem nächsten 02:00-Lauf kontrollieren: Es dürfen keine neuen Duplikate entstehen; durch Existing-Key-Skip sollte der Lauf bei bestehenden Mai-Keys nichts überschreiben.
- Für Phase 1 mittelfristig echten technischen Aggregat-Key einführen (`guv_key = date|machine_id|product_key`) oder PostgreSQL als Upsert-Ziel nutzen; Google Sheets Composite-Upsert nicht mehr verwenden.

---

## Stand: 2026-05-20 (Session 16 – WF3 Multi-Slot MDB-Fix)

### Diese Session

1. **WF3 MDB-Kontrolle für Produkte auf mehreren Slots gefixt**:
   - **Problem**: `MDB-Kontrolle für Lichtenauer still(47 = 1.50): erwartet 57, Nayax meldet 47. Verkauf wird weiter verarbeitet.` → falsche Warnung + Mail
   - **Ursache**: Lichtenauer still ist auf **zwei aktiven Slots** (MDB 47 UND MDB 57). `findProductByName` gab den Slot mit MDB 57 zurück (erster Treffer). Die Mismatch-Prüfung `expectedMdb !== mdbCode` erkannte zwar, dass es kein *anderes* Produkt auf MDB 47 gibt, aber nicht, dass das *gleiche* Produkt dort ebenfalls aktiv ist → `MDB_CODE_CHANGED_FOR_PRODUCT` fälschlicherweise
   - **Fix**: In `getProductForSale` (Node `Code - FIFO berechnen`): Vor dem `differentProductOnActualMdb`-Zweig neuer Multi-Slot-Check: Wenn `productOnActualMdb.product_key === product.product_key` → `reason: 'OK'` + `product` auf den korrekten Slot-Eintrag (mit MDB 47) umbiegen, damit `queueProductQtyDeduction` den richtigen `product_slot_id` nutzt
   - Patch direkt via n8n REST API eingespielt (`PUT /api/v1/workflows/2PFfPf0sVmMW7Fpp`)
   - Gepatchter Code: `guv_check_tmp/fifo_code_original.js`
   - Lokales JSON aktualisiert: `WF3 Nayax Lynx FIFO Lagerbestand - manueller Abruf - mit WF4 Integration.json`

2. **Fehler_und_Hinweise-Bereinigung**: Nicht durchgeführt (kein sicherer Zeilen-Identifier ohne Live-Sheet-Lesezugriff). Bereits existierende Warnung bleibt im Sheet — wird beim nächsten WF3-Lauf nicht mehr neu erzeugt.

---

## Stand: 2026-05-20 (Session 15 – WF1 Claude-JSON-Fix + Webhook-Diagnose)

### Diese Session

1. **WF1 Claude-Node JSON-Fehler behoben**:
   - Problem: `Claude - Rechnung auslesen` warf `The value in the "JSON Body" field is not valid JSON` bei großen PDFs (Position 41694)
   - Ursache: `jsonBody` war ein n8n-Template-String `={"data":"{{ $json.file_base64 }}"}` — n8n-Template-Engine scheitert bei sehr langen base64-Strings daran, das Ergebnis als JSON zu parsen
   - Fix: `Code - Claude Input vorbereiten` baut jetzt den gesamten Claude-API-Request via `JSON.stringify()` und gibt ihn als `claude_request_body` weiter
   - `Claude - Rechnung auslesen` jsonBody = `={{ $json.claude_request_body }}` (vorberechneter String, kein Template mehr)
   - Patch direkt via n8n REST API eingespielt (`PUT /api/v1/workflows/dKNRRxkCPmVsArJ0`) — kein Import nötig
   - Patch-Script: `guv_check_tmp/patch_wf1_api.js`
   - Lokales JSON aktualisiert: `WF1 - Rechnungseingang automatisch mit Claude.json`

2. **WF1 Webhook-Diagnose**:
   - Problem: Webhook wurde nicht automatisch durch Google Drive ausgelöst
   - Ursache: n8n läuft auf `127.0.0.1:5678` — Google Drive Push-Notifications können Localhost nicht erreichen
   - WF1 sucht Google Drive selbst ab (`Google Drive - Rechnungen suchen1` via Drive API), der Webhook muss nur den Start anstoßen
   - Lösung: Webhook bleibt für manuelles Auslösen erhalten (Dashboard-Button "Workflow starten" funktioniert, da Dashboard ebenfalls auf Localhost läuft)
   - Kein Schedule Trigger gewünscht — Auslösung nur manuell via Dashboard oder n8n Manual Trigger

3. **WF1 ID ermittelt**: `dKNRRxkCPmVsArJ0`

---

## Stand: 2026-05-19 (Session 14 – WF5 Email-Dedup-Fix)

### Diese Session

1. **WF5 Duplikat-Warnungen in E-Mail behoben**:
   - Problem: LOW_BATCH-Warnungen für dasselbe Produkt erschienen doppelt in "Sonstige Hinweise" (z.B. Red Bull, Snickers, Erdnüsse, Cola Zero, Capri Sun)
   - Ursache: `Code - Email Zusammenfassung erstellen` kombiniert Alerts aus zwei Pfaden (Code-MHD frische Alerts + Code-Offene-Hinweise Sheet-Einträge) ohne Cross-Pfad-Dedup
   - Fix: `// PATCH EMAIL_DEDUP` in `Code - Email Zusammenfassung erstellen` eingefügt — dedup nach `type::product_key`, bevorzugt Eintrag mit MDB-Code
   - Patch-Script: `guv_check_tmp/patch_wf5_email_dedup.js`
   - Lokales JSON aktualisiert: `WF5 - MHD und niedrige Lagercharge ueberwachen.json`

---

## Stand: 2026-05-18 (Session 13 – WF7/WF8/WF9 JSON-Export aktualisiert)

### Diese Session

1. **WF7/WF8/WF9 JSON-Exporte aktualisiert** (Vorbereitung Miniserver-Migration):
   - `WF7 - Nachfuellung melden.json` → Stand 2026-05-13 (13 Nodes)
   - `WF8 - GuV Tagesposten Aggregator.json` → Stand 2026-05-15 (8 Nodes) — war veraltet (2026-05-12)
   - `WF9 - Pickliste verarbeiten.json` → Stand 2026-05-18 (23 Nodes)
   - Alle WF1–WF9 haben jetzt aktuelle JSON-Exporte im Projektordner ✅

---

## Stand: 2026-05-18 (Session 11+12 – Historischer Abgleich + GuV-Backfill abgeschlossen)

### Diese Session

1. **Duplo MHD-Bereinigung**: Status → `abgelaufen` gesetzt (MHD 2026-05-18 erreicht).
   - Physische Entnahme durch User geplant: 2026-05-19
   - Duplo bleibt im Sheet bis User die Checkliste manuell einträgt (s.u.)

2. **Historischer Abgleich abgeschlossen (manuell verifiziert)**:
   - 43 `INSUFFICIENT_BATCH_STOCK`-Einträge in `Verarbeitete_Transaktionen` analysiert
   - Diese sind **kein Fehler** — Artefakt des Cutover-Prozesses (Bestandsaufnahme 02.05. hatte Vorverkäufe bereits eingerechnet)
   - User hat alle Werte physisch nachgezählt und alle Rechnungen hochgeladen
   - **Google Sheets ist verifizierte Single Point of Truth** — keine Script-Korrekturen nötig/erlaubt
   - Wichtige Korrekturen durch User: Snickers initial_qty 77→17 (Handschrift-Lesefehler korrigiert), Falcone Nussnougat remaining=19 ✅, Red Bull remaining=4 ✅

3. **Pick Up vorbereitet**: Produkt existiert (SKU_PICK_UP, Zeile 49 Produkte, Zeile 43 Lagerchargen, 22 Stück, MHD Sep 2026). Checkliste für manuelle Eintragung erstellt.

4. **M&M's MDB 64 aufgelöst**: Alias "M&M's" → SKU_M_AND_M_CRISPY in Produkt_Aliase eingetragen. VT-Eintrag 6751983710 als MANUALLY_RESOLVED markiert. WF4-Mapping für zukünftige Transaktionen bereit.

5. **GuV historisches Backfill abgeschlossen** ✅:
   - Quelle: `_nayax_sales.json` (alle 491 Transaktionen, Okt 2025 – Mai 10, 2026)
   - 397 neue Einträge in `GuV_Tagesposten` geschrieben (Batches via n8n)
   - Umsatz: **€710,30** | GuV: **€376,35** für den historischen Zeitraum
   - Dedup-Mechanismus (date|machine_id|product_key) verhindert Doppler mit WF8
   - WF8 läuft ab Mai 11 täglich weiter, keine Konflikte
   - Backfill-Script: `guv_check_tmp/guv_historic_backfill.js` (idempotent, nochmals ausführbar)
   - **Dashboard zeigt jetzt GuV ab Okt 2025** — Zeitraum "Gesamt" auswählen

---

### Offene User-Aktionen (morgen, 2026-05-19)

**Pick Up in Automat einsetzen + Google Sheets manuell befüllen:**

| Sheet | Zeile | Feld | Wert |
|---|---|---|---|
| Produkte | 49 | `mdb_code` | 10 |
| Produkte | 49 | `active` | TRUE |
| Produkte | 49 | `replenishment_status` | aktiv |
| Produkte | 49 | `sale_price_eur` | (nach Preisangabe) |
| Produkte | 49 | `target_stock` | 12 |
| Produkte | 49 | `machine_capacity` | 12 |
| Produkte | 49 | `current_machine_qty` | (wie viele eingelegt) |
| Produkte | 49 | `valid_from` | 2026-05-19 |
| Lagerchargen | 43 | `status` | aktiv |
| Lagerchargen | 2 (Duplo) | `status` | ausgesondert |
| Lagerchargen | 2 (Duplo) | `remaining_qty` | 0 |
| Produkte | 2 (Duplo) | `active` | FALSE |
| Produkte | 2 (Duplo) | `current_machine_qty` | 0 |

---

### Offene technische Punkte

**MHD-nahe Produkte (in den nächsten 2 Wochen):**
- Nick Nacks: MHD 2026-05-27 (9 Tage), remaining=22, in_machine=5 → Neueinkauf planen
- Twix Salted Caramel: MHD 2026-05-31 (13 Tage), remaining=16, in_machine=13 → Neueinkauf planen

**WF3 läuft korrekt** — INSUFF-Einträge aus Catchup sind bekannte historische Artefakte, kein Handlungsbedarf.

**GuV Dashboard**: Zeitraum "Gesamt" oder "Jahr" wählen, um historische Daten ab Okt 2025 zu sehen.

---

### Wichtige Grundsätze (unveränderlich)

- **Google Sheets = Single Point of Truth** — Scripts dürfen `remaining_qty`/`initial_qty` nur mit expliziter User-Freigabe ändern
- **INSUFFICIENT_BATCH_STOCK** in `Verarbeitete_Transaktionen` = historisches Artefakt, kein Bug
- Neue Verkäufe: WF3 bucht korrekt ab (Status OK)
- Neue Einkäufe: WF1 → WF2 → Lagercharge anlegen

---

## Workflows (Übersicht)

| WF | ID | Status | Beschreibung |
|---|---|---|---|
| WF1 | dKNRRxkCPmVsArJ0 | aktiv | Rechnungseingang mit Claude |
| WF2 | — | aktiv | Smart Product Selection, Freigabe |
| WF3 | 2PFfPf0sVmMW7Fpp | aktiv | Nayax FIFO Lagerbestand (manueller Abruf) |
| WF4 | — | aktiv | MDB Produktzuordnung |
| WF5 | A1TQ7CnHXonafVIv | aktiv | MHD + niedrige Lagercharge (tägl. 07:00) |
| WF6 | 5ODAKv8R4Qahh1Ce | inaktiv | Produktstatus neu berechnen (alt) |
| WF7 | nla63DjpTgJrFXDj | aktiv | Nachfüllung melden (Webhook GET) |
| WF8 | qwpQMhZqDAIs8Wi9 | aktiv | GuV Tagesposten Aggregator (tägl. 02:00) |
| WF9 | UtXagT58XYNwxUM5 | aktiv | Pickliste verarbeiten (Drive PDF → Batch-Refill) |

---

## Wichtige IDs und Pfade

| Was | Wert |
|---|---|
| Google Sheet ID | `12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo` |
| Google Sheets Credential ID | `5XfHt3SzjHCj8B5H` |
| Google Drive Credential ID | `UcOBo2UdCzAv1SBG` |
| Maschinen-ID (Nayax Haupt) | `457107528` |
| Nayax Maschinenname | CR-FCRvMMfAiraF |
| WF3 ID | `2PFfPf0sVmMW7Fpp` |
| WF5 ID | `A1TQ7CnHXonafVIv` |
| WF7 ID | `nla63DjpTgJrFXDj` |
| WF8 ID | `qwpQMhZqDAIs8Wi9` |
| WF1 ID | `dKNRRxkCPmVsArJ0` |
| WF9 ID | `UtXagT58XYNwxUM5` |
| WF9 Webhook-Path | `pickliste-verarbeiten` |
| WF9 Pickliste-Ordner (unbearbeitet) | `1Djrp-44NtazCB3pa-07S-uK769gJ2ZcS` |
| WF9 Pickliste-Ordner (archiviert) | `1mOMTE-vTAKFqOO5DW_q9UQ1Hgd7MHV38` |
| Dashboard | `http://127.0.0.1:8787/` |
| GuV-Endpoint | `http://127.0.0.1:8787/api/guv` |
| n8n | `http://127.0.0.1:5678/` |
| Projekt-Root | `C:/Users/patri/Documents/mein-erstes-Projekt/` |

---

## Nayax-Endpoint-Status

Nur `/operational/v1/machines/{id}/lastSales` → 200. Alle anderen → 404.
Auto-Refill-Inferenz in WF3 ist der einzige Mechanismus.

---

## Modell-Semantik (unveränderlich)

- `Lagercharge.remaining_qty` = TOTAL physisch (Slot + Backstock)
- `Produkte.current_machine_qty` = nur Slot (Subset)
- Slot-Updates → Lager bleibt unverändert
- Verkauf → beide reduziert
- WF9-Refill → nur `current_machine_qty` erhöht, `remaining_qty` unverändert

---

## Cutover-Kontext (historisch, für WF3-Verständnis)

- Cutover: `2026-05-02T10:00:00Z` (12:00 Uhr MESZ)
- Bestandsaufnahme am 02.05. hat Vorverkäufe bereits eingerechnet
- `SKIPPED_BEFORE_CUTOVER` und `INSUFFICIENT_BATCH_STOCK` im Catchup = erwartetes Verhalten, kein Fehler
- Ab Cutover laufen alle WF3-Buchungen korrekt als `OK`
