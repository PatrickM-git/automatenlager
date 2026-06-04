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
DASHBOARD_ADMIN_LOGIN=patrick@example.com
DASHBOARD_AUDIT_LOG=dashboard/logs/guest-access.jsonl
```

Dashboard tests:

```powershell
cd dashboard
npm test
```

Read-Only guest access (Default-Deny seit #27, `dashboard/lib/auth.js` → `resolveViewer`):

- The dashboard reads `Tailscale-User-Login` and resolves the viewer **default-deny**.
- **Exact allowlist:** a present login is admin only if it **exactly** matches an entry in `DASHBOARD_ADMIN_LOGIN` (comma-separated, case-insensitive). The old `startsWith('patrick')` prefix rule is **removed** (`patrick-evil@…` is a guest). On the Mini `DASHBOARD_ADMIN_LOGIN=patrickmatthes2609@gmail.com` (the exact Tailscale-Serve login).
- **No header:** guest — UNLESS the request is loopback **and** `DASHBOARD_DEV_LOCAL_ADMIN` is set (local dev/test escape hatch; OFF in production). This is also the lockout-recovery lever on the Mini.
- **F1 path-based trust:** `Tailscale-*` headers are only trusted from a trusted source address. If `DASHBOARD_INTERNAL_PEER_CIDR` is set, requests from that range (internal Docker peers) are treated as guest/read-only with headers discarded. Currently **not enforced** (conservative) — see issue #78.
- Role determination uses `req.socket.remoteAddress` (not the spoofable Host header).
- `getViewer` returns `{ login, role, capabilities:Set, tenantId, can(cap), canTriggerActions }`; `canTriggerActions = can('workflows.starten')`.
- Guests: trigger buttons hidden, admin-only `POST` endpoints return `403`. Guest access logged as JSONL under `dashboard/logs/guest-access.jsonl` (override via `DASHBOARD_AUDIT_LOG`).

## Security Rules — Mandatory

- **Never hardcode API keys, bearer tokens or passwords in workflow JSON files.**
- All external API credentials (Nayax, n8n, Google, etc.) must be stored as n8n credentials or in `dashboard/.env.local`.
- Workflow JSON exports must only contain the placeholder `NAYAX_TOKEN_IN_N8N_CREDENTIAL_EINTRAGEN` (or similar) — never a real value.
- Before committing any workflow JSON, search for `Bearer `, `apikey`, `password` and `secret` patterns and verify no real token is present.
- If a real token is accidentally committed: revoke it immediately, replace with a placeholder, clean git history with `git filter-repo`, then force-push.

## n8n Workflow Notes

- **ALWAYS work on the HP Mini n8n instance — never the local one.** The production workflows (WF0–WF9) run 24/7 on the HP Mini at `https://hp-mini-server.tail573a13.ts.net`. A local n8n instance (`localhost:5678`) on the dev PC holds **outdated/inactive copies with different workflow IDs** — editing those is wasted work. Example WF1: Mini production = `wnGAwHhgfXq2ATM8` (published) vs. local = `dKNRRxkCPmVsArJ0` (inactive).
- **Before any n8n change, verify the target instance.** Confirm the connection points at the Mini (not localhost) and that the workflow ID matches production via `get_workflow_details`. If the expected Mini ID returns "not found", the connection is on the wrong instance — switch it first. Connection details live in `dashboard/.env.connections` (template: `.env.connections.example`); the Mini n8n API key is in `C:\Users\patri\.n8n-api-key`.
- The production n8n instance runs on the HP Mini (`homelab-n8n`, n8n 2.21.4).
- Code nodes using `.first()` or `$items(...)` must run in `Run Once for All Items` mode.
- Before changing a production workflow, decide whether the local JSON export or the live n8n workflow is authoritative.
- Test workflow changes in n8n before replacing active production versions.
- WF8 must not use Google Sheets `appendOrUpdate` with multiple matching columns. Use append + Existing-Key-Skip, or a future single technical key such as `guv_key`.
- **Encoding: keep workflow JSON UTF-8, never round-trip through Latin-1.** A Latin-1/UTF-8 mismatch during an earlier import/export irreversibly replaced every German umlaut with `U+FFFD` (bytes `0xEFBFBD`) in WF4/5/7/9 — in node names **and** `jsCode`. Most damaging: WF4's `normalize()` regexes had become `.replace(/�/g, 'ae')` and matched the replacement char instead of real umlauts, so the umlaut was stripped by the final `[^a-z0-9]` filter (`"Müller"` → `"mller"`) and product matching silently broke. Prevention: read/write exports as UTF-8 (use node `https`, not tools that may re-encode); after any export grep for `U+FFFD`; the regression guard `dashboard/tests/encoding-umlaut-fix.test.js` fails if any `WF*.json` reintroduces it or if `normalize()` stops mapping umlauts.

## Handover Convention

- Keep `HANDOVER.md` up to date at the end of every session.
- Before overwriting `HANDOVER.md`, archive the previous version under `HANDOVER_ARCHIVE/` with a date-stamped filename.
- Commit handover updates together with related code/workflow/documentation changes.

## Current Next Step

**Umgesetzt (2026-06-03) — Feature „Branchen-Anker" (Drehgeschwindigkeits-Klassifikation), Issues #62–#66:**
- SPEC: `docs/specs/branchen-anker-drehgeschwindigkeit-v1.md`.
- #62: `produktart` ist die echte SQL-Spalte `products.category` (kanonisch lowercase, Daten-/Schema-Guard `tests/dashboard-produktart-contract.test.js`); WF2-Hardcode `'Snack'`→`'snack'`. Doku `docs/data-model/produktart-semantics.md`.
- #63: `dashboard/lib/category-config.js` — mandantenfähige, editierbare Config (Defaults Getränke 43 %/Snack 52 %/Fallback 50 %, Branchen-Norm 800 €, graceDays 14, ladenhueterDays 30), Latten-Ableitung, effektive Config = Defaults+Override; Persistenz `automatenlager.classification_settings` (JSONB je `mandant_id`, Default `__default__`).
- #64: `dashboard/lib/slow-mover.js` geldbasiert (Deckungsbeitrag/Slot/Woche, 4-Wochen-Fenster) gegen Kategorie-Latten; Klassen `neu`→`ladenhueter`→`ek_fehlt`→`renner/normal/langsam_dreher` (Vorrang in dieser Reihenfolge).
- #65: `assortment-slots.js` nur EINE Definition (zweite hartcodierte entfernt), SQL um produktart + 4-Wochen-Geldfenster + Schonfrist-Anker (erster Verkauf) + EK-fehlt; v3-Badges/CSS für alle 6 Klassen.
- #66: `/einstellungen` editierbar — GET liefert effektive Config + `canEdit`, admin-only POST `/api/v2/settings/definitions` (Persistenz via #63, Teil-Speichern merged), v3-Formular für Margen/Latten/Schon-/Ladenhüter-Tage + Kategorie anlegen.
- Status: Suite 740/740, live verifiziert (DB-Normalisierung, Klassen-Verteilung, Schreib-Round-Trip mit Snapshot/Restore). **Noch nicht auf den Mini deployt** (Code + DDL `classification_settings` liegen auf der Dev-DB; Mini-Deploy = `git pull --ff-only` + DDL + Container-Restart).

**Naechste Schritte:**
1. PR mergen, auf den Mini deployen (DDL `classification_settings` dort anwenden — `loadEffectiveConfig` legt sie idempotent an).
2. WF2-Änderung (`category:'snack'`) auf die Mini-Instanz bringen (n8n) — bis dahin schreibt die Prod-WF2 weiter `'Snack'` (read-side durch lowercase-Normalisierung abgesichert).
3. Separates Issue: „Vollständigkeits-Audit Sheets→DB vor Cutover" (knüpft an `docs/specs/sql-only-migration.md` + Issue #9).

## WF7 Nachfuellung Webhook

URL: `http://127.0.0.1:5678/webhook/nachfuellung`
Params: `product_key` (Pflicht), `qty` (Optional), `notes` (Optional)
Aktionen: Slot-Update + Warning-Resolve + Audit-Eintrag
