# Slice 0 — Entscheidung: Cron-Quelle für die Nachtjobs

> Issue #212 · AC „Cron-Quelle entschieden und festgehalten (pg_cron vs. Cloudflare
> Cron), inkl. Schutzmechanismus". SPEC §"Nachtjobs auf der Gratis-Stufe".

## Problem

Auf der **Render-Gratis-Stufe gibt es keinen Dauer-Background-Worker** (und Web-Services
schlafen bei Inaktivität ein). Der heutige `worker.js` plant per `setInterval`/`setTimeout`
in einem langlaufenden Prozess — das gibt es gratis nicht. Die Job-**Logik** (`lib/jobs/*`,
durch die Mandanten-Tür, Telemetrie in `audit.workflow_runs`) bleibt identisch; nur der
**Auslöser** muss cloud-tauglich werden.

## Entscheidung

**Variante A — Supabase `pg_cron` + `pg_net` ruft geschützte HTTP-Trigger-Endpunkte auf Render auf.**

Begründung (Empfehlung):
- **Eine Plattform weniger:** Der Scheduler lebt direkt in der Datenbank, die wir ohnehin
  betreiben (Supabase). Kein zusätzlicher Cloudflare-Worker, keine zweite Secret-Verteilung.
- **`pg_cron` + `pg_net` sind auf Supabase-Gratis verfügbar** (Extensions aktivierbar).
- **Nahe an den Daten / Telemetrie:** Lauf-Spuren landen weiterhin in `audit.workflow_runs`;
  `pg_cron.job_run_details` liefert zusätzlich eine DB-seitige Cron-Historie.
- **Drift-arm:** feste Cron-Ausdrücke statt der `setInterval`-Heuristik (die auf dem
  WSL-Mini ohnehin Sonderfälle brauchte).

**Fallback / Variante B (sobald bezahlt):** `worker.js` als Render-Background-Worker mit
`restart: always` unverändert weiterlaufen lassen — die Trigger-Endpunkte bleiben dann
ungenutzt, aber vorhanden (kein Wegwerf-Code). Die `WORKER_*_MS/_AT`-Variablen sind dafür
weiterhin gültig.

**Cloudflare Cron Triggers** wurde als gleichwertige Alternative geprüft, aber **nicht**
gewählt: zusätzlicher Worker + zusätzliche Secret-Verteilung, ohne Vorteil gegenüber
pg_cron, solange Supabase ohnehin läuft. (Reaktivierbar, falls Supabase-Extensions je
eingeschränkt werden.)

## Schutzmechanismus (Pflicht)

Die Trigger-Endpunkte (`POST /internal/jobs/<key>`) dürfen **nur** von der Cron-Quelle
auslösbar sein — sie sind ungeschützt sonst ein offener „führe einen Schreibjob aus"-Hebel.

- **Gemeinsames Secret `WORKER_TRIGGER_SECRET`** (Render-Env, geheim). `pg_net`-Aufruf
  sendet es als Header (`X-Worker-Trigger-Secret`), der Endpunkt vergleicht **konstanten
  Zeitvergleichs** (timing-safe). Fehlt/falsch ⇒ **401/403** (kein Job-Effekt).
- Endpunkte sind **idempotent** (wie die Jobs heute) — ein versehentlicher Doppel-Tick
  ist unschädlich.
- Endpunkte stehen **nicht** im Browser-/CORS-Pfad (eigener `/internal/`-Präfix, kein
  CORS-Allow), damit das Frontend sie nie erreicht.
- Test (SPEC §"Testing"): (a) ohne gültiges Secret 401/403; (b) mit Secret derselbe
  Job-Effekt wie der Worker-Lauf (eine plausible `audit.workflow_runs`-Zeile).

## Schedule-Abbildung (heute `worker.js` → künftig pg_cron)

| Job (`lib/jobs/*`) | Heute | pg_cron-Schedule (`Europe/Berlin`, `TZ` setzen) |
|---|---|---|
| WF3 Nayax-Verkäufe (`wf3-nayax-fifo`) | alle 5 Min | `*/5 * * * *` |
| Live-Füllstand-Sync (`nayax-filllevel-sync`) | alle 5 Min | `*/5 * * * *` |
| Nachbuch-Reconciliation (`wf3-nayax-reconcile`, #221) | gated (stündlich empf.) | `0 * * * *` (nur wenn aktiviert) |
| WF8 GuV-Aggregat (`guv-aggregate`) | alle 15 Min | `*/15 * * * *` |
| WF1 Rechnungseingang | alle 10 Min | `*/10 * * * *` |
| WF9 Pickliste | alle 5 Min | `*/5 * * * *` |
| WF-Claude-Proposals | täglich 04:30 | `30 4 * * *` |
| WF5 MHD/Low-Stock | täglich 07:00 | `0 7 * * *` |
| MatView-Refresh | täglich 04:45 | `45 4 * * *` |
| Anomalie-Monitor | alle 30 Min | `*/30 * * * *` |
| Off-Site-Backup (#216) | — (neu) | täglich, z. B. `15 3 * * *` |

> Hinweis: Die feinen Intervalle (alle 5 Min) sind „Live"-Motoren (Umsatz-Kachel, Füllstand).
> Auf der Gratis-Stufe ist das viele pg_net-Aufrufe — vertretbar, weil idempotent und
> einzelne kurze HTTP-Calls. Bei Bedarf zusammenfassen oder auf Variante B (Worker) gehen.

## Umsetzungsort

- **Slice 0 (#212):** nur diese **Entscheidung** + der Schutzmechanismus festgeschrieben.
- **Slice 3 (#217):** Trigger-Endpunkte + Secret-Prüfung im Backend bauen, `pg_cron`-Jobs
  in Supabase anlegen (Migration/Setup-SQL), Live-Smoke je Job.
