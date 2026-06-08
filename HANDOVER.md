# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-07_inventur-backup.md`.

## 2026-06-08 — Stufe 6 (n8n-Ablösung) **Slice 0 / #160** — Code+Tests FERTIG, PR-fertig, **NICHT deployt**

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
