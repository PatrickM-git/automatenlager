# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-08_slice1-resend-dbcheck.md`.

## Session 2026-06-09 — Stufe 6 Slice 2 (#162) Trigger-Umlegung: **WF7 + DROP fertig, 3 Flows offen**

Branch `feat/n8n-abloesung-stufe-6-slice-2` (2 Commits, NICHT gepusht — Nutzer bestätigt Push/Merge am Ende). SPEC: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md`. Suite **1224/1224 grün**.

**Wichtigster Befund — lokale WF-JSONs sind NICHT die Wahrheit:** WF7-Lokalexport = alter `product_key`/Sheets-Stand **mit U+FFFD-Korruption** und Vertrags-Mismatch zum Dashboard-Endpunkt. Authoritative Mini-Definitionen read-only gezogen → `C:\tmp\mini-wf-snapshot\` (WF7/WF9/WF5/WF-Claude-Proposals/WF-PGW). Mini-API-Key in `homelab/.env.local` (`N8N_API_KEY`). **Für die 3 offenen Flows die Snapshots als Quelle nutzen, nicht die lokalen Exporte.**

### ✅ Fertig (committet, verifiziert)
- **WF7 Nachfüllung in-process** (`lib/refill-apply.js`): `fetch(/webhook/nachfuellung)` in `server.js` ersetzt durch `applyRefill(tenantDb, viewer.tenantId, …)` — Slot-Update + Warnungen-resolve + `stock_movement` atomar durch die Tür (`db.tx`, `tenant_id=$1`). `stock_movement` **faithful zum `pgw_write`-Zweig** (per Pre-Flight-Dump verifiziert: batch_key→batch_id, product_slot_key→slot_assignment_id, `ON CONFLICT(movement_key)`), aber als **direktes Tür-INSERT mit explizitem `tenant_id`** (RLS-sauber, Slice-1-Muster `guv-aggregate`), NICHT via `pgw_write`-Funktion. Tests: 7 reine Logik + 2 Live durch die Tür (acme/globex nicht-vakuös, RLS-Isolation bewiesen).
  - **Bewusste Abweichung:** kein `warnings`-Audit-INSERT — WF7s `'NACHFUELLUNG'` verletzt den aktuellen `warnings_warning_type_check` (Pre-Flight bestätigt: NACHFUELLUNG/EMPTY_BATCH **nicht** erlaubt) ⇒ der n8n-Audit-Node schlägt produktiv still fehl. Audit liegt korrekt im JSONL `refill-actions.jsonl` des Endpunkts.
- **DROP dokumentiert** (`docs/specs/stufe-6-slice-2-drop-workflows.md` + ASCII-`_stillgelegt`-Marker in den 3 Exporten): WF0 (Mini bereits entfernt), WF-Update-Check (Mini inaktiv), WF-Drift-Check (DB-Konsistenz = `db-validation.js` Slice 1). Mini-Status je WF live per API verifiziert.

### ⏳ Offen (für Folge-Chat) — je Flow Mini-Snapshot als Quelle, externe Clients als Parameter injizieren (test-first)
- **WF-Claude-Proposals** (tractabelste): alte Proposals via Anthropic (`claude-haiku`) vorentscheiden → `product_change_proposals`-Update durch die Tür. Anthropic-Client injizieren/mocken.
- **WF5-Versand-Abschluss:** Leseseite `alert-digest.js` existiert; neu: **Mailer-Modul** (Resend ist bereits live als Transport — Slice 1, Mini-`.env.local` `RESEND_API_KEY`) + Worker-Cron-Versand + Warnungen-resolve/-INSERT durch die Tür. **Achtung:** `warnings`-Constraint (s. o.) bei etwaigem INSERT beachten.
- **WF9 Pickliste** (größter): Drive-Polling-Job + Claude-OCR → Slot-Verteilung → Warnungen → `stock_movement` durch die Tür. Braucht Google-Drive- + Anthropic-Client.
- **Credentials** in Mini-`.env.local` dokumentieren/migrieren (Anthropic-Key; Drive-Token; Mail liegt via Resend schon).

### ⚙️ Deploy-/Ops (Betreiber, am Ende des Slice)
- **n8n-WF7 auf der Mini deaktivieren** (id `0oRIiVFr5Q7FF6ow`), erst NACH Deploy des Dashboards mit `applyRefill`. Rückweg: WF7 reaktivieren (`BYPASSRLS` besteht bis Slice 4 → reversibel).
- WF9/WF5/WF-Claude-Proposals erst deaktivieren, wenn ihr Port deployt ist.

## Session 2026-06-09 — GuV-Kostenbasis Kleinunternehmer + Restatement **KOMPLETT (Code), Deploy ausstehend**

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
