# #216 — Off-Site-Backup der Supabase-DB: Runbook + Ergebnis-Protokoll 2026-06-12

> Betriebsreife A3 (SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md`).
> Supabase-Gratis hat keine Auto-Backups ⇒ geplanter `pg_dump` + Alarmkette.

## Aufbau

- **Job `backup-supabase`** (`dashboard/lib/jobs/backup-supabase.js`, Infra-Executor):
  `pg_dump --format=custom --no-owner -n automatenlager -n audit` von der Supabase-DB
  (PG 17 ⇒ PG-17-Clients Pflicht; im Container via `postgresql17-client`, Dockerfile),
  Validierung `pg_restore --list` (≥ 40 TOC-Einträge) + Size-Guard (≥ 20 KB),
  Retention 30 Tage, Partial-Datei wird bei Fehlschlag entfernt.
- **Ziel (Off-Site):** externe Platte D: des Mini — `/mnt/d/backups/supabase`,
  im Worker-Container als `/backups/supabase` gemountet (compose). Der Mini ist
  zugleich das DR-Rollback-Ziel der Cloud-Migration.
- **Alarmkette:** Fehlerlauf ⇒ `BACKUP_FAIL`-Warnung (unresolved) + direkte Mail
  (best effort, `ALERT_EMAIL_DEFAULT`); der Anomalie-Monitor mailt `BACKUP_*`
  bereits **kritisch** alle 30 min. Ausbleibender Lauf ⇒ Staleness-Wächter im
  Anomalie-Monitor (`evaluateBackupStaleness`, > `SUPABASE_BACKUP_MAX_AGE_H`
  Default 30 h ⇒ `BACKUP_STALE`). Erfolgslauf löst offene `BACKUP_FAIL` auf.
- **Cron-Quelle:** Worker `dailyAt 03:15` (`WORKER_BACKUP_AT`) — dieselbe Quelle
  wie alle Nachtjobs; mit #217 wird der Auslöser wie alle Jobs auf
  pg_cron→Trigger-Endpunkt umgehängt (Cron-Doc Slice 0). Manuell:
  `docker exec homelab-worker node tools/run-backup-once.js` (schreibt Telemetrie).

## Verifiziert (2026-06-12)

- 7 Unit-Tests (Skip/Erfolg/pg_dump-Fehler/Size-Guard/Validierung/Mail-Robustheit/
  Staleness); volle Suite 1405/1405.
- **Echter Lauf (Dev + Mini-Container):** Dump ~430 KB, 480 TOC-Einträge, validiert;
  Datei auf `/mnt/d/backups/supabase/`; `audit.workflow_runs` = success;
  Worker-Log `geplant: backup-supabase (täglich 03:15)`.
- **Fehlerfall live:** kaputte URL ⇒ Job wirft, `BACKUP_FAIL`-Warnung geschrieben,
  Anomalie-Auswertung liefert `BACKUP_ALERT/critical` (Mail-Pfad bestehend getestet);
  Smoke-Warnung danach aufgelöst.
- **Restore-Probe REAL:** Dump in Scratch-DB `restore_drill_216` auf dem Mini
  (pg_restore 17 → PG-16-Server) wiederhergestellt — Zeilenzahlen identisch
  (products 47, sales 424, batches 59, guv 600, runs 10323); einziger ignorierter
  Fehler: `SET transaction_timeout` (PG17-GUC, auf PG16 wirkungslos — unkritisch).
  Scratch-DB wieder gelöscht. DR-Hinweis: Restore in ein frisches Supabase-Projekt
  ist derselbe Ablauf wie der Slice-1-Port (Rollen-Bootstrap → Restore).

## Aktivierung auf dem Mini (durchgeführt)

1. Compose: Worker-Volume `/mnt/d/backups/supabase:/backups/supabase` (Backup der
   Vorversion: lokal `/tmp/mini-compose.yml.bak`).
2. Mini-`dashboard/.env.local`: `SUPABASE_PG_URL_SESSION`, `SUPABASE_BACKUP_DIR=/backups/supabase`,
   `WORKER_BACKUP_AT=03:15`.
3. `docker compose build worker dashboard && docker compose up -d worker dashboard`
   (Image-Rebuild wegen `postgresql17-client`).

## Rollback

Env-Zeilen entfernen (Job deregistriert sich beim nächsten Worker-Start) bzw.
Compose-Volume zurücknehmen. Vorhandene Dumps auf D: bleiben nutzbar.
