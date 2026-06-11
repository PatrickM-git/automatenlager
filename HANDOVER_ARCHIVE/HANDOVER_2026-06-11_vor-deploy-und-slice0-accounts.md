# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-11_live-umsatz-fix-213.md`.

## Session 2026-06-11 (Umsetzung) — #221 Nachbuch-Reconciliation + Cloud-Slice-0 (#212) + #214-Vorarbeit

> Reine Code-/Doku-Session (kein Prod-Deploy). Alle Live-Sandbox-Tests gegen die echte
> Mini-DB (ROLLBACK-Harness). Drei PRs gemergt: #223, #224, #225. Volle Suite **1377/1377 grün**.

### #221 — Nachbuchung unvollständig gelieferter Nayax-Verkäufe — UMGESETZT, GEMERGT (#223), GESCHLOSSEN
- TDD, Opus (statt der im Issue vermerkten Fable-Umsetzung — User bat direkt darum).
- **`dashboard/lib/jobs/nayax-reconcile.js`**: reine Logik (`isReconcilable`,
  `computeReconcilePlan`) + I/O durch die Mandanten-Tür (`applyNayaxReconcile`,
  `readReconcileBacklog`) + Worker-Factory (`createNayaxReconcileJob`).
- **Kriterium „nachbuchungsbedürftig"**: `gross_amount ≤ 0/NULL` UND Status ∈
  `{INSUFFICIENT_BATCH_STOCK, OK, UNKNOWN}`. **`SKIPPED_BEFORE_CUTOVER` bewusst NICHT**
  auto-verbucht (Vor-Inventur), aber im Backlog separat gezählt.
- **Re-Fetch** via `lastSales` (Quelle/Mapping wie Live-Import WF3), Match per
  `nayax_transaction_id`, Preis aus `SettlementValue`. Nicht-auflösbare Zeilen bleiben
  **ehrlich pending** (`NO_NAYAX_MATCH` = historisch außerhalb des Fensters / `NO_PRICE` /
  `INSUFFICIENT_BATCH_STOCK`) — kein stilles Schlucken.
- **Idempotent**: UPDATE mit `gross<=0`-Guard ⇒ Re-Run = No-Op (kein Doppel-Dekrement,
  kein Doppel-Audit); `stock_movements ON CONFLICT DO NOTHING`; Trigger pflegt `remaining_qty`.
- **Audit alt/neu** je Korrektur in **`audit.sales_reconciliation_log`** (Migration **0036**,
  Vorbild `guv_restatement_log`); Lauf-Telemetrie via `audit.workflow_runs` (Worker `recordRun`).
- **Sichtbarkeit (AC6)**: `GET /api/v2/reconcile/backlog` (admin, tenant-scoped) + `readReconcileBacklog`.
- **Worker konservativ gated**: läuft nur mit gesetztem `WORKER_RECONCILE_MS` (Default: aus).
- 15 neue Tests (reine Logik + Live-Sandbox acme/globex-Isolation + Idempotenz + Factory).
- **⚠️ Mini-Deploy steht aus:** `git pull` + Migration **0036** (idempotent, additiv) + Container-
  Restart; `WORKER_RECONCILE_MS` (z. B. 3600000) erst **nach Sichtprüfung** des Backlogs setzen
  (`GET /api/v2/reconcile/backlog`). Die 77 Altzeilen werden nur nachgebucht, soweit Nayax sie
  im `lastSales`-Fenster noch liefert — der Rest bleibt sichtbar pending.

### #212 — Cloud-Migration Slice 0 (Fundament & Domain) — DOKU GEMERGT (#224), ACCOUNTS/DOMAIN OFFEN
- **Erledigt (autonom, AC3+AC4):** drei Dokumente unter `docs/cloud-migration/`:
  - `slice-0-secrets-inventory.md` — jede `.env.example`-Variable → Cloud-Ziel (Render-Env /
    Supabase / Cloudflare) bzw. „entfällt"; NEUE Cloud-Variablen gelistet.
  - `slice-0-cron-quelle-entscheidung.md` — **Entscheidung: Supabase `pg_cron` + `pg_net` →
    geschützte Render-Trigger-Endpunkte** (gemeinsames `WORKER_TRIGGER_SECRET`, timing-safe);
    Cloudflare-Cron als Fallback; Schedule-Abbildung aller Jobs.
  - `slice-0-account-domain-runbook.md` — manuelle Schritte (Accounts + Domain).
- **OFFEN (User-Hand, blockiert alles Weitere):** Supabase-/Render-/Cloudflare-Accounts anlegen,
  neue Gmail `faltrixsolutions@gmail.com`, Domain **`faltrix-solutions.de`** (Cloudflare Registrar).
  User wünscht „Claude steuert den Browser".
  - **WICHTIG (Boundary):** Account-Anlage, Passwort-/Karteneingabe und CAPTCHA-Lösen sind
    Aktionen, die Claude NICHT für den User ausführt (Schutz-Boundary + Google/Registrar-Anti-
    Automation: neues Gmail verlangt Telefon+CAPTCHA). → Der User legt die Accounts/Domain
    selbst an (Runbook, ~10–15 Min) und übergibt danach die Supabase-Connection-Strings/Keys.
    Erst dann übernimmt Claude die gesamte Slice-1–5-Technik.

### #214 — Cloud-Migration Slice 1 (DB→Supabase) — VORARBEIT GEMERGT (#225)
- **Migration 0033 rollen-bedingt gemacht** (`DO`-Block + `pg_roles`-Existenzprüfung): auf
  Supabase existiert `n8n_app` nie → unbedingtes `ALTER ROLE` hätte die Kette abgebrochen.
  + Portabilitäts-Regressionstest. Auf dem Mini unverändert. (Account-unabhängiger Teil von #214.)
- **Rest von #214 ist blockiert** auf das Supabase-Projekt (Schema/Daten/RLS-Rollen/GUC live
  anwenden + acme↔globex-Isolationsbeweis gegen Supabase). GUC-Vorregistrierung
  (`ALTER DATABASE … SET automatenlager.current_tenant=''`) ist ein **out-of-band Supabase-
  Setup-Schritt** (kein Repo-Migrations-Test — `ALTER DATABASE` läuft nicht in der Tx).

## Offene Issues (Stand Sessionende)
- **#212** Slice 0 — nur noch Accounts/Domain (User). **#214–#219** Slices 1–5 — blockiert auf
  die Cloud-Accounts (Live-Verifikation je Slice). **#198/#206** WF3/WF1-Cutover (Schattenbetrieb).
  **#164** n8n-Abschluss-Cleanup. **#210/#211** GuV-EK/MwSt-Datenbugs (unabhängig). **#108/#111**.

## Nächster Schritt
1. **User:** Accounts (Supabase/Render/Cloudflare) + Domain `faltrix-solutions.de` anlegen
   (Runbook `docs/cloud-migration/slice-0-account-domain-runbook.md`), Supabase-Keys übergeben.
2. **Dann Claude:** #214 scharf (Schema+Migrationen 0001–0036 auf Supabase, Rollen/RLS/GUC,
   Faltrix-Daten via `pg_dump`/`pg_restore`, App testweise auf Supabase) → `start-issue`/`tdd`.
3. **Parallel jederzeit deploybar:** #221 auf den Mini (Migration 0036 + Restart).
