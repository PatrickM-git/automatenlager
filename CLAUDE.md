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

**Zielarchitektur (Nordstern) + geordnete Gesamtplanung: siehe `docs/ROADMAP.md`.** Kurz: weg vom Heim-Mini hin zu **3-Schichten-Cloud — Cloudflare (Frontend) · Render (Backend + Cron) · Supabase (Postgres + RLS)**; **n8n VOLLSTÄNDIG ablösen** (= Stufe 6, durch Backend-Code/Cron). Cloud-agnostisch bauen (RLS/Tür/SQL-only sind bereits Supabase-portabel → Umzug, kein Rewrite). **Kein zweiter echter Kunde vor Stufe 6 UND Cloud** (externe Kunden nicht auf dem Mini).

**Geplant (2026-06-08) — Finanz-SPEC „GuV-Kostenbasis Kleinunternehmer + Restatement" (Befund aus WF8-GuV-Port #161/PR #171):** SPEC `docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md`, gegen **echten Code** verifiziert. Problem: das Besteuerungsmodell-Flag wird zweifach unterschiedlich gelesen — Live (camelCase `kleinunternehmerAktiv`=true → brutto, aber **flüchtig**, kein DB-Write) vs. Nacht-Job `lib/jobs/guv-aggregate.js` (snake_case → COALESCE `FALSE` → **netto** gebucht). Verifiziert: einziger `guv_daily`-Schreiber ist der Nacht-Job → **alle** gebuchten Zeilen sind netto, in **zwei** Schichten (`wf8_guv_aggregator` + `historic_backfill` = Steuerjahr 2025, letzteres im GuV-Panel ausgeblendet). Entschieden: Kleinunternehmer=true → **beide brutto**; Historie wird **restated** (nicht nur go-forward — Grundlage der Steuererklärung). Lösung: Schlüssel vereinheitlichen (camelCase kanonisch, snake_case Legacy-Fallback, camelCase gewinnt), **Kategorie-Satz als kanonische MwSt-Quelle** (Live unverändert; Preflight-Reconciliation vs. `vat_rate_pct`), `cost_basis`-Marker (nullable) + Klassifizierung über **NULL-Marker** (nicht `source`), in-place-Restatement `× (1+Kategorie-MwSt/100)` inkl. `revenue_net=revenue_gross`, Audit-Logbuch `audit.guv_restatement_log` (run-id) + Rollback-Runbook, finanzieller Preflight-Trockenlauf. Reihenfolge DDL 0028 → Klassifizierung 0029 → Code → Restatement 0030. Folge-Issues [#172](https://github.com/PatrickM-git/automatenlager/issues/172) (historic_backfill sichtbar + Vollständigkeits-Audit) + [#173](https://github.com/PatrickM-git/automatenlager/issues/173) (Admin-MwSt/Onboarding-Dropdown, Stufe 6/8). **Nächster Schritt: neuer Chat → `spec-to-issue`.**

**Geplant (2026-06-07, später) — A1 ✅ + STUFE-6-SPEC geschrieben (n8n-Ablösung):** SPEC `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md`, gegen die **echten WF-JSONs + Dashboard-Code** verifiziert (nicht Doku-Annahmen); A1 Performance-Pass erledigt (PR #154). Kernbefunde der WF-Analyse: **WF-PGW** = Durchreicher auf die **out-of-band DB-Funktion `pgw_write(event_type,batch_run_id,data)`** (Pre-Flight-Dump via `pg_get_functiondef` Pflicht, analog Rollen-Hierarchie in Stufe 5); **nicht alle 17 WF sind 1:1-Ports** — WF0/WF-Update-Check/WF-Drift-Check obsolet (DROP), WF4/WF5/WF7 Leseseite/Trigger schon im Dashboard (MERGE, Vorbild `lib/alert-digest.js`); **`audit.workflow_runs` existiert bereits** (Lauf-Telemetrie-Ersatz für n8ns `execution_entity`); alle Google-Sheets-Schreibknoten deaktiviert; null Mandanten-Bewusstsein (Maschine `457107528` hartkodiert). Architektur: `lib/jobs/*` (einzeln + in-process) + Worker-Dienst (`node-cron`, eigener compose-Service, `restart:always`) + Trigger-Endpunkte; **alles durch die Mandanten-Tür** (per-Mandant GUC, Refresh über Infra-Rolle); am Ende verliert `n8n_app` `BYPASSRLS` → **RLS systemweit**. Slices 0–4 (Fundament → idempotent direkt → leicht/Trigger-Umlegung → datenkritisch im Schatten → Abschluss + #108/#111 + Sicherheitsnachweis), je deploybar + Live-Smoke + rückwegsfähig. **Nächster Schritt: neuer Chat → `spec-to-issue`** (Issues schneiden), dann `start-issue` (TDD).

**Nächste Schritte (laut ROADMAP, sinnvolle Reihenfolge):** A1 **Performance-Pass** (<3 s/Seite, gemessen, sicher) → A2 **Stufe 6 = n8n-Ablösung** (WF1/2/3/5/7/8/9 → Backend-Code/Cron; schließt den Backstop systemweit) + **#108** + **#111** → A3 Monitoring/Alerting + Off-Site-Backup → A4 Self-Service (Login/Reset/2FA, Mandanten-Admin-UI [Stufe 8], Onboarding-Wizard, Credential-Vault [Stufe 7]) → A5 **#109** IR-Runbook + DSGVO-Basis → Phase B Cloud-Migration → Phase C Wachstum (Stripe-Billing, Marketing-Site, Par-Level/Bestellwesen/Provisionen/Routen, DATEV/GoBD/TSE). Jede Phase startet mit eigener SPEC.

**Umgesetzt (2026-06-07) — Mandantenfähigkeit STUFE 5 „RLS-Backstop", Issues #143–#150 KOMPLETT, LIVE & VERIFIZIERT:**
- PR [#151](https://github.com/PatrickM-git/automatenlager/pull/151) gemergt, Mini auf `145ee7b`. SPEC: `docs/specs/multi-tenant-rls-stufe-5-v1.md`. Suite **1081/1081 grün**. Details: `HANDOVER.md`.
- RLS für **Lesen UND Schreiben** über die eingeengte Rolle `automatenlager_app` (kein BYPASSRLS, kein Eigentum, Mitglied von `app_writer`); Infra-/App-Verbindungs-Split; GUC `automatenlager.current_tenant` transaktionslokal via `set_config(...,$1,true)` in der Tür (`read`/`write`/`tx`). Policies (USING+WITH CHECK, einarmiges `current_setting` ⇒ fail-closed) auf 20 operativen Tabellen (Migrationen **0022–0026**); Vereinigungs-Policy `classification_settings` (`mandant_id` ODER `__default__`); `security_invoker`-Views + `security_barrier`-View `v_inventory_value_daily`. Break-Glass read-only an der Tür. Rollback-Runbook `docs/security/rls-stufe-5-rollback.md`.
- **Pre-Flight-Befund:** out-of-band Rollen auf der Mini-DB (`app_reader`/`app_writer`/`n8n_app`/…) — SPEC angepasst; `n8n_app` erhielt BYPASSRLS (n8n bleibt bis Stufe 6 außerhalb des Backstops). Memory `db-rollen-landschaft`.
- **Live verifiziert:** Container `current_user=automatenlager_app`; Gruppen-Smoke je Gruppe = exakt Faltrix' Zeilen; `/health` ok, Logs fehlerfrei; n8n_app BYPASSRLS; fehlender GUC ⇒ Fehler 42704 (kein Leck). **Dashboard verbindet jetzt als `automatenlager_app`** (App-URL `DASHBOARD_V2_APP_PG_URL` in der Mini-`.env.local`; Lockout-Recovery: leeren ⇒ Infra-Fallback).

**Umgesetzt (2026-06-07) — Mandantenfähigkeit STUFE 4 „Schreib-Isolation", Issues #131–#139 KOMPLETT (Code):**
- Branch `feat/write-isolation-stufe-4` (9 Commits), Suite **1056/1056 grün** (live gegen die Mini-DB im #94-Sandbox-Harness, ROLLBACK). Details: `HANDOVER.md`. **⚠️ AUSSTEHEND:** PR mergen + Mini-Deploy mit DDL **0020 UND 0021** (vor Code, idempotent) + Container-Restart + **Live-Smoke** — erst danach „erledigt".
- SPEC: `docs/specs/multi-tenant-write-isolation-stufe-4-v1.md`. Basiert auf echter Code-Analyse (nicht Doku-Annahmen).
- **Leitprinzip:** Autorisierung (→ künftige Render-Schicht) und Datenzugriff (→ Supabase + RLS Stufe 5) als ZWEI getrennte, cloud-agnostische Schichten. Stufe 4 baut nur Arbeit, die in jeder Zukunft (Cloudflare/Render/Supabase) gebraucht wird.
- **Scope (11 Punkte, gegen Code verifiziert):** 5 direkte DB-Schreiber durch die Tür (write-off [war übersehen], location-profiles, machine-create, machine-profiles, settings-thresholds) + 6 schreib-auslösende Webhook-Endpunkte mit Autorisierungs-Tor (slot-change/nayax = schon da; refill/slot-assign-inline/correction-action/onboarding = neu). **Parent-Matrix:** correction→`case_id`, onboarding→`product_key` (NICHT Maschine!).
- **Kern-Entscheidungen:** `tenant-db.js` `write()` wird fail-closed-**werfend** (read bleibt leer); **transaktionaler Schreib-Modus** `db.tx` (Parent-Prüfung + Write atomar = TOCTOU-Schutz + RLS-Steckplatz Stufe 5); `tenant_id` im Body → **400 + Audit**; kleine **DDL-Migration VOR Code** (Unique-Constraints locations+machines um `tenant_id`, `NULLS NOT DISTINCT`); #107-Wächter **strukturell** auf Schreibpfade erweitert (kein SQL-Parser), build-blocking im Endzustand.
- **Rollout:** Slice 0 Fundament → Slice 1 DDL → Slice 2 Webhook-Tore (schneller Gewinn) → Slice 3 direkte Schreiber (einfach→komplex) → Slice 4 Scharfschaltung + Live-Smoke.
- **Abgrenzung:** RLS-Zünden = Stufe 5; n8n-Schreibpfade = Stufe 6; per-Mandant-Config = Stufe 6; UI = Stufe 8. **Kein zweiter realer Kunde vor Stufe 3+4+5.**
- **Nächste Schritte:** (1) PR mergen (#131–#139) + Mini-Deploy (DDL 0020+0021 vor Code) + Live-Smoke; (2) **Stufe 5 (RLS)** — den inerten `SET LOCAL`-Haken in `db.tx` zünden (unumgehbarer Backstop).

**Umgesetzt (2026-06-07) — Mandantenfähigkeit STUFE 3 „Query-Filter" (Lese-Isolation), Issues #122–#129 KOMPLETT (Code):**
- Branch `feat/query-filter-stufe-3` (8 Commits), Suite **1003/1003 grün** (live gegen die Mini-DB im #94-Sandbox-Harness, ROLLBACK). SPEC: `docs/specs/multi-tenant-query-filter-stufe-3-v1.md`. Details: `HANDOVER.md`.
- **Mandanten-Tür** `lib/tenant-db.js` (fail-closed, Mandant als `$1`, explizite Zieltabellen, `read`/`write`/`forViewer`/`asDoor`, Stufe-5-Haken inert) als EINZIGE Lese-Zugriffsschicht über geteiltem Pool. **#107-Wächter** `lib/query-filter-guard.js` strukturell + **build-blocking-Endzustand**; enge Global-Allowlist (nur Verzeichnis). Doku: `docs/security/query-filter-guard-allowlist.md`. **acme/globex-Fixtures** + `doorForClient` + Advisory-Lock (DDL-vs-DML-Deadlock-Schutz).
- Alle ~40 Lese-Pfade durch die Tür mit `tenant_id`-Filter (Finanzen #123, Übersicht/Monitoring #124 inkl. Hintergrund-Job `alert-digest` pro Mandant, Sortiment #125, Bestand/MHD #126, Automaten/Nayax #127, Korrektur/Onboarding #128). Aggregate + MatViews tenant-scoped. Je Domäne nicht-vakuöser acme↔globex-Isolationstest. Startup-Race-Fix (Ready-Log nach Registry-Load).
- **Scope-Grenze (dokumentiert):** Schreibpfade (upsert/create/delete/setThreshold) bewusst UNVERÄNDERT = **Stufe 4** (stehen begründet auf der Guard-Allowlist); RLS = **Stufe 5** (unumgehbarer Backstop, ohne Lücke); n8n = Stufe 6; Config (`classification_settings`) bleibt `__default__`-gekeyt (per-Mandant = Stufe 6). **Kein zweiter realer Kunde vor Stufe 3+4+5.**
- **Nächste Schritte:** (1) PR mergen (schließt #107 + #122–#129) + Mini-Deploy (reiner Code, kein DDL) + finaler Live-Smoke; (2) **Stufe 4 (Schreib-Isolation)** planen/umsetzen; (3) **Stufe 5 (RLS)** — Tür-Haken zünden.

**Umgesetzt (2026-06-06) — Auth scharf setzen (Stufe 2), Issues #115–#118 KOMPLETT (Code):**
- Branch `feat/auth-scharf-stufe-2` (4 Commits), Suite **946/946**. SPEC: `docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md`.
- #115 Seed-Migration `0018` (tenant_users/platform_admins, GUC-parametrisierbar, idempotent); #116 `lib/tenant-directory.js` (Mandanten-Registry, Cache + async machineTenant + Negative-Caching, fail-closed); #117 `resolveViewer`/`objectAccessAllowed` real aus der Registry (kein TENANT_OWNER-Default), IDOR-Hooks async, `GET /health`, request-id, Taxonomie 404/503; #118 Break-Glass `X-Support-Tenant` (read-only, auditiert, nicht-klebrig). Trust-Header-Invariante: `docs/security/trust-header-invariante.md`.
- **Stufe 2 LIVE + VERIFIZIERT (2026-06-06):** PR #119 gemergt (+#120), Mini auf `e8469bc`; Seed `0018` lief (beide Eigentümer→`t_faltrix`); `/health`={ok,tenantDirectoryReady,pgConfigured}; Audit zeigt Break-Glass-Block live; kein Owner-Lockout. Read-only per SSH/Tunnel geprüft.
- Scope-Grenze: KEINE flächendeckenden Query-Filter (Stufe 3), KEINE RLS (Stufe 5), kein UI (Stufe 8). Stufe 2 = Verkabelung + Verifizierbarkeit, NICHT verkaufsfähig für 2. realen Kunden.

**Davor umgesetzt (2026-06-03) — Feature „Branchen-Anker" (Drehgeschwindigkeits-Klassifikation), Issues #62–#66:**
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
