# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-08_slice1-job1-matview.md`.

## Nachtrag (2026-06-08, noch später) — Slice 1 **Job 2/5 (WF8 GuV) KOMPLETT cutover + LIVE; WF8 deaktiviert**

**WF8 GuV-Aggregator (n8n `gyM9rnvUMfnv4x3G`) vollständig durch `dashboard/lib/jobs/guv-aggregate.js` ersetzt — end-to-end live, WF8 DEAKTIVIERT.** PR [#171](https://github.com/PatrickM-git/automatenlager/pull/171) gemergt (`main` `42bc63f`), Mini deployt (`git reset` + `docker compose restart worker`).

- **Faithful Port** (gegen die ECHTEN WF8-Nodes + realen DB-Dump, nicht Doku-Annahmen): compute = 1:1 „Code - GuV aggregieren" + „Prepare PGW - guv_daily". **Bewusste Faithfulness-Befunde repliziert:** Konfig **snake_case** (`cfg->>'kleinunternehmer_aktiv'`) ⇒ **kleinunternehmer effektiv FALSE** (der reale camelCase-Wert `{"kleinunternehmerAktiv":true}` wird — wie in WF8 — NICHT gesehen); Zwischen-Rundung (`gross_profit=r2(Σumsatz−Σwarenein)`); Einkaufs- vs. Verkaufs-MwSt getrennt. Pre-Flight read-only Tool `dashboard/tools/preflight-guv-daily.js` + Doku `docs/data-model/wf8-guv-port-preflight.md`.
- **Mandantenfähig + sicher:** Reads je Mandant DURCH DIE TÜR (sequenziell, Vorbild `alert-digest`, RLS-/$1-gefiltert); Write `db.tx` (machine_key→machine_id / product_key→product_id **tenant-scoped** auflösen + **explizites tenant_id**, idempotent `ON CONFLICT (guv_key) DO NOTHING`). **KEIN rohes pg** (#107-rein). Worker-Schedule `wf-guv-aggregate` **intervalMs 900000** (echte WF8-Regel = alle 15 min; der Node-Name „Täglich 02:00" war irreführend).
- **Finanz-Cutover-Gate (PFLICHT, drift-immun):** `dashboard/tools/shadow-guv-parity.js` (read-only) führt WF8s **WÖRTLICHEN** Node-Code (aus der Workflow-JSON) und den Port auf **IDENTISCHEN Live-Inputs** aus ⇒ **BYTE-IDENTISCH 224/224 Keys** (lokal gegen die Prod-DB UND auf der Mini verifiziert, exit 0). **Bewusst NICHT „recompute vs. gespeichert"**: WF8s `cost_of_goods` hängt am FIFO-Chargen-Snapshot (status aktiv→leer driftet täglich); heute neu berechnete Vergangenheitstage weichen legitim ab, WF8 überschreibt historische Zeilen nie. Die drift-immune Äquivalenz ist die Parität auf identischen Inputs.
- **Live verifiziert (Mini):** `docker exec homelab-worker node worker.js --run wf-guv-aggregate` → idempotent (`inserted=0, skippedExisting=310, skippedStatus=64` — die 64 = reale `INSUFFICIENT_BATCH_STOCK`/`SKIPPED_BEFORE_CUTOVER`-Verkäufe, status≠OK, faithful übersprungen); `audit.workflow_runs` run **6973 status=success**. Worker plant `wf-guv-aggregate (alle 900s)`.
- **WF8 in n8n DEAKTIVIERT** (API `POST /workflows/gyM9rnvUMfnv4x3G/deactivate`, Identität vorher verifiziert, jetzt `active=false`; **Rollback = `/activate`**).
- Tests: 10 neu (compute-Parität: Status/Sentinel/EK/Aggregat/Kleinunternehmer brutto+netto/`revenue_net` @7%+@19%/`mdb_code`→null/`skipExisting`; Factory; **LIVE acme/globex-Isolation + Idempotenz** als `automatenlager_app`, RLS aktiv, nicht-vakuös: jeder bucht aus SEINER Charge). Voll-Suite **seriell 1130/1131** (1 vorbestehender Live-Flake `dashboard-v2-product-onboarding`, isoliert **34/34 grün** — bekannte Suite-Flakiness). #107-Guard 17/17.

**Separater Finanz-Befund (NICHT gefixt — eigenes Issue nötig):** die **Live-Dashboard-Ökonomie** (`category-config.js`/`economics.js`) liest `kleinunternehmerAktiv` **camelCase = true** ⇒ Brutto-Kostenbasis für „heutige" provisorische Posten, während die Nacht-GuV (`guv_daily`) **Netto** bucht (snake_case=false). **Live/Nacht-Divergenz** der Kostenbasis. Ein stiller Fix im Port hätte den Schatten-Match gebrochen ⇒ bewusst getrennt.

**🔒 Slice 1 Jobs 3–5 (WF-Val / WF-Monitor / WF-Nayax-Devices-Sync) WEITER BLOCKIERT — Cred-Befund 2026-06-08 bestätigt:** Mini `dashboard/.env.local` hat **kein** `GMAIL_*` / `NAYAX_API_TOKEN` (geprüft: GMAIL=0, NAYAX=0; der einzige „nayax" in der Compose ist `NAYAX_ABGLEICH_WEBHOOK_URL`, **kein** API-Token). Diese Secrets liegen in n8ns verschlüsseltem Store — **nur DU kannst sie in die Mini-`dashboard/.env.local` legen** (`GMAIL_USER`+`GMAIL_APP_PASSWORD` für den Val/Monitor-Mailer; `NAYAX_API_TOKEN` für Devices-Sync). Bis dahin **übersprungen** (wie geplant).

**Slice-1-Stand:** Job 1/5 MatView ✅ · **Job 2/5 WF8 GuV ✅** · Jobs 3–5 ⏸ (Cred-Block). **In n8n noch aktiv:** WF-Val `pdIjiyIfVIIPuJIt`, WF-Monitor `EdgUfv1lMcE25Z3K`, WF-Nayax-Devices-Sync `EaVcB3REMttuKZPa`. **Deaktiviert (Slice 1):** WF-MatView-Refresh `axeg30n8SVKlCW54`, **WF8-GuV `gyM9rnvUMfnv4x3G`** (+ vorab WF-Update-Check `HvaJ7W28xX3F5qJa`). n8n-API: `https://hp-mini-server.tail573a13.ts.net/api/v1`, Key `C:\Users\patri\.n8n-api-key`.

**Nächste Schritte:** (a) Creds in die Mini-`.env.local` legen ⇒ neuer Chat baut **WF-Val** (nur DB-Konsistenz-Checks, NICHT die WF3-Neustart-Mechanik) + **WF-Monitor** + **shared Mailer-Modul** + **WF-Nayax-Devices-Sync** nach genau diesem Muster (Port→Test→1 PR/Deploy→`--run`-Smoke→WF deaktivieren). (b) **HARTER STOPP bleibt** vor **#163** (datenkritisch, WF3 — Root-Cause/Fix-Anforderung unten + im #163-Kommentar) und **#164** (irreversibel).

---

## Nachtrag (2026-06-08, Slice-1-Fortschritt) — Jobs 2–5: Blocker + GuV-Recon/Build-Plan

**Status Slice 1 (#161):** Job 1/5 (matview-refresh) LIVE (s. u.). Jobs 2–5 analysiert (echte WF-JSONs gelesen):

**🔒 Credential-Blocker (nur DU kannst lösen — Secrets liegen in n8ns verschlüsseltem Store, NICHT in `.env.local`):**
- **WF-Val** (`pdIjiyIfVIIPuJIt`) + **WF-Monitor** (`EdgUfv1lMcE25Z3K`) mailen Gmail-Alerts → brauchen **Gmail-Cred** (z. B. `GMAIL_USER`/`GMAIL_APP_PASSWORD` in der Mini-`.env.local`) + ein **Mailer-Modul** (SPEC hatte den Mailer erst in Slice 2 — Falte: Val/Monitor können erst voll cutover, wenn der Mailer steht, sonst Alarm-Loch). Bei WF-Val zusätzlich: die **WF3-Neustart-Mechanik entfällt** (SPEC) — nur die DB-Konsistenz-Checks portieren, NICHT den `execution_entity`-Check.
- **WF-Nayax-Devices-Sync** (`EaVcB3REMttuKZPa`) → **Nayax-Lynx-API-Token** in `.env.local` (z. B. `NAYAX_API_TOKEN`).

**WF8 GuV (`gyM9rnvUMfnv4x3G`) — RECON KOMPLETT, self-contained (keine externe Cred), Build-Plan:**
- **Kadenz:** Node heißt „Täglich 02:00", echte Regel ist aber **alle 15 min** (`minutesInterval:15`) → Worker `intervalMs: 900000` (NICHT dailyAt).
- **Quelle (modern, die WF8-Read-Nodes lesen schon PG, gemappt auf Sheets-Feldnamen):** `sales_transactions` (st.settlement_at→sale_date Europe/Berlin, machine_key, product_key, mdb_code, quantity, gross_amount→umsatz_brutto, prices.sale_price_gross→vk), `stock_batches` (batch_key, unit_cost_net→unit_cost, products.vat_rate_pct→mwst_satz, status IN aktiv/active/reserve), `products`+`prices`, `classification_settings` (cfg `__default__`: kleinunternehmer_aktiv/mwst_snack=7/mwst_getraenk=19), `guv_daily` letzte 90 Tage (existing-Keys).
- **Algorithmus (faithful aus „Code - GuV aggregieren" + „Prepare PGW - guv_daily"):** je tx: status≠OK skip; date aus settlement (Sentinel `2001-…` skip); EK_netto+mwst_einkauf aus **erster** `batch_id_abgebucht`-Charge (sonst MwSt aus produktart: snack→7, getraenk→19); `ek_brutto=ek_netto*(1+mwst/100)`; `warenein = qty * (kleinunternehmer ? ek_brutto : ek_netto)`; aggregiere je **`guv_key=date|machine_id|product_key`** (vorhandene Keys skip = idempotent): `quantity_sold=Σqty`, `revenue_gross=Σumsatz_brutto`, `cost_of_goods=Σwarenein` (=`wareneinsatz_brutto`), `gross_profit=guv=revenue_gross-cost_of_goods`, `revenue_net = kleinunternehmer?gross : gross/(1+vat/100)` (vat: snack 7 / sonst 19); `source='wf8_guv_aggregator'`.
- **Write:** `guv_daily` upsert `ON CONFLICT (guv_key) DO NOTHING` (idempotent), **per Mandant durch die Tür** (`db.tx`, tenant_id), machine_key→machine_id / product_key→product_id auflösen.
- **⚠️ Finanz-Sicherheitsnetz = PFLICHT:** den **Schatten-Harness** (`lib/jobs/shadow-harness.js`, #160) nutzen — portierte `guv_daily`-Zeilen gegen WF8s echte `guv_daily` (letzte Tage) diffen; **WF8 NUR deaktivieren, wenn exakt gleich** (sonst falsche Kunden-P&L). Empfehlung: diesen einen Build mit **frischem Fokus** (nicht am Ende einer Marathon-Session).

**Muster (bewiesen an matview):** `lib/jobs/<name>.js` (rein + I/O durch Tür/Infra) → Tests (unit + Live acme/globex) → Worker-Schedule → 1 PR + `git reset`-Deploy + `docker compose restart worker` → `node worker.js --run <job>`-Smoke → WF via n8n-API deaktivieren (`POST /workflows/{id}/deactivate`, Rollback `/activate`). **Stopp vor #163/#164.**

**Beobachtung (2026-06-08):** **WF-Update-Check** (`HvaJ7W28xX3F5qJa`) wirft im Node „Code - Build Update Report" (`latest= current= [line 70]` — n8n-Versionsermittlung leer; **brüchig, vorbestehend** — auch 2026-06-01 `latest=2.23.1 current=`). **NICHT durch die Stufe-6-Arbeit verursacht** (prüft nur n8n-Docker-Image-Updates). Obsolet → war DROP-Kandidat Slice 2 → **am 2026-06-08 in n8n DEAKTIVIERT** (active=False; Rollback `/activate`; regulärer DROP in Slice 2).

**Root-Cause WF3-Umsatzverlust (2026-06-08, live verifiziert) → Dauer-Fix-Anforderung auf #163 dokumentiert:** Dashboard-Umsatz < Moma, weil `WF3 Code - FIFO berechnen` Z.559 `if (sDate <= lastSuccessfulSaleDate) continue;` einen **monoton-steigenden High-Watermark** (`workflow_state.last_inventory_review_at`) nutzt → **out-of-order/spät abgerechnete Nayax-Verkäufe werden dauerhaft übersprungen** (erreichen den Insert nie; ON-CONFLICT-Dedup irrelevant). `lastSales` ohne Zeitfenster. **Slice-3-WF3-Port (#163) MUSS:** Zeitfenster-Pull mit Overlap + Insert-immer + ON-CONFLICT-Dedup (Watermark nur Performance-Hint, kein Korrektheits-Gate), keine stillen Skips, Schatten-Match vor Cutover. **WICHTIG (korrigiert):** der bestehende **Nayax-Abgleich ist STOCK-ONLY** (re-verankert nur `current_machine_qty`); **für Umsätze gibt es heute KEINE Reconciliation** → eine **Sales-Reconcile ist NEU zu bauen** (Sales-Insert ON CONFLICT ohne doppelte FIFO-Abbuchung entkoppeln). Folge: ein übersprungener Verkauf ist heute **dauerhaft verloren** (kein Tool holt ihn nach). Die ~2,20 € sind ohne Nayax-Token (nicht in `.env.local`) / manuellen Insert nicht sauber rückholbar; Watermark-Reset ist GEFÄHRLICH (doppelte FIFO-Abbuchung).

---

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
