# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-13_vor-betriebsreife.md`.

## Session 2026-06-13 — BETRIEBSREIFE + CLOUD-UMZUG VOLLZOGEN — Cloud ist führend, Mini = warmer Rückfall

> Fokussierter „Betriebsreife"-Block, autonom durchgezogen. **Die App läuft live unter
> `https://app.faltrix-solutions.de` (Cloudflare → Render `faltrix-dashboard.onrender.com`
> → Supabase); die Cloud ist jetzt der voll eigenständige, FÜHRENDE Schreiber.** Der Mini
> läuft bewusst weiter als warmer Rückfall (+ Off-Site-Backup). Memory: `cloud-migration-stand`.

### Erledigt + live verifiziert (2026-06-13)
- **Resend-Mail:** Domain `faltrix-solutions.de` verifiziert (Cloudflare-DNS: send-MX/SPF +
  `resend._domainkey` DKIM + `_dmarc`); Custom-SMTP in Supabase Auth (`smtp.resend.com:465`,
  Absender `noreply@faltrix-solutions.de`); alle 6 Auth-Vorlagen + Security-Notifications auf
  Deutsch. Zustelltest grün. (Browser-Auto-Übersetzung verfälscht die DNS-Anzeige — per `dig`/
  Node-DNS gegenprüfen, echtes DNS war korrekt.)
- **2. Login `lantspeku@gmail.com`:** per Admin-API eingeladen, Invite-Mail (deutsch) delivered;
  Login-Seite-Fix `5331f90` (`type=invite` wie `recovery`). Partner-Klick steht noch aus.
- **pg_cron scharf:** `pg_cron`+`pg_net` installiert; `deploy/render/pgcron-setup.sql` gefixt
  (`:'VAR'` interpoliert NICHT in `DO`-Blöcken → `set_config`/`current_setting`; Secret nicht
  geechot; `backup-supabase` bleibt auf dem Mini). 10 `faltrix_`-Cron-Jobs aktiv.
- **Daten-Sync Mini→Supabase:** atomarer Voll-Reload (`pg_dump --data-only` +
  `session_replication_role=replica` + TRUNCATE + Reload in EINER TX). **WICHTIGE Erkenntnis:**
  der Mini-Worker schreibt OHNEHIN nach **Supabase** (`@aws-1-…pooler.supabase.com` in der Mini-
  `.env.local`) — Mini + Cloud teilen DIESELBE DB ⇒ keine Divergenz, Parallelbetrieb nur redundant
  (Dedup/Watermark/Drive-`move()` schützen).
- **Juni-GuV = 200,40 € / 152 Stk (Moma-Wahrheit):** zwei Lücken geschlossen — **#228** GuV-
  Aggregator-Einfrier-Bug (`skipExisting`+`ON CONFLICT DO NOTHING` → spätere Mehrfachverkäufe
  verworfen) gefixt (Upsert `ON CONFLICT … DO UPDATE … WHERE source='wf8_guv_aggregator'`,
  Commit `8d34567`, in der Cloud live verifiziert); + 2 fehlende 08.06.-Verkäufe (ohne Nayax-ID,
  Import übersprang sie) per `sales_transactions`-Insert + `stock_movements`-Abgang nachgetragen.
- **#229** täglicher Moma↔Verkäufe↔GuV-Reconciliation-Alarm (`lib/jobs/sales-reconcile-totals.js`,
  Check A Import + Check B Buchung, Mailer-Alarm, Worker + pgcron verdrahtet, 6/6 Unit; `d78489a`).
  Cloud-Mailer = `resend` ⇒ Alarm kann wirklich mailen. **#230** Arch-Issue (Mehrmandanten-
  Rechnungseingang → Objektspeicher statt Betreiber-Drive).
- **wf1/wf9-404 GELÖST:** Wurzelursache = **`ANTHROPIC_API_KEY` fehlte in der Render-Env** (NICHT
  Drive — Erstdiagnose korrigiert). `createInvoiceIntakeJob`/`createPicklistPollJob` liefern
  `disabled`, wenn Drive ODER Anthropic fehlt (invoice-intake.js:310, picklist.js:216) → Worker
  pusht den Schedule nicht (worker.js:389/395) → Trigger 404 `JOB_UNKNOWN`. Diagnose: `/health`
  temporär um `invoiceDrive/picklistDrive/anthropic/mailer/wf*Cutover` erweitert (r6–r8), danach
  wieder schlank (r9, `066df33` — kein Konfig-Leak öffentlich). User trug Key in Render ein →
  `anthropic:live` → Trigger `wf1`/`wf9` = 202, Läufe `success`. Betraf auch claude-proposals.
- **UMZUG vollzogen:** Cloud-`wf3` lief in Render noch im **Schatten** (`WF3_CUTOVER` fehlte;
  `WF1_CUTOVER=1` war schon da). User setzte `WF3_CUTOVER=1` → `/health wf3Cutover=1`, manueller
  Cloud-`wf3`-Lauf 16:14 `success` im Cutover. **Cloud schreibt jetzt Verkäufe + Rechnungen +
  alles selbst.**

### WF-Env in Render — Mapping (Betreiber-Frage geklärt)
Nur **WF1/WF3** haben Cutover-Schreibschalter; **WF1/WF9** brauchen zusätzlich einen expliziten
Mandanten (`WF1_TENANT_ID`/`WF9_TENANT_ID` || `NAYAX_TENANT_ID`, KEIN Single-Registry-Fallback).
Alle anderen Workflows brauchen KEINE `WF#`-Env: WF0 obsolet · WF2/WF4/WF7 = Dashboard-Endpunkte
(UI-Knopf) · WF5 (`wf5-monitor`) + WF8 (`wf-guv-aggregate`) = Cron-Jobs via tenantRunner für ALLE
Mandanten · WF3/filllevel/reconcile lösen den Mandanten über `NAYAX_TENANT_ID`/Single-Tenant.

### Mini = Rückfall (NICHT stilllegen)
Läuft weiter, redundant + harmlos (gleiche DB). Trägt das **Off-Site-Backup #216** (Platte D:,
bewusst nicht in der Cloud). Vollständige Mini-Stilllegung = optionaler Folge-Schritt: ZUERST das
Off-Site-Backup umziehen, DANN `docker stop homelab-worker` (reversibel).

### Sicherheits-Spot-Check live (2026-06-13)
Produktions-Endpunkte geprüft: **Origin-Guard** (direkter `onrender.com/api/*` = 403, nur über
Cloudflare erreichbar), **TLS erzwungen** (HTTP→301→HTTPS), **HSTS** (1 J, includeSubDomains) +
`nosniff` + `X-Frame-Options: DENY` + Referrer-Policy gesetzt, **kein Stack/Version-Leak**
(`Server: cloudflare`, kein `X-Powered-By`), `/health` schlank. **Geschäftsdaten dicht:** Gast
(`tenantId:null`) bekommt überall **leere** Listen (batches/locations/machines/nayax-devices/
correction-cases/onboarding/inventory-mhd alle `[]`/0); **Finanzen `/api/v2/economics` = 403
`finanzen.lesen`** (doppelt geschützt: Capability + Mandanten-Tür); Admin-Writes = 403.
**EIN Fund (niedrig, kein Datenleck):** `/api/dashboard` gibt **anonym** Workflow-Architektur-
Metadaten preis (Dateinamen, Node-Zahlen, Check-Ergebnisse — KEINE Geschäftsdaten/Secrets/PII),
weil es System-Dateien liest (nicht mandantengescoped; Gast hat `betrieb.lesen`).

### Offen
- **Security-Fix (klein, niedrig):** `/api/dashboard` ist anonym lesbar (nur Workflow-Metadaten)
  → in Cloud/`supabase`-Mode hinter Auth legen oder Gast-`betrieb.lesen` einschränken. Nächste
  Session als Erstes. (Auf dem Mini war Gast = Tailnet-intern; in der Cloud = öffentlich.)
- Partner-Login-Klick (`lantspeku@gmail.com`) — externe Aktion.
- Optionale Mini-Komplett-Stilllegung (Backup-Umzug zuerst).
- #230 Umsetzung (Mehrmandanten-Rechnungs-Objektspeicher) — Arch/Backlog. #198/#206 Cutover-Reste
  sind durch den Cloud-Cutover faktisch eingeholt.

## Session 2026-06-12 (Abend, 3) — ETAPPE 3 CLOUDFLARE LIVE — App unter eigener Domain, E2E grün

> Runbook: `docs/cloud-migration/etappe3-cloudflare-sicher.md`. Cloudflare-Anschluss
> per Browser-Begleitung durchgeführt. **Die App läuft jetzt unter
> `https://app.faltrix-solutions.de` — Frontend + API same-origin über Cloudflare,
> Backend hinter dem Origin-Guard.** DNS/Produktion: der Mini bleibt führend (die
> app-Subdomain ist neu, nichts am Mini geändert). H2 (Cloudflare-Bypass) DICHT.

### Live + verifiziert (2026-06-12)
- **Cloudflare Pages** `automatenlager` (Repo-Git, Auto-Deploy). Build
  `bash dashboard/deploy/cloudflare/build.sh` → Output `cf-dist`. **Advanced-Mode
  `_worker.js`** (nicht `functions/` — das wird im Projekt-Root gesucht, aus dem
  Monorepo-Unterordner NICHT erkannt → API landete auf HTML; gefixt). Worker
  proxied /api,/health,/internal → Render + SPA-Routing (/ → /v3, pretty URL ohne
  .html, sonst Redirect-Schleife).
- **Custom Domain** `app.faltrix-solutions.de` (CNAME auf automatenlager.pages.dev,
  TLS automatisch via Wildcard). Pages-Env: `RENDER_API_BASE` (Klartext) +
  `CF_ORIGIN_SECRET` (Geheimnis, verschlüsselt).
- **Origin-Guard scharf:** `CF_ORIGIN_SECRET` auch in Render-Env (gemeinsames
  48-hex-Token, per Zwischenablage gesetzt, Fingerabdruck-verifiziert ohne Klartext).
  Live: **direkter `onrender.com/api` ⇒ 403**, über `app.faltrix.../api` ⇒ 200,
  `onrender.com/health` ⇒ 200 (Render-Healthcheck offen).
- **Supabase Auth URL-Config:** Site-URL = `https://app.faltrix-solutions.de`,
  Redirect-Allowlist `…/​**` (Passwort-Reset-Link scharf).
- **E2E-Login-Test grün:** Login → Token → `app.faltrix.../api/v2/viewer` = admin/
  t_faltrix → `/api/dashboard` echte Daten. Ganzer Stack (CF→Worker→Render→Supabase).

### Stolpersteine (für künftige Cloud-Browser-Arbeit, in Memory)
- Cloudflare-Pages: `functions/` wird NICHT im Build-Output erkannt → `_worker.js`.
- Pages pretty URLs: `/v3.html`→308→`/v3`; Worker darf nicht auf `.html` zurück-
  schreiben (Schleife). config.js bleibt leer (same-origin).
- Render-Env-Bearbeitung: NIE per ref ein bestehendes Feld treffen (überschrieb
  versehentlich SUPABASE_URL → vor dem Speichern korrigiert) — IMMER „+ Add variable".
- Secret-Validierung ohne Klartext: SHA-256-Fingerabdruck lokal vs. Browser vergleichen.

### Offen
- **Letzter echter Cutover (#219):** DNS der Haupt-Domain / finaler Schwenk + Mini
  N Tage als Rollback. (Heute nur die app-Subdomain live; Mini unverändert führend.)
- **pg_cron** (#217): Nachtjobs laufen noch auf dem Mini; Cloud-Cron-Setup
  `dashboard/deploy/render/pgcron-setup.sql` + `WORKER_TRIGGER_SECRET` aus Render-Env.
- **#215-Reste:** 2. Eigentümer `lantspeku@gmail.com` braucht noch einen Supabase-
  Auth-User (Einladung), um sich einzuloggen (Rechte/Allowlist sind schon da).

## Session 2026-06-12 (Abend, 2) — ETAPPE 3 Backend-Sicherheit (H2/M1) autonom KOMPLETT

> Runbook: `docs/cloud-migration/etappe3-cloudflare-sicher.md`. Der Audit-Punkt
> **H2** (Cloudflare-Bypass) + **M1** (Rate-Limiting) sind im Backend gelöst +
> getestet + auf Mini & Render deployt (dort INERT/harmlos). Der Cloudflare-
> Anschluss selbst bleibt gemeinsamer Browser-Schritt (GitHub-OAuth/DNS = Betreiber).

### Fertig (autonom, Commit 237385c, Mini + Render deployt)
- **Rate-Limit** `lib/rate-limit.js` (600/60s pro IP, env `RATE_LIMIT_MAX`/`_WINDOW_MS`,
  0=aus; /health ausgenommen; CF-Connecting-IP nur wenn hinter Cloudflare verifiziert).
- **Origin-Guard** `lib/origin-guard.js`: Backend akzeptiert API nur mit geheimem
  `X-CF-Origin-Secret`; /health + /internal/ ausgenommen; **INERT ohne CF_ORIGIN_SECRET**
  (kein Aussperren), timing-safe. In server.js früh nach /health verdrahtet.
- **Cloudflare-Proxy** (sicherste H2-Variante): `deploy/cloudflare/functions/api/[[path]].js`
  proxied /api/* → Render + setzt den Origin-Header; `build.sh` Proxy-Modus
  (config.js leer/same-origin, kein CORS, Secret nie im Browser).
- 15 Tests (rate-limit/origin-guard/etappe3-server). **Suite 1454/1454, CI grün.**
  Live verifiziert: Mini /health+Login ok (inert), Render /health+API ok (inert,
  Rate-Limit lässt normal durch).

### Offen = gemeinsame Browser-Schritte (Runbook §"Cloud-Teil")
1. Secret erzeugen (`openssl rand -hex 24`) → Render-Env `CF_ORIGIN_SECRET`.
2. Cloudflare Pages-Projekt (GitHub-OAuth = Betreiber), Build `build.sh`, Output
   `dashboard/cf-dist`, Pages-Env `RENDER_API_BASE` + `CF_ORIGIN_SECRET`.
3. Custom-Domain `app.faltrix-solutions.de`; Origin-Guard scharf schalten +
   prüfen (direkter onrender.com-Zugriff ⇒ 403). Supabase Auth URL-Config.

## Session 2026-06-12 (Abend) — RENDER-BACKEND LIVE + CI (GitHub Actions) + Sentry

> Betreiber-Deploy von #217 (Backend → Render) per Browser-Begleitung durchgeführt.
> **Backend läuft live + sicher in der Cloud**, aber DNS zeigt weiter auf den Mini
> (kein öffentlicher Verkehr — Cloud nur uns bekannt). Nächster echter Schritt:
> Etappe 3 (Cloudflare, bringt auch H2/M1: API hinter Cloudflare) + pg_cron.

### Render-Backend (#217) — LIVE
- Blueprint `render.yaml` (Repo-Root) → Service **faltrix-dashboard**, Frankfurt,
  Docker (`dashboard/deploy/render/Dockerfile`, ganzes Repo). URL:
  **https://faltrix-dashboard.onrender.com** (Free-Tier: schläft bei Inaktivität,
  Cold-Start ~50 s). Service-ID `srv-d8m24c8g4nts73803u3g`.
- 5 Env beim Blueprint abgefragt (User per Notepad-Transfer für die 2 DB-URLs,
  3 öffentliche von mir), WORKER_TRIGGER_SECRET von Render generiert.
- **Live verifiziert:** `/health` ok (DB verbunden ⇒ Werte korrekt), `auth/config`
  mode=supabase, **C1 live: gefälschter Tailscale-Header ⇒ Gast** (kein Spoofing),
  alle 4 Security-Header live. Notepad-Temp-Datei gelöscht.
- **Offen bei #217:** pg_cron-Aktivierung (Nachtjobs in der Cloud) — Jobs laufen
  noch auf dem Mini; Cron-Setup `dashboard/deploy/render/pgcron-setup.sql`.

### CI — GitHub Actions (`.github/workflows/ci.yml`)
- node:test bei jedem Push/PR, **ohne DB-Secret** (DB-Tests skippen). Suite in CI
  1216 pass / 0 fail / 223 skip. Fand sofort 4 brüchige Tests (lasen externe
  homelab-Dateien außerhalb des Repos) → mit t.skip CI-tauglich gemacht.

### Sentry (Fehler-Frühwarnung) — eingerichtet + live
- Org `faltrix-gbr` (GitHub-SSO), Projekt **node** (EU-Region, .ingest.de). DSN als
  `SENTRY_DSN` in Render-Env. `lib/sentry-lite.js` aktiviert sich automatisch.
  **Live-Beweis:** Test-Event an den Ingest-Endpunkt ⇒ HTTP 200.

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
