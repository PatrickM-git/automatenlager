# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-07_inventur-backup.md`.

## Nachtrag (2026-06-08, noch später) — Stufe 6 **Slice 1 (#161) BEGONNEN: Job 1/5 LIVE**

**Job 1/5 (WF-MatView-Refresh) komplett end-to-end live cutover** — der ganze Slice-1-Muster-Weg inkl. der heiklen **n8n-Deaktivierung** ist damit bewiesen:
- `lib/jobs/matview-refresh.js` (delegiert an Infra-Runner, REFRESH der 3 MatViews über BYPASSRLS). PR **#170** gemergt (`main` `b8d77d4`), auf den Mini deployt, Worker neu gestartet.
- Neuer **Worker-Scheduler `dailyAt`** (drift-toleranter Selbst-Reschedule, ersetzt n8n-`scheduleTrigger` zuverlässig — node-cron auf dem Mini unbrauchbar) + **`node worker.js --run <job>`** (Einmallauf, US4 + Live-Smoke).
- Live verifiziert: `--run wf-matview-refresh` → 3 MatViews refresht, `audit.workflow_runs` `wf-matview-refresh=success`; Worker plant `wf-matview-refresh (täglich 04:45)`.
- **WF-MatView-Refresh in n8n deaktiviert** (API, id `axeg30n8SVKlCW54`, active=False; **Rollback = reactivate**). n8n-Workflow-IDs (Slice 1): WF-Val `pdIjiyIfVIIPuJIt`, WF8-GuV `gyM9rnvUMfnv4x3G`, WF-Monitor `EdgUfv1lMcE25Z3K`, WF-Nayax-Devices-Sync `EaVcB3REMttuKZPa` (alle noch active). n8n-API: `https://hp-mini-server.tail573a13.ts.net/api/v1`, Key `C:\Users\patri\.n8n-api-key`, `POST /workflows/{id}/deactivate|activate`.

**OFFEN — Slice 1 Jobs 2–5** (je: faithful Port aus der WF-JSON + Tür/Infra + Tests + Deploy + `--run`-Smoke + WF deaktivieren):
- `guv-aggregate.js` (WF8, gyM9…) — GuV-Tagesposten `guv_daily` aus sales+batches+classification, **per Mandant durch die Tür**, idempotent (upsert `guv_key`). **Finanz-Logik → sorgfältig + faithful porten** (economics.js/guv-ek.js wiederverwenden).
- `db-validation.js` (WF-Val, pdIj…) — Konsistenz-Checks (Slots ohne Preis, neg. Mengen, alte Warnungen/Proposals, Verkaufs-Lag).
- `monitor.js` (WF-Monitor, EdgU…) — Container/Heartbeat/Backup-Checks; n8n-execution_entity-Checks → `audit.workflow_runs`.
- `nayax-devices-sync.js` (WF-Nayax-Devices-Sync, EaVc…) — `nayax_devices`-Upsert aus der **externen Nayax-API** (HTTP-Client + Token aus `.env.local` — sorgfältig).
- Muster steht (matview): Port → Test → 1 PR/Deploy → `--run`-Smoke je Job → WF deaktivieren. **Stopp vor #163 (datenkritisch) + #164 (irreversibel)** bleibt.

**Test-Hinweis (neu):** Mit dem **live laufenden Worker** (queriet die Mini-DB) flakt die Voll-Suite vom Dev gegen dieselbe Prod-DB (Lock-Kontention, wenn Live-Tests RLS-DDL im Sandbox anwenden) — `dashboard-jobs-tenant-runner` fiel seriell 1× aus, **isoliert 5/5 grün**. Künftig: verdächtige Live-Fehler isoliert gegenprüfen (Memory `node-cron-wsl-mini-unreliable`/`suite-parallel-flakiness`).

---

## Nachtrag (2026-06-08, später) — Slice 0 **LIVE deployt + verifiziert** (+ Worker-Fix #167)

Slice 0 ist auf dem Mini **deployt und live verifiziert**. Ablauf:
1. PR **#165** (Slice 0) + **#166** (IR-Runbook #109) → `main` gemergt.
2. **Mini-Deploy (Slice 0):** `git reset --hard origin/main` → **DDL 0027** auf Prod angewandt
   (Spalten `error/source/details` + Lese-Indizes; idempotent, verifiziert) → `npm install` (node-cron)
   → **Worker-Service** in die Mini-Compose `/mnt/c/homelab/docker-compose.yml` (Backup `*.bak-pre-worker`,
   `docker compose config`-validiert) → `up -d --build worker`. Dashboard/n8n/Postgres **unberührt**
   (kein Dashboard-Restart — `server.js` unverändert).
3. **Live-Smoke deckte einen echten Bug auf:** node-cron v4 verwarf auf dem WSL2/Docker-Mini **jeden Tick**
   als „missed execution" (WSL2-Uhr-Drift + v4-Drift-Schutz) → Heartbeat schrieb nie. node-cron feuert auf
   dem Dev-Rechner einwandfrei (Nutzung korrekt). **Fix PR #167:** Worker-Scheduler auf **`setInterval`
   (drift-immun) + `runOnStart`** umgestellt; node-cron bleibt für `cronExpr`-Jobs. **Echt-Timer-Tests**
   ergänzt (die Fake-cron-Test-Lücke geschlossen). Re-Deploy: `git reset` + `docker compose restart worker`.
4. **Verifiziert in der In-Container-Prod-DB** (`homelab-postgres`): `audit.workflow_runs`,
   `workflow_key='worker-heartbeat'` → run **6785** (runOnStart, 05:16 UTC) + run **6798** (Intervall, 05:21 UTC),
   beide `status=success`. ✅
   *(Hinweis Verifikations-Falle: `now() AT TIME ZONE 'UTC'` über node-pg wird in Dev-Lokalzeit interpretiert
   → scheinbare 2-h-Differenz; Dev-Tunnel `127.0.0.1:15432` ist dieselbe Prod-DB.)*

**Trivialer Rest:** Mini-Compose-Env trägt noch das (vom Code ignorierte) `WORKER_HEARTBEAT_CRON` — bei
Gelegenheit auf `WORKER_HEARTBEAT_MS` umbenennen (sonst greift der Default 300000 = 5 min, was passt).

**Nächster Slice (gemeinsam):** Slice 1 (**#161**) — idempotente Jobs (WF8/MatView/Val/Monitor/Devices)
durch diese Maschinerie portieren → je Smoke → entsprechende n8n-WF deaktivieren.

---

## 2026-06-08 — Stufe 6 (n8n-Ablösung) **Slice 0 / #160** — Code+Tests + LIVE deployt (Deploy s. Nachtrag oben)

Fundament für die n8n-Ablösung (SPEC: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md`,
Slice 0 = Z. 111). **Kein Verhaltenswechsel — n8n bleibt autoritativ.** Branch
`feat/n8n-abloesung-stufe-6-slice-0`. Test-first (TDD), alles durch die Mandanten-Tür,
**kein neuer BYPASS**.

### Was gebaut wurde (alle 8 AC)
- **Worker-Dienst** `dashboard/worker.js` — Scheduler-Ersatz für n8n. `createWorker(...)` rein/
  testbar (DI: Schedules + Recorder + cron); `buildWorker(...)` verkabelt Infra-/App-Pools wie
  `server.js`; `node worker.js` = Einstieg. **node-cron lazy** (Tests injizieren Fake-cron →
  offline). `require('./worker.js')` hat **keine** Seiteneffekte. Slice 0 plant nur einen
  **Heartbeat** (beweist cron→`audit.workflow_runs`). Beispiel-Compose:
  `dashboard/deploy/worker.compose.example.yml`.
- **Per-Mandant-Runner** `dashboard/lib/jobs/tenant-runner.js` — iteriert Registry
  (`listTenantIds()`), führt Job je Mandant **durch die Tür** aus (GUC). Fail-closed: kein/
  leerer Mandant ⇒ übersprungen; Verzeichnis nicht bereit ⇒ nichts läuft.
- **Infra-Runner** `dashboard/lib/jobs/infra-runner.js` — MatView-`REFRESH … CONCURRENTLY`
  über Infra/BYPASSRLS; View-Namen gegen Allowlist validiert (kein Identifier-Injection).
  **Dokumentierte #107-Ausnahme** (einziger Nicht-Tür-Pfad, analog `db-schema.js`).
- **Telemetrie-Schreiber** `dashboard/lib/workflow-runs.js` — `audit.workflow_runs`
  Start/Ende/Status/Fehler (`workflow_key`=Job-Name). Injizierter `exec` (Infra; System-
  Telemetrie **ohne** tenant_id). Telemetrie best-effort (Job-Fehler propagiert trotzdem).
- **Schatten-Harness** `dashboard/lib/jobs/shadow-harness.js` — `diffWrites`/
  `runShadowComparison` (compute+compare, **schreibt nie**). Kern für Slice 3.
- **#107-Guard erweitert** `dashboard/lib/query-filter-guard.js` — neuer `extraDirs`-Parameter:
  `lib/jobs/*` + Worker-Einstieg im **build-blocking** Scan; saubere Job-Module nicht geflaggt;
  `infra-runner.js`+`worker.js` dokumentiert allowlistet. Doku: `docs/security/query-filter-guard-allowlist.md`.
- **Migration `0027`** `db-migrations/0027-workflow-runs-write-contract.sql` — idempotent/additiv:
  ergänzt `audit.workflow_runs` um `error`/`source`/`details` + Lese-Indizes (`pgw_write`
  unberührt). **Vor Code anwenden.**
- **Pre-Flight (read-only, live)** `dashboard/tools/preflight-pgw-write.js` → Doku
  `docs/data-model/pgw-write-und-workflow-runs-preflight.md`.

### Pre-Flight-Befunde (wichtig für Slice 1–3)
- `automatenlager.pgw_write(p_event_type, p_batch_run_id, p_payload)` behandelt 11 event_types
  (`product, product_alias, slot_assignment, invoice, invoice_item, stock_batch, sale,
  stock_movement, guv_daily, warning, proposal_resolved`) — **vollständige Zieltabellen/
  Konfliktschlüssel-Tabelle in der Pre-Flight-Doku.**
- **`pgw_write` ist mandantenblind:** keine `tenant_id`-Inserts, **globale** einspaltige
  Konfliktschlüssel (`product_key`, `batch_key`, `nayax_transaction_id`, …). Genau deshalb:
  Ports (Slice 1–3) durch die Tür mit GUC; globale Uniques → `(tenant_id,key)` erst in
  **Slice 4 (#111)**, nachdem alle Schreiber durch die Tür gehen.
- Reales `audit.workflow_runs`: `run_id, workflow_key, started_at, finished_at, status,
  records_in/out/failed, notes` (kein `error`/`source` → 0027 ergänzt).

### Tests
- 6 neue Testdateien (shadow-harness, workflow-runs-writer, tenant-runner [+**Live** acme/globex
  als `automatenlager_app`, RLS aktiv], infra-runner, worker-smoke, migration-0027 [**Live**
  Round-Trip]). Guard-Test um #160-Block erweitert. Einzeln grün; **Voll-Suite-Lauf**: siehe
  Commit/PR.

### ⚠️ AUSSTEHEND (erst danach „erledigt") — Mini-Deploy (KEIN Code-Schritt mehr offen)
1. PR `feat/n8n-abloesung-stufe-6-slice-0` mergen.
2. Mini-Deploy: `git pull --ff-only` → **DDL 0027 anwenden** (vor Code, idempotent) →
   `npm install --omit=dev` (node-cron) → Worker-Compose-Service einhängen
   (`deploy/worker.compose.example.yml` als Vorlage) → `docker compose up -d --build`.
3. **Live-Smoke:** Worker-Logs zeigen Heartbeat; `audit.workflow_runs` trägt
   `workflow_key='worker-heartbeat', status='success'`.
4. Danach **Slice 1 (#161):** idempotente Jobs (WF8 GuV, MatView-Refresh, WF-Val, WF-Monitor,
   WF-Nayax-Devices-Sync) portieren → je Smoke → entsprechende n8n-WF deaktivieren.

## Standing-Kontext (unverändert)
- Mandantenfähigkeit **Stufe 0–5 LIVE** (RLS-Backstop liest+schreibt). 1 echter Kunde (Faltrix)
  auf dem Heim-Mini; n8n macht noch WF1/2/3/5/7/8/9 im BYPASS (außerhalb des Backstops, bis
  Slice 4). Nordstern/Reihenfolge: `docs/ROADMAP.md`. **Kein zweiter realer Kunde vor Stufe 6 + Cloud.**
- Tägliches PG-Backup auf externe Platte D: (Memory `pg-backup-mechanismus`); Deploy-Mechanismus
  Memory `mini-deploy-mechanismus`. Stufe-5-Details: `HANDOVER_ARCHIVE/HANDOVER_2026-06-07_inventur-backup.md`.
