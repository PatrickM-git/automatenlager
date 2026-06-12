# Cloud-Migration — Rollback-Runbooks je Slice (#219)

> Konsolidierte Rückwege für Phase B. Leitprinzip: **der Mini bleibt bis zum
> finalen, verifizierten Cutover die führende Instanz** (autodeployt von `main`,
> zeigt auf die Mini-DB). Jede Slice ist einzeln rückwegsfähig; ein Rollback
> dreht DNS oder eine Env-Variable zurück — kein Code-Revert nötig.

## Gesamt-Notbremse (während des Wartungsfensters)

Wenn nach dem DNS-Cutover etwas klemmt: **DNS zurück auf den Mini** (Tailscale-
Serve bzw. der bisherige Eintrag). Der Mini lief unverändert weiter ⇒ sofort
wieder voll funktionsfähig. Alle Cloud-Dienste bleiben stehen (kosten nichts auf
Gratis), die Analyse erfolgt ohne Zeitdruck.

## Slice 1 — DB → Supabase (#214)

- **Wirkung:** keine — der Mini zeigt weiter auf die Mini-DB. Supabase ist eine
  verifizierte Kopie.
- **Rollback:** Supabase-Projektinhalt verwerfen (Schema droppen / Projekt
  zurücksetzen). Wiederholung = `deploy/supabase/bootstrap-roles.sql` →
  Schema-/Daten-Restore → Migrationen (Runbook `slice-1-db-supabase-runbook.md`).
- **Beim echten Cutover:** kurz vorher Delta-Sync (die seit dem Dump
  hinzugekommenen Zeilen, v. a. `audit.workflow_runs`).

## Slice 2 — Auth-Naht (#215)

- **Schalter:** `DASHBOARD_AUTH_MODE`. `supabase` = JWT-Pfad (Cloud); leer/
  `tailscale` = Header-Pfad (Mini).
- **Rollback:** `DASHBOARD_AUTH_MODE` entfernen/auf `tailscale` ⇒ exakt das
  bisherige Verhalten; der JWT-Pfad ist dann komplett inert, die Login-Seite
  leitet auf /v3 um.

## Slice „Off-Site-Backup" (#216)

- **Wirkung:** additiv (ein zusätzlicher Job). Läuft auf dem Mini gegen Supabase.
- **Rollback:** die `SUPABASE_*BACKUP*`-Env-Zeilen aus der Mini-`.env.local`
  entfernen ⇒ der Job deregistriert sich beim nächsten Worker-Start. Vorhandene
  Dumps auf D: bleiben nutzbar. (Runbook `slice-betriebsreife-216-offsite-backup.md`.)

## Slice 3 — Backend + Jobs → Render (#217)

- **Wirkung:** der Mini-Web-/Worker-Betrieb bleibt unberührt, solange DNS auf den
  Mini zeigt. Die Trigger-Endpunkte sind ohne `WORKER_TRIGGER_SECRET` tot (404).
- **Rollback:**
  1. Render-Service pausieren/löschen.
  2. `cron.unschedule('faltrix_<key>')` für alle pg_cron-Jobs (bzw. die
     Extensions belassen — die Jobs feuern dann ins Leere, unschädlich).
  3. Der Mini-Worker übernimmt das Scheduling wie bisher (er lief durchgehend).
- (Runbook `slice-3-backend-render-runbook.md`.)

## Slice 4 — Frontend → Cloudflare (#218)

- **Wirkung:** `public/config.js` ist auf dem Mini leer (same-origin) ⇒ der Mini
  liefert sein Frontend unverändert aus. CORS ist ohne `DASHBOARD_CORS_ORIGINS`
  inert.
- **Rollback:** Cloudflare-Pages-Projekt pausieren / Custom-Domain entfernen;
  DNS zurück auf den Mini. Das Frontend des Mini funktioniert sofort weiter.
- (Runbook `slice-4-frontend-cloudflare-runbook.md`.)

## Slice 5 — Cutover-Abschluss (#219)

- **Statusseite** `/status` (liest `/api/v2/status`): nur additiv, kein Rollback
  nötig.
- **Finaler DNS-Cutover:** der einzige nicht-additive Schritt. Rückweg =
  Gesamt-Notbremse oben (DNS zurück auf den Mini, N Tage Parallelbetrieb als
  Sicherheit).

## Aufräumen / Abgrenzung (Mini-/Tailscale-Reste)

Im Cloud-Pfad gegenstandslos (bleiben für den Mini-Pfad gültig, schaden nicht):

- `DASHBOARD_INTERNAL_PEER_CIDR`, `DASHBOARD_TRUSTED_SERVE_IP` (#78, F1-Pfad-
  Vertrauen) — Tailscale-/Docker-Peer-Konzept; in der Cloud kommt die Identität
  aus dem verifizierten JWT, nicht aus einem Header über einen vertrauten Pfad.
- `DASHBOARD_DEV_LOCAL_ADMIN` (Loopback-Notausgang) — in der Cloud aus.
- Tailscale-Header (`Tailscale-User-Login`) — im `supabase`-Mode nie verwendet.

## Login-Platzhalter — Vermerk für Phase C (User Story 17)

Die Login-Seite (`public/login.html`) und die Statusseite (`public/status.html`)
sind **bewusst minimale Platzhalter** im v3-Stil. Ein ordentliches, markentaugliches
Login-/Status-Design ist **technische Schuld für Phase C (Marketing)** — siehe SPEC
`docs/specs/cloud-migration-3-schichten-phase-b-v1.md` §"Visual Direction" und der
Hinweis in `slice-2-auth-naht-runbook.md`. Funktional vollständig (Login, Reset,
2FA über Supabase verfügbar), optisch absichtlich schlicht.
