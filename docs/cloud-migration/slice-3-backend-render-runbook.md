# Slice 3 (#217) — Backend + Jobs → Render: Runbook + Ergebnis-Protokoll 2026-06-12

> SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md` (Slice 3). Backend
> als Render-Web-Service; Nachtjobs über geschützte Trigger-Endpunkte, von
> Supabase pg_cron angestoßen (Gratis-Stufe, kein Render-Cron); Secrets als
> Render-Env; Audit-Log in die DB (flüchtiges FS); Sentry für zentrale Fehler.

## Was im Code steht (alles getestet)

- **`lib/job-triggers.js` + `POST /internal/jobs/<key>`:** geschützter Trigger.
  Ohne `WORKER_TRIGGER_SECRET` ist der Pfad TOT (404); falsches/fehlendes Secret
  ⇒ 401 (timing-safe SHA-256-Vergleich); nur POST (405); unbekannter Job ⇒ 404;
  richtig ⇒ **202 sofort**, Lauf asynchron (pg_net-Timeout-tauglich), Ergebnis in
  `audit.workflow_runs`. Kein CORS-Allow (eigener `/internal/`-Präfix). Die
  Worker-Verkabelung wird lazy gebaut (`buildWorker` ohne `start()` — kein
  Scheduler, nur `runJobNow`), Web-Prozess sonst unverändert.
- **`lib/sentry-lite.js`:** minimaler Sentry-Store-Client (ES-frei, kein npm-Dep,
  fetch injizierbar, harter Timeout, **wirft nie**). Verdrahtet in `server.js`
  (Endpunkt-500 + uncaughtException/unhandledRejection) und `worker.js`
  (Job-Fehler je Tick + Prozess-Handler). No-op ohne `SENTRY_DSN`.
- **Flüchtiges FS (#213-Aufbau):** alle 11 Aktions-JSONL-Schreibpfade in
  `server.js` (refill/invoice/economics/writeoff/inventory/batch-ek/slot-change/
  correction/nayax-abgleich/onboarding/slot-assign) gehen jetzt über `auditAction`
  → DB-Senke `audit.access_log`. `GET /onboarding/started-keys` liest **primär
  die DB** (JSONL nur noch Dev-Fallback ohne PG).
- **Deploy-Artefakte:** `deploy/render/render.yaml` (Web-Service, Frankfurt,
  Health `/health`, Secrets als `sync:false`/`generateValue`),
  `deploy/render/pgcron-setup.sql` (pg_cron→pg_net-Schedules, idempotent,
  Job-Keys gegen `worker.js` verifiziert).

## Verifiziert (2026-06-12, automatisiert + lokaler Live-Smoke gegen Supabase)

- 7 Trigger-Unit/Spawned-Tests + 5 Sentry-Tests; volle Suite **1417/1417**.
- **Live-Smoke (lokaler server.js gegen die Supabase-DB):**
  `POST /internal/jobs/wf-matview-refresh` ⇒ ohne/falsches Secret **401**,
  richtig **202**, unbekannt **404**; danach frische `audit.workflow_runs`-Zeile
  `wf-matview-refresh = success`. Damit ist die Trigger→Job→Telemetrie-Kette
  bewiesen — die Cron-Quelle (pg_cron) ruft genau diesen Endpunkt auf.

## Aktivierung in der Cloud (Betreiber — Render-Account-Grenze)

Render-Service-Anlage ist ein nach außen wirkender Deploy-Schritt am
Betreiber-Account (wie die Account-Anlage in Slice 0). Schritte:

1. **Render → New → Blueprint**, Repo `PatrickM-git/automatenlager` verbinden,
   `dashboard/deploy/render/render.yaml` wählen. Beim ersten Deploy fragt Render
   alle `sync:false`-Secrets ab (Werte aus `dashboard/.env.local` bzw.
   Supabase-Dashboard). `WORKER_TRIGGER_SECRET` wird automatisch generiert —
   **diesen Wert kopieren** (Render → Service → Environment).
2. **`/health` prüfen:** `https://faltrix-dashboard.onrender.com/health` ⇒
   `{"ok":true,...}`.
3. **Supabase-SQL-Editor (als Eigentümer):**
   `create extension if not exists pg_cron; create extension if not exists pg_net;`
   dann `pgcron-setup.sql` mit `\set RENDER_URL '…'` und
   `\set WORKER_TRIGGER_SECRET '…'` ausführen (bzw. die zwei `:'…'`-Platzhalter
   ersetzen).
4. **Live-Smoke Cloud:** `SELECT jobname, schedule, active FROM cron.job WHERE
   jobname LIKE 'faltrix_%';` und nach ein paar Minuten `SELECT … FROM
   cron.job_run_details ORDER BY start_time DESC LIMIT 10;` + eine frische
   `audit.workflow_runs`-Zeile.

## Bewusste Abgrenzungen

- **Backup-Job auf Render:** `SUPABASE_BACKUP_DIR` ist in `render.yaml` NICHT
  gesetzt ⇒ der Job skippt auf Render (flüchtiges FS hat kein Off-Site-Ziel). Das
  Off-Site-Backup läuft weiter auf dem Mini (#216), bis ein Objektspeicher-Ziel
  angebunden ist (Folgearbeit).
- **Worker-Service:** auf Gratis bewusst KEIN Dauer-Worker; der `worker.js`-Code
  bleibt unverändert für Variante B (bezahlt). pg_cron ist die Quelle.
- **DNS/Domain/CORS** = Slice 4 (#218); finaler Cutover = #219. Bis dahin bleibt
  der Mini die führende, autodeployende Instanz (Rollback).

## Rollback

Render-Service pausieren/löschen + `cron.unschedule('faltrix_*')`. Der Mini läuft
unverändert weiter (führende Instanz bis #219).
