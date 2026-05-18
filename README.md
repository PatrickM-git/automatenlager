# Automatenlager n8n Leitstand

Dieses Projekt baut ein robustes n8n-System fuer Automatenverkaeufe, FIFO-Lagerabbuchung, Produktwechsel, MDB-Slot-Zuordnungen und Lager-/MHD-Kontrolle auf Basis von Nayax/Moma-Daten und Google Sheets.

Das Ziel ist ein operatives System, das Nayax-Verkaeufe automatisch verarbeitet, Lagerchargen per FIFO abbucht, Produkt- und MDB-Wechsel historisiert, Datenabweichungen sichtbar macht und manuelle Eingriffe ueber n8n Forms minimiert. Google Sheets bleibt dabei Arbeitsgrundlage und Logsystem, nicht die manuell gepflegte Wahrheit.

## Aktueller Entwicklungsstand

- WF0 bis WF5 und WF8 liegen als n8n-Workflow-JSONs im Projekt.
- WF1 startet WF2 nach dem Rechnungseingang.
- WF2 verarbeitet Produktstamm, Aliase, Lagerchargen und Rechnungsvorschlaege. Slotzuordnungen sollen nicht direkt in WF2 gesetzt werden.
- WF2 kann WF4 optional ausloesen, wenn ein neues Produkt direkt einem Automaten/MDB-Slot zugeordnet werden soll.
- WF3 verarbeitet Nayax-Verkaeufe mit FIFO-Abbuchung. ProductName bleibt vorerst das fuehrende Matching, MDB-Code ist Kontrollsignal.
- WF3 kann WF4 bei MDB-Abweichungen vorbereiten, ohne Verkaeufe hart zu blockieren.
- WF4 ist die einzige fachliche Wahrheit fuer aktive MDB-/Slot-Zuordnungen, product_slot_id, active TRUE/FALSE und Historisierung.
- WF5 ueberwacht MHD, niedrige Lagerbestaende und Tagesverkaeufe und erstellt eine Mail-Zusammenfassung. Die lokale JSON rechnet `Bestand gesamt` aus aktiven Lagerchargen, ohne den Automatenbestand doppelt zu zaehlen.
- WF8 aggregiert GuV-Tagesposten aus Verkaufstransaktionen.
- Ein lokales Dashboard unter `dashboard/` zeigt Workflows, Live-n8n-Status, Google-Sheets-/XLSX-Datenqualitaet, GuV-KPIs ueber `/api/guv` und Buttons zum Starten bzw. Oeffnen der wichtigsten Workflows.
- WF0 ist ein einmaliger Reparaturworkflow fuer product_slot_id-Backfill und gehoert nicht zum laufenden Tagesbetrieb.

## Tech-Stack

- n8n Self Hosted, Zielversion 2.18.5
- Nayax Lynx API und Moma als operative Automaten-/Produktdatenquelle
- Google Sheets als Arbeitsgrundlage und Logsystem
- Node.js fuer das lokale Dashboard
- Plain HTML, CSS und JavaScript fuer das Dashboard-Frontend
- XLSX-Datei als lokale Daten-Snapshot-/Importbasis
- SMTP/Gmail bzw. Mail-Node fuer Benachrichtigungen aus WF5

Das Dashboard verwendet aktuell keine externen npm-Abhaengigkeiten. Der Server basiert auf Node.js-Bordmitteln wie `http`, `fs`, `path`, `url` und `zlib`.

## Start und Ausfuehrung

### Dashboard starten

```powershell
cd dashboard
npm start
```

Danach ist das Dashboard lokal erreichbar unter:

```text
http://127.0.0.1:8787/
```

### Dashboard mit n8n verbinden

Im Ordner `dashboard/` liegt eine Beispielkonfiguration:

```text
dashboard/.env.example
```

Fuer Live-Zugriff auf n8n lokal eine nicht versionierte Datei anlegen:

```text
dashboard/.env.local
```

Inhalt:

```text
N8N_BASE_URL=http://127.0.0.1:5678
N8N_API_KEY=deinen_n8n_api_key_hier_einfuegen
```

`dashboard/.env.local` ist absichtlich in `.gitignore`, damit API-Keys nicht committed werden.

### Autostart des Dashboards

Fuer Windows liegt ein lokales Autostart-Skript bei:

```powershell
.\dashboard\create-dashboard-startup-shortcut.ps1
```

Das Skript erzeugt eine Windows-Startup-Verknuepfung, die `dashboard/start-dashboard-hidden.vbs` und `dashboard/start-dashboard.ps1` nutzt. n8n selbst muss separat laufen.

### n8n-Workflows verwenden

Die Workflow-Dateien koennen in n8n importiert oder mit den live vorhandenen Workflows abgeglichen werden. Fuer aktive Dashboard-Buttons brauchen die jeweiligen Workflows in n8n einen nutzbaren Form-Trigger oder Webhook und muessen in n8n published/active sein.

## Projektstruktur

```text
.
|-- README.md
|-- ARCHITECTURE.md
|-- CLAUDE.md
|-- HANDOVER.md
|-- HANDOVER_ARCHIVE/
|-- WF0 - product_slot_id Backfill.json
|-- WF1 - Rechnungseingang automatisch mit Claude.json
|-- WF2 - Smart Product Selection - Rechnungsvorschlaege freigeben.json
|-- WF3 Nayax Lynx FIFO Lagerbestand - manueller Abruf - mit WF4 Integration.json
|-- WF4 - MDB Produktzuordnung bearbeiten.json
|-- WF5 - MHD und niedrige Lagercharge ueberwachen.json
|-- WF8 - GuV Tagesposten Aggregator.json
|-- nayax_lager_google_sheets_import_aktualisiert_v3_kitkat_2026-05-02.xlsx
`-- dashboard/
    |-- package.json
    |-- server.js
    |-- .env.example
    |-- public/
    |   |-- index.html
    |   |-- app.js
    |   `-- styles.css
    |-- start-dashboard.ps1
    |-- start-dashboard-hidden.vbs
    |-- register-dashboard-autostart.ps1
    `-- create-dashboard-startup-shortcut.ps1
```

### Root-Dateien

- `CLAUDE.md`: Arbeitsanweisungen fuer Claude Code und andere KI-Agenten.
- `HANDOVER.md`: Aktueller Uebergabestand.
- `HANDOVER_ARCHIVE/`: Archiv alter Handover-Staende.
- `WF0 - product_slot_id Backfill.json`: Einmaliger Reparaturworkflow fuer aktive Produktzeilen ohne `product_slot_id`.
- `WF1 - Rechnungseingang automatisch mit Claude.json`: Rechnungseingang, KI-Auswertung und Start von WF2.
- `WF2 - Smart Product Selection - Rechnungsvorschlaege freigeben.json`: Rechnungsvorschlaege, Produktstamm, Aliase und Lagerchargen.
- `WF3 Nayax Lynx FIFO Lagerbestand - manueller Abruf - mit WF4 Integration.json`: Nayax-Verkaeufe, FIFO-Abbuchung und MDB-Kontrolllogik.
- `WF4 - MDB Produktzuordnung bearbeiten.json`: Historisierte MDB-/Slot-/Produktzuordnung.
- `WF5 - MHD und niedrige Lagercharge ueberwachen.json`: MHD- und Lagerbestandspruefung mit Benachrichtigung.
- `WF8 - GuV Tagesposten Aggregator.json`: Aggregiert `Verarbeitete_Transaktionen` zu `GuV_Tagesposten`.
- `nayax_lager_google_sheets_import_aktualisiert_v3_kitkat_2026-05-02.xlsx`: Lokaler Snapshot der Google-Sheets-Struktur und Arbeitsdaten.

### Dashboard

- `dashboard/server.js`: Lokaler Node-Server, API fuer Dashboarddaten, GuV-KPIs (`GET /api/guv`), Live-n8n-Abfrage, Google-Sheets-/XLSX-Auswertung und Workflow-Trigger.
- `dashboard/public/index.html`: Dashboard-Struktur.
- `dashboard/public/app.js`: Rendering, Aktionen, Tabellen, Workflow-Buttons.
- `dashboard/public/styles.css`: Dashboard-Layout und UI-Styling.
- `dashboard/.env.example`: Beispiel fuer lokale n8n-Konfiguration.
- `dashboard/logs/`: Lokale Laufzeitlogs, nicht versioniert.

## Wichtige Betriebsregeln

- `active = TRUE` in `Produkte` bedeutet: Dieses Produkt ist aktuell in einer Maschine auf einem MDB-Slot aktiv.
- `active = TRUE` bedeutet nicht: Produkt existiert im Produktstamm.
- WF2 darf keine aktive Slotbelegung als Nebenwirkung erzeugen.
- WF4 ist allein verantwortlich fuer Slot-Historisierung und `product_slot_id`.
- Google Sheets wird nur ueber n8n Forms und Workflows geaendert.
- Preise bleiben in Nayax/Moma fuehrend und werden in Google Sheets nur als Vergleich/Historie genutzt.
- Nayax/Moma werden aktuell nicht produktiv aus den Workflows heraus geaendert.
