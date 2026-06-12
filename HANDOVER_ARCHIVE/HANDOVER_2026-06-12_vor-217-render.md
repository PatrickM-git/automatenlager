# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-12_vor-216-backup.md`.

## Session 2026-06-12 — #216 (Off-Site-Backup Supabase) KOMPLETT + LIVE AUF DEM MINI

> Runbook: `docs/cloud-migration/slice-betriebsreife-216-offsite-backup.md`.
> Job `backup-supabase` (pg_dump custom, Validierung, Retention, Alarmkette
> BACKUP_FAIL/BACKUP_STALE über den Anomalie-Monitor) läuft täglich 03:15 im
> Mini-Worker → `/mnt/d/backups/supabase` (externe Platte). **Restore-Probe REAL**
> (Scratch-DB auf dem Mini, Zeilenzahlen identisch). Live-Lauf im Container ✓,
> Telemetrie success ✓. Dockerfile jetzt mit `postgresql17-client` (Supabase=PG17;
> Image auf dem Mini neu gebaut). Manueller Trigger: `tools/run-backup-once.js`.
> Suite 1405/1405.

## Session 2026-06-12 — #215 (Slice 2: Auth-Naht) KOMPLETT

> Identität kommt jetzt (per Env-Schalter) aus einem serverseitig verifizierten
> Supabase-JWT statt aus dem Tailscale-Header; Mandanten-Tür/RLS unverändert.
> **Runbook: `docs/cloud-migration/slice-2-auth-naht-runbook.md`.**

### Was steht (verifiziert: Unit + Spawned + E2E gegen echtes Supabase + Browser-QA)
- **`lib/supabase-auth.js`:** ES256-JWT-Verifikation gegen Projekt-JWKS (kein Secret,
  keine neuen Deps); iss/aud/exp + Signatur; alg-Downgrade abgelehnt; wirft nie.
- **Doppelpfad `DASHBOARD_AUTH_MODE`** (leer/tailscale = Mini wie bisher; supabase =
  NUR JWT, Spoof-Header wirkungslos). getViewer bleibt synchron (req._jwtEmail am
  Handler-Eingang). Neu: GET /api/v2/auth/config, /login (minimale v3-Login-Seite
  mit Reset/Recovery), Fetch-Shim + Login-Wand in v3.js.
- **E2E:** echter Login (REST) ⇒ viewer eigentuemer/t_faltrix gegen die Supabase-DB;
  Default-Deny + Break-Glass (404/403/ignore) bewiesen; Browser-QA grün. Suite 1398/1398.
- **Provisioniert:** Auth-User patrickmatthes2609@gmail.com (QA-Passwort in .env.local —
  Betreiber soll es per Reset-Flow ersetzen); Keys (publishable/secret) in .env.local.
- **Offen (Domain-abhängig, → #218/#219):** Supabase Auth URL-Configuration (SITE_URL +
  Redirect-Allowlist) — Reset-Mail-Link braucht die finale Domain. 2FA-Enroll-UI bewusst
  nicht gebaut (Phase C). lantspeku@gmail.com hat noch keinen Auth-User.

## Session 2026-06-12 — #214 (Slice 1: DB → Supabase) KOMPLETT

> Cloud-Migration Phase B, Slice 1. Die komplette PostgreSQL-Schicht ist auf
> Supabase portiert und mit der echten Isolationssuite bewiesen. Produktivbetrieb
> unverändert (Mini zeigt weiter auf die Mini-DB) — Supabase ist bis zum Cutover
> (#219) eine verifizierte, wegwerfbare Kopie.
> **Runbook + Ergebnis-Protokoll: `docs/cloud-migration/slice-1-db-supabase-runbook.md`.**

### Was steht (alles automatisiert verifiziert)
- **Rollen-Split ohne Custom-BYPASSRLS:** Infra = `postgres` (Supabase, rolbypassrls=true),
  App = `automatenlager_app` (LOGIN, kein Bypass) über den **Transaction-Pooler 6543**
  (`automatenlager_app.<ref>`); `app_reader`/`app_writer` out-of-band via
  `dashboard/deploy/supabase/bootstrap-roles.sql`; `n8n_app`/`migrator`/`validator`
  bewusst NICHT angelegt (0033 skippt rollen-bedingt — #225-Vorarbeit zahlte sich aus).
- **Schema + Daten:** `pg_dump --schema-only --no-owner` (gefiltert: n8n_app/migrator/
  validator-Grants, homelab-Default-ACLs → Ersatz `post-restore-default-privileges.sql`)
  → Daten-Restore mit `session_replication_role=replica` (keine Trigger-Doppelbuchung)
  → **Migrationskette 0001–0036 komplett grün** (erst Daten, dann Migrationen — 0006/0010/0018
  seeden mit Tenant-FK!) → 3 MatViews refreshed. **Zeilenzahlen Mini↔Supabase identisch**
  (nur `audit.workflow_runs` +6 = Worker-Telemetrie nach Dump; Delta-Sync beim Cutover).
- **Isolationsbeweis:** `DASHBOARD_V2_PG_URL=$SUPABASE_PG_URL_SESSION node --test
  tests/dashboard-mt-*.test.js …` → **163/163 grün gegen Supabase**; neue Suite
  `tests/supabase-slice1-verify.test.js` (Rollen, Migrations-Marker, fail-closed, Daten).
- **/health vom Mini gegen Supabase:** temporäre Zweitinstanz (PORT=8899, Env-Override)
  → `{"ok":true,"tenantDirectoryReady":true,…}`. Volle Suite vs. Mini: 1380/1381
  (1 bekannter Parallel-Flake `dashboard-v2-uploads`, isoliert 8/8).

### Entscheidungen/Befunde (wichtig für die nächsten Slices)
1. **KEINE GUC-Vorregistrierung** (bewusste AC-Abweichung): `ALTER DATABASE … SET …=''`
   würde fail-closed (42704, Migration 0034) aufweichen; `set_config` geht auf Supabase
   auch ohne. Hinter dem Supavisor-Pooler kann ein recyceltes Backend `''` statt 42704
   liefern — beide Formen dicht, Tests prüfen zustandsbewusst (0034 + verify-Suite).
2. **Migration 0031 ist auf Supabase voll wirksam** (globale Business-Key-Uniques weg =
   Endzustand); auf dem Mini bleibt Teil 1+2 deploy-gated (#164/#198). Tests #99/#102
   asserten jetzt beide Zustände exakt.
3. **Supabase-Verbindungen** in `dashboard/.env.local`: `SUPABASE_PG_URL_SESSION` (Infra,
   5432), `SUPABASE_PG_URL_TX`, `SUPABASE_APP_PG_URL_TX` (App-Rolle, 6543; Passwort im
   Passwortmanager). Referenz dokumentiert in `dashboard/.env.example`.

## Offene Issues (Stand Sessionende)
- **#217–#219** Cloud-Slices (Render → Cloudflare → Cutover). **#227**
  Worker-env-Bug (klein). **#198/#206** WF3/WF1-Cutover-Reste. **#164** n8n-Abschluss-
  Cleanup. **#210/#211** GuV-EK/MwSt-Datenbugs. **#108/#111**.

## Nächster Schritt
1. **#217 (Slice 3 — Backend + Jobs → Render):** server.js als Render-Web-Service,
   Trigger-Endpunkte `/internal/jobs/<key>` mit `WORKER_TRIGGER_SECRET` (timing-safe),
   pg_cron+pg_net-Schedules in Supabase, flüchtiges FS auflösen, Sentry.
2. Danach #218 (Cloudflare), #219 (Cutover).
3. **Beobachten:** erster geplanter `backup-supabase`-Lauf (03:15) + `wf3-nayax-reconcile`.
