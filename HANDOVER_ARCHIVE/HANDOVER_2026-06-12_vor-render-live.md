# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-12_vor-219-cutover.md`.

## Session 2026-06-12 (Nachmittag) — PRE-GO-LIVE-SICHERHEITSAUDIT + Härtung KOMPLETT

> Vor dem Cutover: 18-Punkte-Betreiber-Checkliste + „50 vibe-vulns" gegen ECHTEN
> Code geprüft (adversarial). Bericht: `docs/security/pre-go-live-audit-2026-06-12.md`.
> **Fundament solide** (SQL parametrisiert, alle Schreibpfade autorisiert, IDOR/RLS
> dicht, Secrets nie in Git, npm 0 vulns). Behobene Funde (Commit 35e05dd, Mini deployt + live verifiziert):
> - **C1 (kritisch):** Auth fail-closed — `process.env.SUPABASE_URL` erzwingt supabase-
>   Modus, fälschbarer Tailscale-Header in der Cloud wirkungslos (Mini-Login bleibt,
>   live verifiziert: Tailscale-Header ⇒ admin).
> - **H1:** kein Stack-Trace-Leak mehr (generische 500 + requestId).
> - **H3:** `.dockerignore` — `.env.local` nie im Image (Image-Build verifiziert).
> - **M2:** Security-Header (nosniff/DENY/Referrer/HSTS) live. **M3:** /api/v2/status
>   anonym nur Ampel. **L1:** Upload-Magic-Byte-Check. **DoS:** readJsonBody 1-MB-Limit.
> - Tests: `security-hardening.test.js` (6) + C1-Invarianten; **Suite 1439/1439**.
> **Offen = Plattform/Betreiber (kein Code):** H2/M1 API hinter Cloudflare (Etappe 3),
> L2 QA-Passwort ersetzen + 2. Admin-Login + Supabase-Auth-Policy/2FA (Etappe 4).
> **Zweiter Admin** `lantspeku@gmail.com`: in der Cloud-DB schon Eigentümer+Plattform-
> Admin, jetzt auch in `DASHBOARD_ADMIN_LOGIN` (beide E-Mails) — fehlt nur Login (Etappe 4).

## Session 2026-06-12 — #219 (Slice 5: Cutover-Abschluss) CODE KOMPLETT + LIVE AUF DEM MINI

> Runbook: `docs/cloud-migration/rollback-runbooks.md`. Damit ist der **Code aller
> Cloud-Slices (#214–#219) fertig**; offen sind nur noch die Betreiber-Deploys
> (Render-Blueprint, Cloudflare-Pages, finaler DNS-Cutover).

### Was steht (verifiziert: Unit + lokaler Browser-QA + Mini-Live)
- **Statusseite** `/status` + `GET /api/v2/status` (lib/status-page.js): aggregiert
  /health + letzte Job-Läufe (audit.workflow_runs) → je Job ok/stale/error/unknown,
  Gesamtstatus ok/degraded/down (503 bei down). Nur überwachte Jobs statusrelevant.
  **Live auf dem Mini: overall ok, 9/9 Jobs ok.** Browser-QA: Seite rendert sauber
  (grün, 2 Plattform-Zeilen, 9 Jobs OK, Auto-Refresh), keine Konsolenfehler.
- **Rollback-Runbooks** `docs/cloud-migration/rollback-runbooks.md`: Rückweg je
  Slice (DNS/Env zurück, kein Code-Revert), Gesamt-Notbremse, Aufräum-Abgrenzung
  (DASHBOARD_INTERNAL_PEER_CIDR & Co. im Cloud-Pfad gegenstandslos), Phase-C-
  Login-Platzhalter-Vermerk (US17).
- Suite **1432/1432**.

### Offen (Betreiber — Account-/DNS-Grenze)
- **#217 Render-Deploy** (Blueprint + pg_cron-Aktivierung), **#218 Cloudflare-Pages**
  (build.sh + Domain + CORS-Env), Supabase Auth URL-Config, **finaler DNS-Cutover**
  im Wartungsfenster + N Tage Mini-Parallelbetrieb. Anleitungen in den Slice-Runbooks.
- Erledigt-Kriterium #219: nach dem Cutover ein voller Tag Nachtjobs grün in der
  Cloud-`audit.workflow_runs`.

## Session 2026-06-12 — #218 (Slice 4: Frontend → Cloudflare) CODE KOMPLETT

> Runbook: `docs/cloud-migration/slice-4-frontend-cloudflare-runbook.md`.
> **Code + lokaler Browser-QA fertig; das Cloudflare-Pages-Projekt + die
> Domain-/CORS-Verdrahtung sind Betreiber-Schritte (hängen am #217-Render-Deploy).**

### Was steht (verifiziert: Unit + Spawned + lokaler Browser-QA)
- **Laufzeit-API-Basis** `public/config.js` (`window.__API_BASE__`): Mini leer
  (same-origin), Cloudflare via `deploy/cloudflare/config.cloud.js` = Render-URL.
  v3.html + login.html laden config.js vor ihrem Skript.
- **Fetch-Shim (v3.js):** Backend-Pfade (/api,/health,/internal) → API_BASE +
  Bearer-JWT; statische Assets same-origin. Leerer API_BASE = unverändert (Mini).
- **CORS** `lib/cors.js` + server.js: exakte Allowlist (DASHBOARD_CORS_ORIGINS),
  Preflight 204, KEINE Allow-Credentials (Bearer-JWT, nicht Cookies); leer = inert.
- **Cloudflare-Artefakte:** `deploy/cloudflare/` (config.cloud.js, _redirects =
  SPA-Fallback, _headers = config.js no-store, build.sh — lokal verifiziert).
- **Browser-QA (lokal, supabase-Mode, CORS gesetzt):** /login lädt sauber
  (config.js 304, auth/config 200, KEINE Konsolenfehler); Default-Deny-Redirect;
  Login speichert Token; CORS-Preflight 204 für erlaubte Origin. Suite 1425/1426
  (1 Windows-Spawned-Flake `dashboard-auth`, isoliert 19/19).

### Offen (Betreiber, hängt an #217-Render-Deploy + Domain)
1. Cloudflare Pages-Projekt (build.sh mit RENDER_BACKEND_URL, Output cf-dist).
2. Custom Domain app.faltrix-solutions.de (TLS automatisch).
3. Render: DASHBOARD_CORS_ORIGINS setzen. Supabase Auth URL-Configuration (SITE_URL
   + Redirect) — schaltet auch den #215-Reset-Mail-Link scharf.
4. Live-Browser-QA gegen die app-Domain.

## Session 2026-06-12 — #217 (Slice 3: Backend + Jobs → Render) CODE KOMPLETT

> Runbook: `docs/cloud-migration/slice-3-backend-render-runbook.md`.
> **Code + lokaler Live-Smoke fertig; der eigentliche Render-Deploy + die
> pg_cron-Aktivierung sind Betreiber-Schritte (Render-Account-Grenze) — Schritte
> im Runbook §"Aktivierung in der Cloud".**

### Was steht (verifiziert: Unit + Spawned + lokaler Live-Smoke gegen Supabase)
- **Geschützte Job-Trigger** `lib/job-triggers.js` + `POST /internal/jobs/<key>`:
  ohne WORKER_TRIGGER_SECRET tot (404), falsch/fehlend ⇒ 401 (timing-safe), nur
  POST (405), unbekannt ⇒ 404, richtig ⇒ 202 + Lauf async (Telemetrie in
  audit.workflow_runs). Worker lazy gebaut (runJobNow, kein Scheduler). Kein CORS.
- **Sentry-lite** `lib/sentry-lite.js` (kein npm-Dep, fetch, wirft nie) in
  server.js (500 + Prozess-Handler) und worker.js (Job-Fehler je Tick). No-op
  ohne SENTRY_DSN.
- **Flüchtiges FS:** alle 11 Aktions-JSONL-Schreibpfade → DB-Senke audit.access_log
  (auditAction); /onboarding/started-keys liest primär die DB.
- **Deploy-Artefakte:** deploy/render/render.yaml (Web-Service Frankfurt, Health,
  Secrets sync:false/generateValue), deploy/render/pgcron-setup.sql (pg_cron→pg_net,
  idempotent, Job-Keys gegen worker.js verifiziert: claude-proposals/wf9-pickliste!).
- **Live-Smoke:** lokaler server.js gegen Supabase, POST /internal/jobs/wf-matview-refresh
  ⇒ 401/401/202/404 + frische workflow_runs-Zeile success. Suite 1417/1417.

### Offen (Betreiber, Render-Account-Grenze)
1. Render → Blueprint (render.yaml), Secrets eintragen, WORKER_TRIGGER_SECRET kopieren.
2. /health Cloud prüfen.
3. Supabase: pg_cron+pg_net `create extension`, dann pgcron-setup.sql mit RENDER_URL +
   Secret. cron.job_run_details + workflow_runs als Live-Smoke.
- Backup-Job auf Render bewusst aus (flüchtiges FS); läuft weiter auf dem Mini.

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
- **Cloud-Migration Phase B Code KOMPLETT (#214–#219).** Offen nur die Betreiber-Deploys
  (#217 Render, #218 Cloudflare, #219 finaler DNS-Cutover) — Account-/DNS-Grenze. **#227**
  Worker-env-Bug (klein). **#198/#206** WF3/WF1-Cutover-Reste. **#164** n8n-Abschluss-
  Cleanup. **#210/#211** GuV-EK/MwSt-Datenbugs. **#108/#111**.

## Nächster Schritt
1. **Betreiber-Deploys (die einzigen offenen Schritte der Cloud-Migration):**
   - **Render** (#217): Blueprint `dashboard/deploy/render/render.yaml`, Secrets
     setzen, dann Supabase `pg_cron`/`pg_net` + `dashboard/deploy/render/pgcron-setup.sql`.
   - **Cloudflare** (#218): Pages-Projekt mit `dashboard/deploy/cloudflare/build.sh`
     (RENDER_BACKEND_URL), Custom-Domain, Render-Env `DASHBOARD_CORS_ORIGINS`,
     Supabase Auth URL-Config (SITE_URL/Redirect).
   - **Cutover** (#219): DNS-Schwenk im Wartungsfenster, Mini N Tage parallel.
   Alle Schritte in den jeweiligen `docs/cloud-migration/slice-*-runbook.md` + `rollback-runbooks.md`.
2. **Danach Phase C** (grill-me für die nächste Phase): ordentliches Login-/Status-
   Design, Stripe-Billing, Marketing-Site, 2. Kunde.
3. **Beobachten:** `backup-supabase` (03:15) + `wf3-nayax-reconcile`.
