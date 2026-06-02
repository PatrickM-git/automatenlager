# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-02 (Handy-Responsive-Fix + einklappbare Etagen im Sortiment)

### Aktueller Stand

- **v3-Dashboard ist auf dem Handy jetzt wirklich responsiv.** GuV, Bestand und Sortiment passen bei 375px ohne horizontalen Overflow; kein erzwungenes Rauszoomen mehr, die fixe Bottom-Navigation („Iconleiste") bleibt durchgehend stehen.
- **Sortiment-Etagen sind ein-/ausklappbar** (Kopfzeile mit `x / y belegt` + Pfeil). Default am Handy (<880px) **eingeklappt**, am Desktop aufgeklappt; eine ausdrückliche Nutzer-Wahl wird pro Automat+Etage in `localStorage` gemerkt und schlägt den Default.
- **Commit `3608225` (gepusht) ist auf der HP Mini live ausgerollt und live verifiziert.**
- **659/659 Dashboard-Tests grün** (`cd dashboard; npm test`).

### Was diese Session gemacht wurde

Reine Frontend-Arbeit an `dashboard/public/v3.css` + `dashboard/public/v3.js` (Vanilla-JS, v3-Tokens wiederverwendet). Verifiziert im QA-Preview (`dashboard-v3-qa`, Port 8788) bei 375px/1200px.

**Wurzelursache aller drei Handy-Symptome (Nav verschwindet, Inhalt abgeschnitten, Rauszoomen):** horizontaler Overflow. `.v3-main` ist ein Grid-Item von `.v3-shell` und hatte den Default `min-width:auto` → es schrumpfte nicht unter die min-content-Breite seines Inhalts (breite nowrap-Tabellen bei GuV/Bestand, Slot-Etagen-Grid bei Sortiment). Das Layout wurde dadurch breiter als der Viewport (gemessen 565–619px statt 375px), das Handy zoomte raus, und die `position:fixed`-Bottom-Nav rutschte weg.

1. **Zentraler Fix — `.v3-main { min-width: 0 }`:** Layout schrumpft auf Viewport-Breite; breite Tabellen scrollen stattdessen in ihrem eigenen `overflow-x:auto`-Wrapper (`.v3-guv-tablewrap`, `.v3-lager-table-wrap`). Empirisch verifiziert: alle drei Seiten danach bei 375px ohne Overflow, Bottom-Nav fix am unteren Rand.
2. **Sortiment-Layout shrinkbar:** `.v3-slots-layout` mobil `minmax(0,1fr)` statt `1fr`; `.v3-slots-stage` `min-width:0`; `.v3-slots-stage__top` `flex-wrap:wrap` (die Buttons „Automat voll auffüllen" / „Aus Nayax abgleichen" brechen um statt zu überlaufen).
3. **Einklappbare Etagen:** `.v3-slots-floor` von 2-Spalten-Grid (`64px 1fr`) auf einklappbaren Block umgebaut — tippbare Kopfzeile `.v3-slots-floor__toggle` (Label + `.v3-slots-floor__summary` Belegung + drehender `.v3-slots-floor__chev`), `[data-floor-collapsed="true"]` blendet die Slot-Reihe aus. JS: `loadCollapsedFloors`/`saveCollapsedFloors` (localStorage-Key `v3.slots.collapsedFloors`, Werte explizit `true`/`false`, Abwesenheit = Viewport-Default via `floorDefaultCollapsed()` = `matchMedia('(max-width: 879px)')`), Toggle-Handler auf `root` delegiert (übersteht Stage-Neuaufbau beim Automatenwechsel; auch für Gäste, reine Ansicht-Steuerung).

### Deploy auf die HP Mini (so läuft das Dashboard dort)

Das Dashboard läuft auf der Mini als **Docker-Container `homelab-dashboard`** (Compose-Projekt `homelab`, `C:\homelab\docker-compose.yml`). Code kommt per **Bind-Mount** `C:\homelab\projekte\automatenlager` → `/repo` (eigener git-Klon, getrennt von der Dev-Arbeitskopie); Container-Cmd `node server.js`, WorkingDir `/repo/dashboard`. Statische Assets werden direkt aus dem Mount serviert. Exponiert via Tailscale Serve: `https://hp-mini-server.tail573a13.ts.net:8787` (tailnet only, `Cache-Control: no-store`).

**Deploy = pullen + Container neu starten** (kein Image-Rebuild bei reinen Code-Änderungen):
1. SSH `patri@100.68.148.46` (Key `~/.ssh/miniserver_key`). Die Mini ist **Windows** (SSH-Default cmd verschluckt Quotes) mit **WSL `Ubuntu-24.04`** → zuverlässig nur über `powershell -NoProfile -Command "wsl.exe -d Ubuntu-24.04 bash -lc '...'"`; komplexe bash-Skripte base64-kodiert durchreichen.
2. `cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only origin main`
3. `docker restart homelab-dashboard`
4. Verifizieren: `docker exec homelab-dashboard sh -lc 'wget -q -O - http://localhost:8787/v3.css | grep -c "<marker>"'`.

Diese Session: `8f95356 → 3608225` gepullt, Container neugestartet, neue `v3.css`/`v3.js`-Marker über HTTP bestätigt (`HTTP 200`).

### Vorheriger Stand (nachgetragen, war im alten HANDOVER nicht erfasst)

- **#38 Live-Umsatz (Commit `c3f775c`, live 2026-06-02):** v3-Live-Kachel (Tagesumsatz heute + letzte Verkäufe, 30s-Auto-Refresh) + `GET /api/v2/economics/live`, liest fertige `sales_transactions` (von WF3 befüllt). Kein Späher-WF/keine Migration; stattdessen WF3-Schedule auf alle 5 Min. Lehre: aktiven WF zum Neuladen des Triggers deactivate+activate.

### n8n-Instanz-Regel (unverändert kritisch)

- **n8n-Arbeit ausschließlich auf der HP Mini, nie lokal.** Mini-REST-API: `https://hp-mini-server.tail573a13.ts.net/api/v1/`, Header `X-N8N-API-KEY`.
- **Gültiger Mini-Key = `N8N_API_KEY` in `C:\Users\patri\Documents\homelab\.env.local`** (Mini → HTTP 200).
- **NICHT** für den Mini: `C:\Users\patri\.n8n-api-key` und `ELITEBOOK_N8N_API_KEY` (= lokal, Mini → 401). Vor jeder Aktion Instanz/ID gegenprüfen.

### Offene / nächste Schritte

1. **Optionaler Live-Augenschein durch Patrick am Handy** unter `https://hp-mini-server.tail573a13.ts.net:8787` (Sortiment/GuV/Bestand) — Responsive + einklappbare Etagen mit Echtdaten.
2. Größere offene Themen unverändert: **#3 Auth-Sicherheitskonzept** (11 Issues über beide Repos, Milestone „Auth & Sicherheit v1"; nächster Schritt `start-issue` auf homelab #57), **#9 v2-Abschaltung**.
3. Offen aus früherer Session: echter End-to-End-Live-Test des WF1-Rechnungs-Uploads beim nächsten realen Rechnungseingang.

### Wichtige IDs / Pfade

- Entwicklungs-Arbeitskopie: `C:\Users\patri\Documents\mein-erstes-Projekt` (dashboard/) · Dashboard-PG via SSH-Tunnel Port 15432 (`DASHBOARD_V2_PG_URL` in `dashboard/.env.local`)
- Mini-Dashboard-Klon: `C:\homelab\projekte\automatenlager` (Bind-Mount → Container `homelab-dashboard`)
- QA-Preview lokal: `dashboard-v3-qa`, Port 8788 (`.claude/launch.json`)
- v3-Frontend: `dashboard/public/v3.{html,css,js}` · Klassifikation: `dashboard/lib/slow-mover.js` · Drift-Guard: `dashboard/lib/db-schema.js`
- WF1 Prod-ID (unverändert): `wnGAwHhgfXq2ATM8`
