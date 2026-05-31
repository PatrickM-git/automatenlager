# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-31 (Session 23 — Dashboard v3 abgeschlossen + WF1-Drive-Trigger live)

### Aktueller Stand

- **Issue #7 (Dashboard v3, Multipage) ist fertig, committet und gepusht** (`8755bdb`, `5d4cb1a`). Ready-for-Review-Kommentar auf Issue #7 gepostet. **444/444 Dashboard-Tests grün** (`cd dashboard; npm test`).
- Produktiver Host bleibt der **HP Mini** im Homelab (Dashboard + n8n laufen dort).
- **WF1-Drive-Ordner-Trigger ist live in Produktion** und getestet (feuert beim Ablegen einer Datei im Drive-Ordner „Rechnungseingang").

### Was diese Session gemacht wurde

1. **v3-Multipage-Seiten (TDD, reuse aller `/api/v2/*`):**
   - **Monitoring** (`lib/monitoring-view.js`): Gesamt-Ampel, Zähler je Zustand, kompakte SVG-Verteilung, Filter + Korrekturfälle (suggest/confirm).
   - **Automaten** (`lib/automaten-view.js`): Maschinen + Standorte verknüpft, Sprung in die Slot-Ansicht (`data-slots-stage-machine`).
   - **Onboarding** (`lib/onboarding-flow.js`): domänenkorrektes **Routing-Cockpit** — Rechnungs-Upload→WF1, WF2-Freigabe-Routing, schlanke Statuszeile (Freigabe offen / Nayax-Verknüpfung offen / Verkaufsbereit). Keine Stammdaten-Erfassung hier (gehört WF2). Hohle „Onboarding anstoßen"-Aktion (Fake-Grün ohne Webhook) entfernt.
   - **Nachfüllung** auf der Slot-Seite: „Automat voll auffüllen" (`lib/bulk-refill.js`) — bis Kapazität, **hart durch verfügbaren Lagerbestand begrenzt**, geteilt über Slots gleichen Produkts; reuse `/api/v2/refill/trigger`.
   - Regressionsfix: Slot-Stage-Sprunganker kollidierte mit Maschinen-Chips (`data-slots-machine`) → eigenes Attribut, Tap-Refill/Tausch/Drag wieder ok.
2. **Backend additiv:**
   - `.env.local`-PG-Fallback (`lib/pg-url.js`, `dashboardV2PgUrl`): liest `DASHBOARD_V2_PG_URL` jetzt auch aus `.env.local`, wenn nicht in der Prozess-Umgebung. War der Grund für „keine Zahlen / Neu versuchen".
   - Locations-`status`-Spalten-Fix + Onboarding-Orphan-Query (`product_key` → `product_name_raw`) + DB-Schema-Drift-Guard (`lib/db-schema.js`) — via Hintergrund-Tasks committet.
3. **WF1 (Mini, `wnGAwHhgfXq2ATM8`):** Node `Google Drive Trigger - Rechnungseingang` ergänzt (Event `fileCreated`, Ordner `15_5fYaCgnR2pUFpXs6hXJRjvu1jsnS3H`, Poll jede Minute, Cred `kOLyDv48afTu5P9q`) → an `Config - WF2`. Additiv, 24→25 Nodes, alle Bestands-Nodes intakt, aktiv. Mit harmloser `.txt` getestet (Trigger feuerte). Backup: `homelab/wf1_wnGAwHhgfXq2ATM8_backup.json`. Lokaler Export `WF1 - Rechnungseingang automatisch mit Claude.json` aktualisiert.
4. **DB-Bereinigung (PostgreSQL Mini via Tunnel):** 5 Dummy-Verkäufe (`product_name_raw='Unbekannt'`, `machine_id=1`, `settlement_at=2000-12-30`, transaction_id 31/33/69/70/71) + Test-Produkt `SKU_E2E_TEST` (product_id 1) entfernt — nur diese, in einer Transaktion, verifiziert.

### WICHTIG — n8n-Instanz-Regel (neu festgehalten)

- **n8n-Arbeit ausschließlich auf der HP Mini, nie lokal.** Mini-REST-API: `https://hp-mini-server.tail573a13.ts.net/api/v1/`, Header `X-N8N-API-KEY`.
- **Gültiger Mini-Key = `N8N_API_KEY` in `C:\Users\patri\Documents\homelab\.env.local`** (verifiziert: Mini → HTTP 200).
- **NICHT** für den Mini: `C:\Users\patri\.n8n-api-key` und `ELITEBOOK_N8N_API_KEY` = LOKALE Instanz (localhost:5678 → 200, Mini → 401). Die n8n-MCP nutzt aktuell den lokalen Key → sieht nur die lokale Instanz mit abweichenden IDs.
- Doku/Template: `CLAUDE.md` (n8n Workflow Notes) und `dashboard/.env.connections.example`.

### Nächste Schritte (Task #6 — neue Session)

1. **WF1 Dedup-Guard:** nach Claude-Parse `Rechnungseingang_Pruefung` lesen, bereits verarbeitete Rechnungen überspringen (`approval_id`/`invoice_id`). Sonderfall: alle Positionen Duplikate → Datei **trotzdem** aus dem Ordner verschieben; WF2 nur bei neuen Vorschlägen triggern. Muster: GET-Backup → additiv → PUT → per GET verifizieren → Doppel-Rechnung-Szenario testen.
2. **Upload→Drive-Konvergenz:** Dashboard-Upload (`/api/v2/uploads/invoice`) legt die Datei in den Drive-Ordner Rechnungseingang (statt GET-Webhook, der nur einen Ordner-Scan auslöst) → derselbe Drive-Trigger verarbeitet sie.

### Wichtige IDs / Pfade

- WF1 Prod-ID: `wnGAwHhgfXq2ATM8` · WF2: `wGDkVMoPN2Ed88TO`
- Google-Drive-Cred: `kOLyDv48afTu5P9q` („Google Drive account")
- Rechnungseingang-Ordner: `15_5fYaCgnR2pUFpXs6hXJRjvu1jsnS3H` · Erledigt: `1pzIBzjefir5MvOXTRxVBEFBm-UZwtNAo`
- Vorschläge-Sheet `Rechnungseingang_Pruefung` (Google-Sheet `12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo`)
- Entwicklungs-Arbeitskopie: `C:\Users\patri\Documents\mein-erstes-Projekt` · Dashboard-PG via SSH-Tunnel Port 15432 (`DASHBOARD_V2_PG_URL` in `dashboard/.env.local`)
