# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-31 (Session 24 — WF1 Dedup-Guard + Upload→Drive-Konvergenz, Task #6)

### Aktueller Stand

- **Task #6 ist fertig und live auf der HP Mini.** WF1 (`wnGAwHhgfXq2ATM8`) hat jetzt **30 Nodes** (vorher 25), aktiv, alle Bestands-Nodes intakt.
- **445/445 Dashboard-Tests grün** (`cd dashboard; npm test`).
- Produktiver Host bleibt der **HP Mini** (Dashboard + n8n laufen dort).

### Was diese Session gemacht wurde

1. **WF1 Dedup-Guard (Mini, additiv):**
   - Neue Nodes: `GS - Pruefung lesen (Dedup)` (liest `Rechnungseingang_Pruefung` parallel von „Code - erste Rechnung auswählen") und `Code - Dedup Filter` (`runOnceForAllItems`).
   - Flow: `Code - Rechnung gegen Stammdaten prüfen → [Google Drive - Rechnung verschieben (IMMER), Code - Dedup Filter]`; `Code - Dedup Filter → Google Sheets - Prüfung anhängen → [Code - WF2 Start vorbereiten, Prepare PGW]`.
   - **Move ist von Append entkoppelt** → die Datei wird auch dann aus dem Ordner verschoben, wenn **alle** Positionen Duplikate sind. **WF2 + PGW laufen nur bei neuen Vorschlägen** (Append bekommt 0 Items ⇒ läuft nicht).
   - Dedup-Key: `approval_id` (= `APP_<drive_file_id>_<line>`) primär, Fallback `invoice_id|supplier|line_number` (fängt Re-Uploads mit neuer Drive-File-ID). Das Pruefung-Sheet **hat** die Spalte `approval_id` (das Node-Schema war nur veraltet).
   - **Getestet:** 6/6 Szenarien gegen *echte* Sheet-Daten mit dem *real deployten* Filter-Code (gleiche Rechnung 2× → 0 neu; Re-Upload neue File-ID → Fallback; Teil-Duplikat → nur neue Zeilen; Neu-Rechnung → alle; leeres Sheet). Kein Schreibzugriff auf Produktion ⇒ keine Testreste.

2. **Upload→Drive-Konvergenz:**
   - Neuer self-contained Branch in WF1: `Webhook - Rechnung Upload` (POST, Pfad `wf1-rechnung-upload`, `responseMode: lastNode`) → `Code - Upload Binary normalisieren` (mappt das Multipart-File auf Binary-Key `file`) → `Google Drive - Upload Rechnungseingang` (Ordner `15_5fYaCgnR2pUFpXs6hXJRjvu1jsnS3H`, Cred `kOLyDv48afTu5P9q`). Der **bestehende Drive-Trigger** verarbeitet die Datei danach (mit Dedup). Kein Doppel-Processing.
   - Der alte GET-Webhook (Ordner-Scan-Action) bleibt **erster** Webhook im Node-Array → die „Rechnungseingang starten"-Action ist unverändert.
   - Webhook-Liveness verifiziert: POST ohne Datei ⇒ Normalisier-Guard wirft „Kein Binary…", Drive-Node wird nicht erreicht (kein Drive-Schreibzugriff im Test).
3. **Dashboard (Code, `dashboard/server.js`):**
   - `/api/v2/uploads/invoice` postet die Datei direkt an einen festen Webhook, wenn **`INVOICE_UPLOAD_WEBHOOK_URL`** gesetzt ist (gezielter Override; nur ein echter `http(s)`-Wert greift, Prozess-Env vor `.env.local`). In `dashboard/.env.local` auf `https://hp-mini-server.tail573a13.ts.net/webhook/wf1-rechnung-upload` gesetzt (gitignored).
   - `resolveV2UploadWorkflow` wählt jetzt gezielt den **POST**-Webhook (statt nur den ersten), da WF1 nun GET + POST hat. Resolution bleibt Fallback (und für Pickliste).
   - Neuer Test `INVOICE_UPLOAD_WEBHOOK_URL leitet Rechnung direkt …`; bestehender Resolution-Test neutralisiert den Override Windows-sicher (Nicht-URL-Wert = aus).
   - Doku: `dashboard/.env.example` ergänzt.
   - **Hinweis:** Dashboard zeigt n8n weiterhin auf `localhost:5678` (`.dashboard-config.json`); nur der Rechnungs-Upload geht gezielt an die Mini. Alternative (ganzes Dashboard auf Mini) wurde verworfen.

### Backups / Artefakte (homelab)

- `homelab/wf1_wnGAwHhgfXq2ATM8_backup.json` = aktueller Live-Stand (30 Nodes).
- Verlaufs-Backups: `wf1_backup_pre_dedup_20260531_125540.json` (25 Nodes, Original), `wf1_backup_pre_upload_20260531_130218.json` (27 Nodes, post-dedup).
- Lokaler Export `WF1 - Rechnungseingang automatisch mit Claude.json` aktualisiert.

### n8n-Instanz-Regel (unverändert kritisch)

- **n8n-Arbeit ausschließlich auf der HP Mini, nie lokal.** Mini-REST-API: `https://hp-mini-server.tail573a13.ts.net/api/v1/`, Header `X-N8N-API-KEY`.
- **Gültiger Mini-Key = `N8N_API_KEY` in `C:\Users\patri\Documents\homelab\.env.local`** (Mini → HTTP 200).
- **NICHT** für den Mini: `C:\Users\patri\.n8n-api-key` und `ELITEBOOK_N8N_API_KEY` (= lokal, Mini → 401). Die n8n-MCP nutzt aktuell den lokalen Key → sieht nur die lokale Instanz mit abweichenden IDs. Vor jeder Aktion Instanz/ID gegenprüfen.

### Offene / nächste Schritte

1. **Echter End-to-End-Live-Test** beim nächsten realen Rechnungseingang oder bewusst: PDF über das Dashboard hochladen → erscheint im Drive-Ordner → Drive-Trigger → WF1 verarbeitet (mit Dedup) → Datei wandert nach „Erledigt". (Wurde diese Session bewusst NICHT live gemacht, um die Produktions-Sheets/Drive sauber zu halten; Dedup-Logik + Webhook sind isoliert verifiziert.)
2. Issue #7 ([v3-G]) — Code fertig+gepusht; Ready-Kommentar + Close in dieser Session.

### Wichtige IDs / Pfade

- WF1 Prod-ID: `wnGAwHhgfXq2ATM8` (30 Nodes) · Upload-Webhook-Pfad: `wf1-rechnung-upload`
- Google-Drive-Cred: `kOLyDv48afTu5P9q` · Google-Sheets-Cred: `6GG86fWHw536Rk36`
- Rechnungseingang-Ordner: `15_5fYaCgnR2pUFpXs6hXJRjvu1jsnS3H` · Erledigt: `1pzIBzjefir5MvOXTRxVBEFBm-UZwtNAo`
- Vorschläge-Sheet `Rechnungseingang_Pruefung` (Google-Sheet `12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo`)
- Entwicklungs-Arbeitskopie: `C:\Users\patri\Documents\mein-erstes-Projekt` · Dashboard-PG via SSH-Tunnel Port 15432 (`DASHBOARD_V2_PG_URL` in `dashboard/.env.local`)
