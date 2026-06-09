# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-08_slice1-resend-dbcheck.md`.

## Session 2026-06-09 — Stufe 6 Slice 2 (#162) Trigger-Umlegung: **VOLLSTÄNDIG DEPLOYT + CUTOVER (alle 4 Flows live, n8n aus)**

PRs **#191/#192/#194/#195 gemergt** → **#162 CLOSED**, **#163 entblockt**. SPEC: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md`. Suite **1256/1256 grün**. `main` = `99382bf`, **auf Mini deployt** (`/mnt/c/homelab/projekte/automatenlager`, bind-mount `→/repo`; `git pull` + `docker restart`).

**CUTOVER LIVE (alle vier n8n-Workflows DEAKTIVIERT, in-process aktiv):**
- ✅ **WF7** in-process (Dashboard `applyRefill`) — n8n-WF7 (`0oRIiVFr5Q7FF6ow`) aus.
- ✅ **WF5** Worker `wf5-monitor` (07:00) — live smoke ok (Digest-Mail via Resend) — n8n-WF5 (`3ceKeNWmdj455Tcr`) aus.
- ✅ **WF-Claude-Proposals** Worker (04:30) — `ANTHROPIC_API_KEY` aus n8n-Credential migriert → `Anthropic: live`; smoke ok (0 pending) — n8n (`hU7Aev7G4MaMv2yR`) aus.
- ✅ **WF9 Pickliste** Worker (alle 5 min) — **Google-Drive-Client gebaut** (`lib/google-drive-client.js`, PR #195) + OAuth-Credential/Ordner-IDs migriert → `Drive: live`; read-only Auth-Smoke ok (Ordner leer, 0 PDFs) — n8n-WF9 (`nh8Tmg7klwGVjKui`) aus.
- **Credentials migriert** (aus n8n via `export:credentials --decrypted`, serverseitig in Mini-`dashboard/.env.local`, nie geloggt): `ANTHROPIC_API_KEY`, `GOOGLE_DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN` + Ordner-IDs + `WF9_TENANT_ID=t_faltrix`.
- **Restatement-Befund (B):** `DASHBOARD_V2_PG_URL` = Mini-Prod-DB via SSH-Tunnel `127.0.0.1:15432`. Restatement (577 Zeilen brutto, 545 Audit-Logs) lief **gewollt** auf PROD (Runbook-Schritt, auditiert/umkehrbar) — kein Cleanup. `0028`-Test dadurch fragil → in PR #192 robust gemacht.

**n8n läuft weiter NUR für Slice 3 (#163, datenkritisch):** WF1/WF2/WF3/WF4. Rückweg jederzeit: Slice-2-WF in n8n reaktivieren (`BYPASSRLS` bis Slice 4). **Verbleibend (Betreiber, optional):** echter WF9-Pickliste-Live-Test mit einer PDF im Quell-Ordner; Worker-Monitor wacht über Fehlläufe.

**Folge-Feature:** [#193](https://github.com/PatrickM-git/automatenlager/issues/193) — G&V-Tabelle VK/EK pro Stück anzeigen + editierbar (Datenqualität; Verdacht falscher EK bei „Lichtenauer Still"). SPEC vor Umsetzung.

**Wichtigster Befund — lokale WF-JSONs sind NICHT die Wahrheit:** Lokalexporte = alter `product_key`/Sheets-Stand **mit U+FFFD-Korruption** + Vertrags-Mismatch. Authoritative Mini-Definitionen read-only gezogen → `C:\tmp\mini-wf-snapshot\`. Mini-API-Key in `homelab/.env.local` (`N8N_API_KEY`). **Durchgängiges Muster:** Mini-WF-Verhalten extrahieren → reine `compute…`-Logik (unit) → `apply…`/`run…ForTenant` via `db.tx`-Tür (live acme/globex) → Worker-/Endpunkt-Verkabelung; externe Clients (Anthropic/Drive/Mailer) als Parameter injiziert. `stock_movement`/`warning`-Schreibpfade **faithful zu `pgw_write`** (Pre-Flight-Dump verifiziert), aber als **direktes Tür-INSERT mit explizitem `tenant_id`** (RLS-sauber), NICHT via `pgw_write`-Funktion.

### ✅ Fertig (committet, verifiziert, Suite grün)
- **WF7 Nachfüllung** (`lib/refill-apply.js` + `server.js`): `fetch(/webhook/nachfuellung)` → `applyRefill` durch die Tür (Slot-Update + Warnungen-resolve + `stock_movement`). 9 Tests (inkl. 2 live).
- **WF-Claude-Proposals** (`lib/jobs/claude-proposals.js` + `lib/anthropic-client.js`): Worker-Job (täglich 04:30), pending Proposals via Claude (haiku) approve/reject durch die Tür, escalate per Mailer. 7 Tests (inkl. live).
- **WF5 MHD/Low-Stock** (`lib/jobs/wf5-monitor.js`): Worker-Job (täglich 07:00), MHD_EXPIRED/MHD_NEAR/LOW_BATCH-Warnungen INSERT + Auto-Resolve durch die Tür + Digest-Mail (alert-digest.js + Resend). Verwaltet NUR diese Typen. 6 Tests (inkl. live).
- **WF9 Pickliste** (`lib/jobs/picklist.js`): OCR-Pickliste → Backstock-begrenzte Slot-Verteilung → `pick`-Movement (delta_total negativ) + Warnungen-resolve durch die Tür. Drive/Anthropic injiziert. 9 Tests (inkl. live). **Worker-Job ohne Drive-Client „disabled".**
- **DROP** (`docs/specs/stufe-6-slice-2-drop-workflows.md` + `_stillgelegt`-Marker): WF0/WF-Update-Check/WF-Drift-Check.
- **Credentials dokumentiert** (`dashboard/.env.example`): Anthropic/Drive/Resend/Schedule-Vars.
- **Bewusste Abweichung (alle Flows):** kein `warnings`-Audit-INSERT mit `NACHFUELLUNG`/`PICKLISTE_*` — verletzt `warnings_warning_type_check` (schlägt in n8n still fehl). Audit via JSONL bzw. entfällt.

## Session 2026-06-09 — GuV-Kostenbasis Kleinunternehmer + Restatement **KOMPLETT (Code), Restatement LIVE auf Prod**

SPEC: `docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md`. Alle 7 Issues des Loops umgesetzt, gemergt, geschlossen; Suite **1215/1215 grün**. Gearbeitet im isolierten Git-Worktree (`feat/guv-restatement-loop`), damit eine Parallelsession auf `main` ungestört blieb.

| Issue | PR | Inhalt |
|---|---|---|
| #175 | #182 | Migration `0028` — `guv_daily.cost_basis` (nullable, kein Default, CHECK) + `audit.guv_restatement_log` |
| #176 | #183 | Nacht-Job (`guv-aggregate.js`) liest Kleinunternehmer **kanonisch camelCase** (gemeinsame `readKleinunternehmer` in `guv-ek.js`); MwSt-Quelle = **Kategorie-Satz** (wie Live/economics.js); bucht **brutto** + stempelt `cost_basis`; `revenue_net=revenue_gross`. GuV-Schatten-Paritäts-Gate entfernt → Konsistenz-Anker Live==Nacht |
| #177 | #185 | `lib/guv-restatement-preflight.js` + Erweiterung `tools/preflight-guv-daily.js`: finanzieller Trockenlauf, Reconciliation `vat_rate_pct` vs. Kategorie, **Exit-Code-Gate 0/1/2** |
| #179 | #186 | Migration `0029` — Bestands-`NULL`-Zeilen beweisgestützt → `'netto'` (USt abgezogen); **bricht bei brutto-implizierender Anomalie ab** (all-or-nothing); idempotent |
| #180 | #187 | `lib/guv-restatement.js` + `tools/run-guv-restatement.js`: Restatement durch die Tür (tx) — `cost_basis='netto'` ∧ KU → brutto in-place; Audit-Logbuch je Zeile (run_id); **Rollback je run_id**; Runbook `docs/security/guv-restatement-0030-rollback.md`; Grant-Migration `0030` |
| #172 | #188 | `lib/jobs/guv-backfill.js` + `tools/run-guv-backfill.js`: **wartbarer, idempotenter** Nayax-Lücken-Backfill (rechnet byte-genau wie Nacht-Job, `source='guv_backfill'` = sichtbar); Befund: 2025 liegt als `sheets_seed` (0 `historic_backfill`) und ist sichtbar |
| #173 | #189 | Admin-MwSt-Felder im `/einstellungen`-Formular (`v3.js`): MwSt je Kategorie + `defaultMwstPct` + neue Kategorie (Backend persistierte bereits) |

Vorab gemergt: #184 (Onboarding-Test-Isolation, Folge-Chip aus dieser Session).

### ⚠️ AUSSTEHEND — Mini-Deploy (Datenmutationen sind deploy-gated)
Die produktiven **Datenänderungen sind noch NICHT auf der Mini** (alles in mergten PRs + via Dry-Run/Live-Sandbox verifiziert). Sie brauchen zuerst die `cost_basis`-Spalte. **Reihenfolge** (Mechanismus: Memory `mini-deploy-mechanismus`):
1. `git pull --ff-only` + DDL **0028 → 0029 → 0030** anwenden (idempotent), Container-Restart.
2. **Preflight** `node dashboard/tools/preflight-guv-daily.js` → muss **Exit 0** liefern.
3. **Restatement** `node dashboard/tools/run-guv-restatement.js` (Historie `netto`→`brutto`; Rollback `--rollback <run_id>`).
4. **Backfill** `node dashboard/tools/run-guv-backfill.js` (füllt die **32 fehlenden 2025-Posten, ~55,80 €**; Dry-Run gegen die Mini verifiziert, alle mappbar; Rollback `DELETE … WHERE source='guv_backfill'`).
5. **Live-Smoke:** GuV-Panel zeigt die korrigierten (niedrigeren) Gewinne + das sichtbare Steuerjahr 2025.

Reihenfolge 3↔4 egal (beide idempotent, dedup); Backup griffbereit (Memory `pg-backup-mechanismus`).

### Offene Folge-Issues (als Chips hinterlegt)
- **GuV-Backfill als selbstlaufenden Worker-Job** registrieren (User-Wunsch: Lücken automatisch erkennen + füllen, **ohne extra Pflege-Tabellen**; idempotent, Telemetrie statt Pflege-Tabelle). Vorbild `createGuvAggregateJob` + Worker `setInterval` (Memory `node-cron-wsl-mini-unreliable`).
- Per-Mandant-MwSt-Config (**Stufe 6**) + kategorie-getriebenes Onboarding-Dropdown (**Stufe 8**) — Fundament durch #175–#180 gelegt (#173-Abgrenzung).

### Wichtige Befunde (Memory gesichert)
- **2025-GuV ist `source='sheets_seed'`**, nicht `historic_backfill` (0 solche Zeilen); bereits sichtbar. Rohe Nayax-2025-Verkäufe = freigegebenes Google-Sheet (CSV-Export, `GUV_BACKFILL_SHEET_ID`). → Memory `guv-historie-und-nayax-rohquelle`.
- **Suite-Lauf:** parallel mit `--test-timeout=60000 --test-force-exit` (seriell zu langsam; ohne Timeout Endlos-Hänger durch offenen Handle in process-isolierten Kindern). → Memory `suite-parallel-flakiness`.
- **Worktree:** `node_modules`/`.env.local` fehlen (nachinstallieren/kopieren); **Preview-MCP läuft gegen das Haupt-Repo, nicht den Worktree**. → Memory `worktree-preview-und-setup`.

### Davor (2026-06-08) — Stufe 6 Slice 1
Slice 1 praktisch durch (Resend live, WF-Val + WF8-GuV + MatView + Nayax-Devices abgelöst/deaktiviert). **Nächster Stufe-6-Schritt: #162 Slice 2** (Trigger-Umlegung WF7/WF9/WF5/WF-Claude + DROP WF0/Update-Check/Drift-Check). **Harter Stopp vor #163 (WF3, datenkritisch) + #164 (irreversibel).** Details: `HANDOVER_ARCHIVE/HANDOVER_2026-06-08_slice1-resend-dbcheck.md`.
