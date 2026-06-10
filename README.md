# Automatenlager — Leitstand und Backend

Mandantenfaehiges Inventar- und GuV-System fuer Vending-Automaten auf Basis von
Nayax/Moma-Verkaufsdaten: PostgreSQL als einzige Wahrheit, ein Node.js-Dashboard
als Leitstand und ein Worker-Dienst, der die frueheren n8n-Workflows als
Backend-Jobs abloest. FIFO-Lagerabbuchung, MDB-Slot-Historie, MHD-/Bestands-
Monitoring und GuV-Aggregation laufen als Code, nicht mehr ueber Google Sheets.

## Aktueller Entwicklungsstand (2026-06-10)

- **Produktion:** HP Mini (Docker unter WSL2) mit PostgreSQL, Dashboard,
  Worker und n8n (Alt-System). Details und Tagesstand: `HANDOVER.md`.
- **SQL-only:** Google Sheets ist als Datenschicht abgeloest. Die
  Sheets-Schreibknoten in den `WF*.json`-Exporten sind bewusst deaktiviert;
  die XLSX-Datei im Repo ist ein historischer Snapshot.
- **Mandantenfaehigkeit Stufe 2–5 live:** Auth default-deny mit
  Mandanten-Registry, Lese- und Schreib-Isolation durch die Mandanten-Tuer
  (`dashboard/lib/tenant-db.js`), RLS-Backstop in der DB (Rolle
  `automatenlager_app`, fail-closed).
- **Stufe 6 (n8n-Abloesung) in Arbeit:** Die meisten Workflows sind als Jobs
  in `dashboard/lib/jobs/` portiert und laufen ueber `dashboard/worker.js`.
  WF1 (Rechnungseingang) und WF3 (Nayax-FIFO) rechnen im **Schattenbetrieb**
  parallel zu n8n; der Cutover ist auf beweisbar deckungsgleiche Läufe
  gegated (#198).
- **Dashboard v3:** Multipage-Frontend (`dashboard/public/v3.html`) mit
  Cockpit, Lager/MHD, GuV, Sortiment, Automaten, Einstellungen; Gaeste sehen
  alles read-only.
- Architekturueberblick: `ARCHITECTURE.md`. Planung: `docs/ROADMAP.md`.

## Tech-Stack

- PostgreSQL (Schema `automatenlager`), 33+ idempotente Migrationen in
  `dashboard/db-migrations/`, Row-Level-Security je Mandant
- Node.js: `dashboard/server.js` (API v2 + Frontend) und
  `dashboard/worker.js` (Job-Scheduler); npm-Abhaengigkeiten nur `pg` und
  `node-cron`
- Externe Dienste: Nayax Lynx API (Verkaeufe/Geraete), Claude API (OCR,
  Vorschlaege), Google Drive (Picklisten-PDF), Resend (Mail), GitHub (Issues
  aus Monitoring)
- Tailscale Serve als Zugangsschicht (Identity-Header, Default-Deny)
- n8n Self-Hosted als Alt-System bis zum Cutover (#198)

## Start und Ausfuehrung

### Dashboard starten

```powershell
cd dashboard
npm start
```

Danach lokal erreichbar unter `http://127.0.0.1:8787/`.

### Worker starten (Stufe-6-Jobs)

```powershell
cd dashboard
node worker.js
```

In Produktion laeuft der Worker als eigener Docker-Compose-Service
(`restart: always`). Der Scheduler nutzt setInterval statt node-cron-Uhrzeiten,
weil node-cron v4 auf dem WSL2-Mini Ticks als "missed execution" verwirft.

### Konfiguration

Lokale Secrets gehoeren in `dashboard/.env.local` (in `.gitignore`, nie
committen). Die **vollstaendige, kommentierte Variablenreferenz** liegt in
`dashboard/.env.example` — u. a.:

- `DASHBOARD_V2_PG_URL` / `DASHBOARD_V2_APP_PG_URL` (Infra-/App-DB-Verbindung,
  App-Rolle mit RLS)
- `DASHBOARD_ADMIN_LOGIN` (exakte, kommaseparierte Allowlist)
- `N8N_BASE_URL` / `N8N_API_KEY` (nur noch fuer das Alt-System)
- `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `GOOGLE_DRIVE_*`
- `WF1_CUTOVER` / `WF3_CUTOVER`, `CUTOVER_STREAK_THRESHOLD`, `GITHUB_TOKEN`
- `WORKER_*`-Zeitplaene, `ANOMALY_*`-Schwellen, `EXTERNAL_FETCH_TIMEOUT_MS`

Ohne `Tailscale-User-Login`-Header ist nur Loopback (mit gesetztem
`DASHBOARD_DEV_LOCAL_ADMIN`) Admin; Tailnet-Hosts ohne Identity-Header laufen
read-only.

### Tests

```powershell
cd dashboard
node --test --test-timeout=60000 --test-force-exit
```

Die Suite (>1000 Tests) enthaelt LIVE-Tests gegen die echte DB im
Rollback-Sandbox-Harness; ohne erreichbare DB skippen sie sauber. Einzelne
LIVE-Tests koennen im Parallel-Lauf flaken — isoliert nachpruefen.

### Autostart (Windows)

```powershell
.\dashboard\register-dashboard-autostart.ps1
```

Registriert den Start ueber den Windows Task Scheduler. VBScript-Wrapper sind
bewusst verboten (Antiviren-Fehlalarme, siehe `.gitignore`).

## Projektstruktur

```text
.
|-- README.md / ARCHITECTURE.md / CLAUDE.md / HANDOVER.md
|-- HANDOVER_ARCHIVE/            # datierte alte Handover-Staende
|-- WF0 ... WF9 *.json           # n8n-Exporte der Fach-Workflows
|-- WF-PGW / WF-Monitor / WF-Val / WF-Drift-Check / WF-Update-Check /
|   WF-Claude-Proposals / WF-MatView-Refresh / WF-Nayax-Devices-Sync *.json
|-- docs/
|   |-- ROADMAP.md               # Zielarchitektur + Phasenplan
|   |-- UBIQUITOUS_LANGUAGE.md   # Glossar
|   |-- specs/                   # verifizierte SPECs je Feature/Stufe
|   |-- security/                # Runbooks (RLS-Rollback, Trust-Header, Guard-Allowlist)
|   |-- data-model/ audit/
|-- infra/                       # Deploy-/Compose-Artefakte
`-- dashboard/
    |-- server.js                # API v2 + Frontend-Auslieferung
    |-- worker.js                # Job-Scheduler (Stufe 6)
    |-- lib/                     # ~50 Module (tenant-db, auth, economics, ...)
    |   `-- jobs/                # portierte Workflows (guv-aggregate, nayax-sales, ...)
    |-- db-migrations/           # 0001-0034, idempotent, Reihenfolge = Praefix
    |-- tests/                   # node --test Suite (Unit + LIVE-Sandbox)
    |-- public/                  # v3.html/v3.js/v3.css (aktuell), index.html/app.js (alt)
    |-- scripts/ tools/ deploy/ docs/
    `-- .env.example             # kommentierte Variablenreferenz
```

## Wichtige Betriebsregeln

- `active = TRUE` bedeutet aktive Slotbelegung in einer Maschine — nicht
  Produkt-Existenz im Stamm.
- Der WF2-Pfad (Produktstamm/Chargen) darf keine aktive Slotbelegung als
  Nebenwirkung erzeugen; Slot-Historie laeuft ausschliesslich ueber den
  WF4-Pfad.
- Alle DB-Zugriffe der App laufen durch die Mandanten-Tuer
  (`dashboard/lib/tenant-db.js`); der Query-Filter-Guard macht Verstoesse
  build-rot.
- Schreibende Endpunkte verlangen Capabilities; `tenant_id` im Request-Body
  wird abgewiesen (400 + Audit).
- Preise bleiben in Nayax/Moma fuehrend; Nayax/Moma werden nicht automatisiert
  beschrieben.
- Keine echten Secrets in Workflow-JSONs oder im Repo (Platzhalter wie
  `NAYAX_TOKEN_IN_N8N_CREDENTIAL_EINTRAGEN`); Details in `CLAUDE.md`.
- `HANDOVER.md` am Sessionende aktualisieren, alte Version nach
  `HANDOVER_ARCHIVE/` archivieren.
