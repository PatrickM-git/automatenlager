# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-27 (Session 22 - Umsatz-/Workflow-Reparatur auf HP Mini)

### Aktueller Stand

- Produktiver Host ist weiterhin der HP Mini im Homelab. Dashboard und n8n laufen dort.
- Neuer Umsatzfluss ist wieder hergestellt:
  - WF3 schreibt wieder nach `Verarbeitete_Transaktionen`.
  - WF8 aggregiert wieder nach `GuV_Tagesposten`.
  - Altes Dashboard `/api/guv?zeitraum=monat` zeigt Mai 2026 wieder mit aktuellen Umsaetzen.
- Alle produktiven Workflows sind aktiv: WF1, WF2, WF3, WF4, WF5, WF7, WF8, WF9, WF-PGW, WF-Monitor, WF-Val, WF-MatView-Refresh.
- Live-Scan gegen n8n: keine alten Credential-/PGW-IDs mehr in produktiven Workflows; keine beschaedigten `replace(/?/g...)`-RegExes mehr.

### Was repariert wurde

1. **WF3 Umsatzimport/FIFO**
   - Ursache: Live-WF3 verwies auf nicht vorhandene alte Nayax- und Google-Sheets-Credentials.
   - Fix: WF3 auf aktuelle Credential-IDs umgestellt.
   - Zusaetzlich gefixt: Encoding-Schaeden im FIFO-Code (`?const`, kaputte Umlaut-RegExes).
   - Beleg: WF3 Execution `815` erfolgreich, Start `2026-05-27T14:41:08.487Z`, Stopp `2026-05-27T14:41:21.791Z`.

2. **WF8 GuV-Aggregation**
   - Ursache: `Read - Verarbeitete_Transaktionen` nutzte `sheetName.mode=list` mit dem Namen als ID.
   - Fix: `sheetName.mode=name`, Wert `Verarbeitete_Transaktionen`.
   - Zusaetzlich gefixt: leere Aggregationslaeufe geben jetzt `return []` zurueck statt ein `_empty`-Item in Append-Pfade zu reichen.
   - Beleg: WF8 Execution `839` erfolgreich, Start `2026-05-27T14:50:30.078Z`, Stopp `2026-05-27T14:50:35.950Z`.
   - Trigger ist wieder Schedule-Trigger `Cron - Taeglich 02:00`.

3. **WF1/WF2 Latent-Fix**
   - Ursache: dieselben Encoding-Schaeden wie in WF3 lagen in den Normalisierungsfunktionen.
   - Fix: Umlaut-RegExes auf ASCII-sichere Unicode-Escapes umgestellt (`\u00e4`, `\u00f6`, `\u00fc`, `\u00df`, usw.).
   - Ergebnis: Code-Nodes parsen wieder syntaktisch sauber.

4. **Lokale Exporte synchronisiert**
   - Live-Workflows erneut aus n8n nach `C:/Users/patri/Documents/mein-erstes-Projekt/` exportiert.
   - `WF0 - product_slot_id Backfill.json` auf aktuelle Google-Sheets-Credential-ID aktualisiert.
   - Ungueltiges Steuerzeichen im lokalen WF5-Export entfernt.

### Live-Belege

- Legacy Dashboard:
  - `rowCount=135`, `totalRows=456`
  - Mai 2026: `umsatz_brutto=238,40`, `wareneinsatz_brutto=134,83`, `guv=103,57`, `quantity_sold=182`, `marge=43,4`
- Dashboard v2 Economics:
  - `ok=True`, `source=postgres`
  - Mai 2026: `revenue_net=213,04`, `db_net=103,57`, `qty=182`
- Postgres:
  - `automatenlager.guv_daily` Mai 2026: `135` Zeilen, letzter Tag `2026-05-27`, `revenue_gross=238.40`, `revenue_net=213.04`, `quantity_sold=182`

### Tests

- `C:/Users/patri/Documents/mein-erstes-Projekt/dashboard`: `npm test` -> 72/72 gruen.
- `C:/Users/patri/Documents/homelab`: Workflow-JSON-/GuV-/Monitor-/Validation-Tests -> 29/29 gruen.
- Homelab Dual-Write-Integrationstests wurden ausgefuehrt und bleiben erwartungsgemaess `SKIP` (2 skipped).
- Lokale Workflow-JSONs:
  - alle `WF*.json` parsebar
  - keine alten Credential-/PGW-IDs
  - alle Code-Nodes syntaktisch parsebar

### Aktuelle Live-IDs

| WF | ID | Status |
|---|---|---|
| WF1 | `wnGAwHhgfXq2ATM8` | aktiv |
| WF2 | `X2RU2cHm78rkIWMf` | aktiv |
| WF3 | `wbOhFKXQqBpJWB1w` | aktiv |
| WF4 | `6tOZnWsxBNzHaVqA` | aktiv |
| WF5 | `3ceKeNWmdj455Tcr` | aktiv |
| WF7 | `0oRIiVFr5Q7FF6ow` | aktiv |
| WF8 | `gyM9rnvUMfnv4x3G` | aktiv |
| WF9 | `nh8Tmg7klwGVjKui` | aktiv |
| WF-PGW | `Sajezv8tJll0CLIv` | aktiv |
| WF-Monitor | `EdgUfv1lMcE25Z3K` | aktiv |
| WF-Val | `pdIjiyIfVIIPuJIt` | aktiv |
| WF-MatView-Refresh | `axeg30n8SVKlCW54` | aktiv |

### Aktuelle Credential-IDs

| Was | ID / Name |
|---|---|
| Google Sheets | `6GG86fWHw536Rk36` / `Google Sheets API` |
| Google Drive | `kOLyDv48afTu5P9q` / `Google Drive account` |
| Nayax Lynx | `6JLrl6bb2ns3ISYe` / `Nayax Lynx API` |
| PostgreSQL Homelab | `Jept3990Uq8aN3Tr` / `PostgreSQL` |
| WF-PGW | `Sajezv8tJll0CLIv` |

### Letzter abgeschlossener Schritt

- Live-Reparatur validiert, lokale Workflow-Exporte aktualisiert, Homelab-Test fuer aktuelle WF-PGW-ID korrigiert, Tests gruen.

### Naechster geplanter Schritt

1. Nach User-Freigabe committen und pushen.
2. Nach dem naechsten regulaeren WF8-Lauf um 02:00 Uhr kontrollieren, dass keine Duplikate und keine `_empty`-Zeilen entstehen.
3. Beim naechsten echten Rechnungseingang WF1/WF2 einmal mit einem realistischen Dokument beobachten, weil dort heute ein latenter Encoding-Fehler gefixt wurde, aber kein kompletter produktiver Rechnungsdurchlauf getriggert wurde.

### Offene TODOs

1. **Hoch**: entscheiden, ob `C:/Users/patri/Documents/automatenlager` als alte Arbeitskopie archiviert oder geloescht werden soll. Sie enthaelt alte IDs und kann kuenftig verwirren.
2. **Mittel**: Workflow-Exports perspektivisch ohne `activeVersion`-Doppelung exportieren oder Tests dagegen robust halten.
3. **Mittel**: Monitoring um expliziten Check fuer alte Credential-IDs und `sheetName.mode=list` bei Namens-Sheets erweitern.
4. **Niedrig**: historische HANDOVER-Archive enthalten erwartungsgemaess alte IDs; nicht als Live-Quelle verwenden.

### Bekannte Probleme / Workarounds

- N8n-API `PUT /api/v1/workflows/{id}` akzeptiert keine Readonly-Felder aus dem GET-Response. Beim Patchen nur `name`, `nodes`, `connections`, `settings` senden.
- Google-Sheets-Node muss bei Sheetnamen `sheetName.mode=name` verwenden. `mode=list` interpretiert `value` als Sheet-ID.
- `ConvertTo-Json`/PowerShell-Export kann rohe Steuerzeichen aus Workflow-Code-Kommentaren durchreichen. Lokale JSONs danach mit Node parsen/sanitisieren.

### Architekturentscheidungen dieser Session

- Live n8n bleibt Source of Truth fuer produktive Workflow-Konfiguration; lokale `WF*.json` werden als synchronisierte Exporte behandelt.
- WF8 bleibt beim sicheren Append-plus-Existing-Key-Skip-Modell. Kein Composite-Upsert ueber Google Sheets.
- RegExes fuer deutsche Umlaute in n8n-Code werden ASCII-sicher als Unicode-Escapes geschrieben, um Encoding-Schaeden beim Export/Import zu vermeiden.
