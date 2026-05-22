# CLAUDE.md

This file provides guidance to Claude Code and other coding agents when working with this repository.

## Project Overview

This repository contains an n8n-based vending-machine inventory system for Nayax/Moma data, Google Sheets, FIFO stock deduction, MDB slot mapping, product changes and MHD/low-stock monitoring.

The project is not a generic Node.js skeleton anymore. It now contains:

- n8n workflow exports `WF0` to `WF5`, `WF7` (Nachfüllung), `WF8`, `WF9`
- a local Node.js dashboard in `dashboard/`
- Google Sheets/XLSX working data
- handover and architecture documentation

Start by reading:

1. `README.md`
2. `ARCHITECTURE.md`
3. `HANDOVER.md`

## Core Domain Rules

- WF2 owns product master data, aliases, invoice proposals and warehouse batches.
- WF2 must not create active machine slot assignments directly.
- WF4 is the only source of truth for active MDB/slot assignments, `product_slot_id`, `active = TRUE/FALSE`, `valid_from_datetime` and `valid_to_datetime`.
- `active = TRUE` in the `Produkte` sheet means active slot assignment, not product existence.
- WF3 still matches sales primarily by `MachineID + ProductName`.
- MDB code is currently a control/warning signal, not a hard requirement.
- Nayax/Moma are not changed productively by the workflows at this stage.
- Google Sheets is a working and logging layer. Manual sheet maintenance should be avoided.

## Repository Structure

```text
mein-erstes-Projekt/
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

## Dashboard

Run locally:

```powershell
cd dashboard
npm start
```

Open:

```text
http://127.0.0.1:8787/
```

Local secrets belong in `dashboard/.env.local`, never in Git:

```text
N8N_BASE_URL=http://127.0.0.1:5678
N8N_API_KEY=...
```

## Security Rules — Mandatory

- **Never hardcode API keys, bearer tokens or passwords in workflow JSON files.**
- All external API credentials (Nayax, n8n, Google, etc.) must be stored as n8n credentials or in `dashboard/.env.local`.
- Workflow JSON exports must only contain the placeholder `NAYAX_TOKEN_IN_N8N_CREDENTIAL_EINTRAGEN` (or similar) — never a real value.
- Before committing any workflow JSON, search for `Bearer `, `apikey`, `password` and `secret` patterns and verify no real token is present.
- If a real token is accidentally committed: revoke it immediately, replace with a placeholder, clean git history with `git filter-repo`, then force-push.

## n8n Workflow Notes

- The production n8n instance runs on the HP Mini (`homelab-n8n`, n8n 2.21.4).
- Code nodes using `.first()` or `$items(...)` must run in `Run Once for All Items` mode.
- Before changing a production workflow, decide whether the local JSON export or the live n8n workflow is authoritative.
- Test workflow changes in n8n before replacing active production versions.
- WF8 must not use Google Sheets `appendOrUpdate` with multiple matching columns. Use append + Existing-Key-Skip, or a future single technical key such as `guv_key`.

## Handover Convention

- Keep `HANDOVER.md` up to date at the end of every session.
- Before overwriting `HANDOVER.md`, archive the previous version under `HANDOVER_ARCHIVE/` with a date-stamped filename.
- Commit handover updates together with related code/workflow/documentation changes.

## Current Next Step

**Session 17 abgeschlossen (2026-05-23) — Mai-GuV repariert:**
- Nayax Mai 2026, `Verarbeitete_Transaktionen` und `GuV_Tagesposten` sind live auf **207,80 EUR** abgeglichen.
- Fehlende Verkäufe vom 08.05.2026 wurden nachgetragen; zwei bestehende 0/leer-Umsatz-Zeilen wurden korrigiert.
- `GuV_Tagesposten` Mai wurde aus `Verarbeitete_Transaktionen` neu aufgebaut.
- WF8 auf HP Mini (`AMXktRs6Z28FuzSE`) ist aktiv und wieder im sicheren Append-Modus mit Existing-Key-Skip.

**Naechste Schritte:**
1. Dashboard-Zeitraum Mai/Gesamt prüfen: Mai-Umsatz muss 207,80 EUR zeigen.
2. Nach dem nächsten WF8-02:00-Lauf kontrollieren, dass keine neuen GuV-Duplikate entstehen.
3. Für Phase 1 echten Aggregat-Key oder PostgreSQL-Upsert einführen; Google-Sheets-Composite-Upsert nicht mehr verwenden.

## WF7 Nachfuellung Webhook

URL: `http://127.0.0.1:5678/webhook/nachfuellung`
Params: `product_key` (Pflicht), `qty` (Optional), `notes` (Optional)
Aktionen: Slot-Update + Warning-Resolve + Audit-Eintrag
