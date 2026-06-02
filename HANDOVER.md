# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-02 (SQL-Migration #39/#41/#40/#60 + Bestands-Rekonstruktion + Automaten-Verwaltung)

Große Session, alles **live auf der HP Mini** und über PRs/Issues dokumentiert. Frühere 2026-06-02-Stränge (Live-Umsatz #38, Handy-Responsive + einklappbare Etagen) siehe `HANDOVER_ARCHIVE/HANDOVER_2026-06-02_responsive.md`.

### Was diese Session gemacht wurde

**1. SQL-only-Migration (PRs automatenlager #42/#43, homelab #61; Issues #39/#40/#41/#60 geschlossen)**
- **#39 WF3 + #41 WF5 lesen jetzt aus Postgres** statt Google Sheets (behebt UNKNOWN_PRODUCT-Drift bzw. veraltete „MHD abgelaufen"-Meldungen). Live-Swap auf Mini-WF3 `wbOhFKXQqBpJWB1w` / WF5 `3ceKeNWmdj455Tcr`: je **ein** Postgres-Node, dessen **SQL das Sheet-Schema direkt per Aliasing** liefert (kein JS-Map-Node). Verträge: `dashboard/lib/wf3-product-reads.js` + `wf5-stock-reads.js`. Per `n8n execute` validiert. **LEHRE:** WF3-Node beim In-place-Swap NICHT umbenennen (FIFO-Code liest ihn per `$('Google Sheets - Produkte lesen')`).
- **#40 GuV laufender Tag (Option A):** `buildEconomicsData` → `provisional` + `totalsWithProvisional`; `queryEconomicsProvisionalPg` summiert nicht-aggregierte `sales_transactions` (gap-aware ab letztem guv_daily-Tag). v3-KPI zeigt „inkl. heute (vorläufig)", Marge bleibt endgültig.
- **#60 (homelab) remaining_qty-Abbuchpfad — Migration `0011_stock_movement_apply_trigger.sql` LIVE:** AFTER-INSERT-Trigger `apply_stock_movement()` wendet `quantity_delta_total` auf `stock_batches.remaining_qty` an (status='leer' bei 0; 'ausgesondert' geschützt). WF3 sendet die Bewegungen bereits zuverlässig; es fehlte nur die Anwendung.

**2. Bestands-Rekonstruktion (user-bestätigt, ohne physische Zählung)**
- Aus dem WF3-FIFO-gepflegten Google-Sheet `remaining_qty` rekonstruiert. 29 Chargen korrigiert: **−98 Stück Phantom**, **Haribo Goldbären 7→28** (war zu niedrig), **Red Bull Spring →1** (physisch bestätigt). Write-offs (Nick Nacks/Twix salted/Duplo) geschützt. Backup: `C:/tmp/backup_stock_reconcile_20260602.json`. Verfügbarer Gesamtbestand 915→**817**. Trigger hält es ab jetzt automatisch aktuell.

**3. Automaten-Verwaltung v3 (PRs #44/#45/#46/#47 automatenlager, #63 homelab)**
- **Anlegen:** „+ Neuer Standort" (`POST /api/v2/locations`) + „+ Neuer Automat" (`POST /api/v2/machines`, `lib/machine-create.js`: schreibt machines + machine_profiles idempotent; Standort-Pflicht-Dropdown). Formulare **standardmäßig eingeklappt** (`[hidden]`-CSS-Fix), Platz sparend.
- **Standort löschen** (`DELETE /api/v2/locations`): nur bei 0 Automaten (FK-Guard), sonst Hinweis.
- **Automat aussondern** (`POST /api/v2/machines/active`): Soft-Delete `machines.active=false` (Historie bleibt — 332 sales-FK), eingeklappte „Ausgesonderte"-Sektion mit Reaktivieren.
- **Nayax-Geräte-Combobox** (DB-Spiegel, Vercel+Supabase-ready): Migration `0023_nayax_devices`, `lib/nayax-devices.js`, `GET /api/v2/nayax-devices`, natives `<datalist>` (leer→Freitext). Sync = **WF-Nayax-Devices-Sync** (Mini-ID `EaVcB3REMttuKZPa`, aktiv, tägl. 04:20): `GET https://lynx.nayax.com/operational/v1/machines` → Postgres-Upsert. LEHRE: Nayax `/machines` liefert ein Array → n8n splittet in Items → Code-Node `$input.all()`.
- **Bugfix:** „Ohne Standort" trotz Verknüpfung war ein Anzeige-Bug (location.machine_ids bigint vs. machine_profiles.machine_id = machine_key) → `array_agg(m.machine_key)`.

**Tests:** 680/680 (`cd dashboard; npm test`). Repo↔Mini synchron (WF-JSONs exportiert).

### Deploy auf die HP Mini (so läuft das Dashboard dort)

Docker-Container `homelab-dashboard` (Compose `C:\homelab\docker-compose.yml`), Code per **Bind-Mount** `C:\homelab\projekte\automatenlager` → `/repo`, Cmd `node server.js`, WorkingDir `/repo/dashboard`. **Deploy = pullen + Restart** (kein Rebuild bei Code-Änderungen):
1. SSH `patri@100.68.148.46` (Key `~/.ssh/miniserver_key`). Mini ist **Windows + WSL Ubuntu-24.04** → Skripte per scp nach `C:/Windows/Temp/` + `wsl -d Ubuntu-24.04 bash <script>`.
2. `cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard`.
- Diese Session live: HEAD `723652e`. n8n-Deploys per `PUT /api/v1/workflows/{id}` (Basis = Execution-`workflowData`, settings-Whitelist), validiert mit `docker exec ... n8n execute --id`.

### n8n-Instanz-Regel (unverändert kritisch)

- **Nur auf der HP Mini, nie lokal.** REST: `https://hp-mini-server.tail573a13.ts.net/api/v1/`, Header `X-N8N-API-KEY`.
- **Gültiger Mini-Key (bis ~2026-06-19) = `N8N_API_KEY` in `C:\Users\patri\Documents\homelab\.env.local`** (funktioniert über die Tailscale-FQDN). **NICHT** `C:\Users\patri\.n8n-api-key` (abgelaufen, 401). Der n8n-MCP zeigt auf die **lokale** Instanz — nicht zum Deployen.

### Offene / nächste Schritte

1. **Bestands-Rekonstruktion stichprobenartig gegenchecken**, wenn Patrick am Lager ist (Trigger hält ab jetzt automatisch).
2. **homelab #62** (offen): WF-Drift-Check um „WF3 hat PGW-stock_movement-Node" erweitern (Robustheit, kein Blocker).
3. Große offene Themen: **Auth-Sicherheitskonzept** (11 Issues über beide Repos, nächster Schritt `start-issue` auf homelab #57), **#9 v2-Abschaltung**.
4. **Nayax-Combobox** zeigt aktuell Freitext (nur 1 Nayax-Gerät, schon angelegt) — füllt sich automatisch, sobald weitere Automaten dazukommen.
5. Perspektive: Umzug auf **Vercel + Supabase** — Read-Pfade sind reine DB-Abfragen (portabel), nur Sync-Jobs (n8n) müssten nach Supabase-Cron wandern.

### Wichtige IDs / Pfade

- Dev-Arbeitskopie: `C:\Users\patri\Documents\mein-erstes-Projekt` · Dashboard-PG via SSH-Tunnel Port 15432 (`DASHBOARD_V2_PG_URL` in `dashboard/.env.local`)
- Mini-Dashboard-Klon: `C:\homelab\projekte\automatenlager` (Bind-Mount → `homelab-dashboard`)
- QA-Preview lokal: `dashboard-v3-qa`, Port 8788 (`.claude/launch.json`)
- WF-IDs Mini: WF3 `wbOhFKXQqBpJWB1w` · WF5 `3ceKeNWmdj455Tcr` · WF-Nayax-Devices-Sync `EaVcB3REMttuKZPa` · WF-PGW `Sajezv8tJll0CLIv`
- Migrationen (homelab): `infra/postgres/migrations/` — neu: `0011` (Trigger), `0023` (nayax_devices)
