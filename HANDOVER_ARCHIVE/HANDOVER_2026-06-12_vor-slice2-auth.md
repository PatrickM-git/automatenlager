# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-12_vor-slice1-supabase.md`.

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
- **#215–#219** Cloud-Slices 2–5 (#215 Auth-Naht ist durch #214 entblockt). **#227**
  Worker-env-Bug (klein). **#198/#206** WF3/WF1-Cutover-Reste. **#164** n8n-Abschluss-
  Cleanup. **#210/#211** GuV-EK/MwSt-Datenbugs. **#108/#111**.

## Nächster Schritt
1. **#215 (Slice 2 — Auth-Naht):** Supabase Auth aktivieren; `resolveViewer` um den
   JWT-Pfad erweitern (Signaturprüfung gegen Supabase JWKS), Mapping über `tenant_users`
   unverändert; Doppelpfad Tailscale/JWT per Env-Schalter; minimaler v3-Login.
   Benötigt: `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` aus dem
   Supabase-Dashboard (Settings → API) in `.env.local`.
2. Danach #216 (Off-Site-Backup), #217 (Render), #218 (Cloudflare), #219 (Cutover).
3. **Beobachten:** `wf3-nayax-reconcile`-Läufe in `audit.workflow_runs`.
