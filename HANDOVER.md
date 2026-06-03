# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-03 (GuV-Seite: KW-Auswahl, taggenauer Zeitraum, Live-FIFO-GuV, Balkencharts, fehlende EK sichtbar, Jahr/Quartal-Fix)

Iterative UX-/Korrektheits-Session an der **GuV-Seite (v3, `/guv`)**. Alles **live auf der HP Mini** (`84cdbef`) und über PRs dokumentiert. Vorheriger Stand (SQL-Migration #39/#41/#40/#60, Bestands-Rekonstruktion, Automaten-Verwaltung) siehe `HANDOVER_ARCHIVE/HANDOVER_2026-06-02_sql-migration-automaten.md`.

### Was diese Session gemacht wurde

**1. GuV-Funktionsausbau (PR #49)**
- **Wochen-/KW-Auswahl:** neuer Tab „Woche" mit scrollbarem KW-Dropdown (ISO-Kalenderwochen, aktuelle Woche vorausgewählt), taggenaue Auswertung. Reihenfolge: Woche · Monat · Quartal · Jahr · Eigener.
- **Eigener Zeitraum wieder taggenau** (`type="date"` von/bis) statt Monatsauswahl.
- **Echte GuV/Marge inkl. heute:** noch nicht von WF8 aggregierte Verkäufe werden **sequenziell FIFO** gegen `stock_batches.unit_cost_net` bewertet (wie WF8 nachts). Empirisch bestätigt: `guv_daily.cost_of_goods = Menge × unit_cost_net` (netto-Basis). Neue Lib-Funktionen `resolveDateRange`/`fifoProvisionalCostForProduct` in `dashboard/lib/economics.js`; `queryEconomicsPg` filtert taggenau auf `posting_date`; `queryEconomicsProvisionalPg` liefert per-Produkt-FIFO.
- **Tages-Balkencharts** (`renderBarChartSvg`): im Tagesmodus Balken über ALLE Tage des Zeitraums (X-Achse vorgegeben), runde Y-Gitterlinien, Hover-Werte; einzelner Tag = ein Balken (statt sinnlosem Ein-Punkt-Linienchart). Mehrmonatsansicht bleibt Linien-Trend.
- **Layout:** Tabs + aktives Feld auf einer Linie, Automat-Filter in eigener Zeile (Trennlinie); Handy: gleichmäßig verteilte Tabs ohne Überstehen.

**2. Fehlende Einkaufspreise SICHTBAR machen statt schätzen (PR #52)**
- **User-Vorgabe: EK NIEMALS schätzen.** Der EK kommt ausschließlich aus der gescannten Rechnung (`stock_batches.unit_cost_net`). Ein kurzzeitig eingebauter „letzter-bekannter-EK"-Fallback wurde wieder **entfernt**.
- Fehlt der EK einer Charge (`unit_cost_net<=0`), wird die Position als `missingCost` markiert, **kein** erfundener Gewinn: GuV/Marge nur aus Posten mit bekanntem EK (Marge-Nenner `revenue_gross_costable`), Tabelle zeigt Marge „–", KPI-Hinweis „EK fehlt".
- **Warnbanner** auf der GuV-Seite listet aktive Lagerchargen ohne EK (`missingCostBatches` aus `queryEconomicsPg`: Produkt + `batch_key`), damit der User den EK nachträgt. Sobald EK vollständig → Banner/„–" verschwinden automatisch.
- Wurzelursache (4 Chargen mit `unit_cost_net=0` durch Sheet→SQL-Sync-Loch) wurde **parallel in anderem Chat in SQL gefüllt** → live aktuell keine fehlenden EK.

**3. Jahr/Quartal-Aggregations-Bug gefixt (PR #53)**
- Regression aus PR #49: `mergeProvisionalProducts` baute eine Map je `product_id` über die `byProduct`-Zeilen; in Mehrmonatsansichten liefert die DB je Produkt **mehrere** Zeilen (eine pro Monat) → Map überschrieb sie, nur ein Monat blieb (z. B. „Ferrero Duplo Chocnut" Jahr 2026 zeigte **1** statt **7**).
- Fix: `byProduct` vor dem Provisional-Merge je Produkt über den Zeitraum **aggregieren** (`aggregateByProduct`). Behebt Tabelle + CSV-Export; Zeitreihe unberührt (Bucket-Serie). Client `guvTopProducts` trägt das `cost_missing`-Flag durch die Aggregation.
- **Wichtig:** „Ferrero Duplo Chocnut" und „Duplo original" sind **zwei verschiedene Produkte** (eigene `product_id`) und dürfen NICHT zusammengeführt werden — die Aggregation summiert nur gleiche `product_id` über Monate, nie zwei Produkte.

### Tests / Verifizierung
- Suite **717/717 grün**. Neue Tests: `dashboard/tests/dashboard-guv-week-fifo.test.js` (FIFO, missingCost, ISO-KW, taggenaue Ranges, Mehrmonats-Aggregation, Banner-UI).
- Live auf dem Mini verifiziert: KPIs „inkl. heute", Balkencharts, Margen (Red Bull 26 %, Snickers 52 %), Jahr „Ferrero Duplo Chocnut" = 7 (Mai = 3).

### LEHREN
- **Dev-Server (`node server.js`) lädt geänderte `require`-Module NICHT neu** → nach Backend-Edits Container/Server neu starten, sonst verifiziert man stale Code (kostete diese Session einmal eine Fehl-Verifikation).
- **`byProduct` ist pro (product_id, month) granular** — beim Einmischen/Verdichten erst je Produkt aggregieren, dann mergen (sonst Jahr/Quartal-Verlust).
- **Margen niemals raten:** fehlende EK ehrlich als „–" zeigen + Warnbanner, nie mit Schätzwert kaschieren.

### Offene Punkte / nächste Schritte
- EK-Datenlücke in `stock_batches` (Sheet→SQL-Sync von `unit_cost_net`): in anderem Chat gefüllt; perspektivisch ein Guard/Validierung, der Chargen ohne EK früh markiert (das GuV-Banner deckt die Anzeige bereits ab).
- Offene Issues unverändert: #9 v2-Abschaltung, Auth-Konzept-Issues (automatenlager #27–#34 + homelab #57–#59).

## Deploy auf die HP Mini (so läuft das Dashboard dort)

Docker-Container `homelab-dashboard` (Compose `C:\homelab\docker-compose.yml`), Code per **Bind-Mount** `C:\homelab\projekte\automatenlager` → `/repo`, Cmd `node server.js`, WorkingDir `/repo/dashboard`. **Deploy = pullen + Restart** (kein Rebuild bei Code-Änderungen):
1. SSH `patri@100.68.148.46` (Key `~/.ssh/miniserver_key`). Mini ist **Windows + WSL Ubuntu-24.04** → Befehle per `wsl -d Ubuntu-24.04 bash -lc "…"`; verschachteltes Quoting via base64-Kette (`echo <b64> | base64 -d | bash`).
2. `cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard`.
- Diese Session live: HEAD `84cdbef`. n8n-Deploys per `PUT /api/v1/workflows/{id}`.

## Referenz / Pfade

- Dev-Arbeitskopie: `C:\Users\patri\Documents\mein-erstes-Projekt` · Dashboard-PG via SSH-Tunnel Port 15432 (`DASHBOARD_V2_PG_URL` in `dashboard/.env.local`)
- Mini-Dashboard-Klon: `C:\homelab\projekte\automatenlager` (Bind-Mount → `homelab-dashboard`)
- QA-Preview lokal: `dashboard-v3-qa`, Port 8788 (`.claude/launch.json`)
- WF-IDs Mini: WF3 `wbOhFKXQqBpJWB1w` · WF5 `3ceKeNWmdj455Tcr` · WF-Nayax-Devices-Sync `EaVcB3REMttuKZPa` · WF-PGW `Sajezv8tJll0CLIv`
- Migrationen (homelab): `infra/postgres/migrations/` — `0011` (Trigger), `0023` (nayax_devices)

## WF7 Nachfuellung Webhook

URL: `http://127.0.0.1:5678/webhook/nachfuellung`
Params: `product_key` (Pflicht), `qty` (Optional), `notes` (Optional)
Aktionen: Slot-Update + Warning-Resolve + Audit-Eintrag
