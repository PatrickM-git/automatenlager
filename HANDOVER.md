# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-31 (Session 25 — Slow-Mover-Klassifikation in den Datenpfad eingeklinkt, Issue v3-H/#8)

### Aktueller Stand

- **Drehzahl-/Slow-Mover-Klassifikation ist jetzt serverseitig in den Datenpfad eingeklinkt** und im v3-Frontend sichtbar (Badges + Filter). Issue v3-H/#8 ist damit funktional fertig.
- **476/476 Dashboard-Tests grün** (`cd dashboard; npm test`).
- **Live verifiziert gegen die echte Produktions-DB** (SSH-Tunnel Port 15432): API liefert `turnover_class` für alle 40 realen Slots, Drift-Guard lief live durch und ist grün.
- Produktiver Host bleibt der **HP Mini** (Dashboard + n8n laufen dort). Diese Session war reine Dashboard-Code-Arbeit (kein n8n).

### Was diese Session gemacht wurde

Vorarbeit war bereits committet (`fbd9cf6` Klassifikationsmodul + `/einstellungen` + Glossar, `7ce0aa4` Einstellungen-Icon). Diese Session hat die **Verdrahtung** ergänzt:

1. **Server-Datenpfad — `lib/assortment-slots.js` ist die kanonische, populationsweite Klassifikationsquelle:**
   - Neue `last_sale`-CTE: `MAX(settlement_at)` je `machine_id+mdb_code` aus `automatenlager.sales_transactions` (`source != 'historic_backfill'`, identisch zur `v_slot_turnover`-Semantik) → neue Spalte `days_since_last_sale` (Tage seit letztem echten Verkauf, NULL = nie verkauft).
   - `parseSlotRow` reicht `daysSinceLastSale` durch — **null bleibt null** (nicht 0, sonst kippt die Ladenhüter-Regel).
   - `buildAssortmentSlotsData` wendet `classifyTurnover` (aus `lib/slow-mover.js`) auf die Slot-Liste an → jeder Slot trägt `turnover_class` ∈ {renner, normal, langsam_dreher, ladenhueter} im API-Result. Quartile werden über die gezeigte (ggf. gefilterte) Slot-Population gebildet.
   - `lib/lager.js` (`buildLagerData`): `turnover_class`-Passthrough additiv neben `slow_mover_class`.

2. **Frontend (`public/v3.js` + `public/v3.css`, Vanilla-JS, v3-Tokens wiederverwendet):**
   - Gemeinsamer `turnoverBadge()`-Helfer; **Lager-Karten** zeigen jetzt das Klassen-Badge `v3-badge--turnover-<key>` statt des generischen „Slow-Mover". „normal" bleibt bewusst ohne Badge (Grundzustand), ist aber filterbar.
   - **Slot-Zellen** tragen `data-slot-turnover` + ein kompaktes Klassen-Badge (`.v3-slot__turnover`).
   - **Drehzahl-Filter (User Story 37)** auf beiden Seiten: Lager (Chip-Gruppe in der Filterleiste, wertet `filters.turnover_class` aus), Slots (Chips setzen `data-turnover-filter` auf den beim Automatenwechsel bestehenbleibenden `[data-slots-stagewrap]`; CSS dimmt Nicht-Treffer auf Opacity 0.26).
   - **`/lager` joint die Klasse client-seitig** per `(machine_id, mdb_code)` aus `/api/v2/assortment-slots` (zusätzlicher Fetch, `.catch` → graceful ohne Badge). Bewusste Entscheidung: Quartile müssen über **alle aktiven Slots** gebildet werden, nicht über die gefilterte MHD-Teilmenge → eine einzige Klassifikationsquelle, garantiert konsistent zwischen `/slots` und `/lager`, keine doppelte Quartil-Logik.

3. **Tests:** `AC-T1..T5` (Klassifikation/`daysSinceLastSale` im API-Result), `AC-L7c/d` (Lager-Passthrough), neue Datei `dashboard-v3-turnover-badges.test.js` (`AC-TB1..TB8`: Badge-/Filter-Verdrahtung in v3.js + v3.css).

### Live-Verifikation (echte DB, read-only)

- API `/api/v2/assortment-slots`: 40 Slots klassifiziert (renner 15 · langsam_dreher 15 · normal 8 · ladenhüter 2); nie verkauft → ladenhüter, 25 Verk./2 Tage → renner, 2 Verk./24 Tage → langsam_dreher.
- Slots-Seite: farbige Klassen-Badges in den Zellen; Filter „Ladenhüter" dimmt Nicht-Treffer, „Alle" setzt zurück.
- Lager-Seite: Join trifft beide MHD-Karten (beide `normal` → ohne Badge); Filter `renner`→0 (+Leerzustand), `normal`→2, `Alle`→2.
- **Drift-Guard lief live (nicht übersprungen) und ist grün** — neue `sales_transactions`-Spaltenrefs (`machine_id/mdb_code/settlement_at/source`) gegen reales `automatenlager`-Schema verifiziert.

### n8n-Instanz-Regel (unverändert kritisch)

- **n8n-Arbeit ausschließlich auf der HP Mini, nie lokal.** Mini-REST-API: `https://hp-mini-server.tail573a13.ts.net/api/v1/`, Header `X-N8N-API-KEY`.
- **Gültiger Mini-Key = `N8N_API_KEY` in `C:\Users\patri\Documents\homelab\.env.local`** (Mini → HTTP 200).
- **NICHT** für den Mini: `C:\Users\patri\.n8n-api-key` und `ELITEBOOK_N8N_API_KEY` (= lokal, Mini → 401). Vor jeder Aktion Instanz/ID gegenprüfen.

### Offene / nächste Schritte

1. **Issue v3-H/#8 schließen** (Ready-Kommentar + Close), Klassifikation ist verdrahtet, getestet und live verifiziert.
2. **Optionaler Live-Augenschein durch Patrick** in der QA-Preview (`dashboard-v3-qa`, Port 8788, `/v3/slots` + `/v3/lager`) — Badges/Filter mit Echtdaten.
3. Offen aus Session 24: echter End-to-End-Live-Test des WF1-Rechnungs-Uploads beim nächsten realen Rechnungseingang.

### Wichtige IDs / Pfade

- Entwicklungs-Arbeitskopie: `C:\Users\patri\Documents\mein-erstes-Projekt` (dashboard/) · Dashboard-PG via SSH-Tunnel Port 15432 (`DASHBOARD_V2_PG_URL` in `dashboard/.env.local`)
- Klassifikation: `dashboard/lib/slow-mover.js` (`classifyTurnover`, Deep Module, rein/testbar) · Definitionen: `GET /api/v2/settings/definitions` + `docs/UBIQUITOUS_LANGUAGE.md`
- Drehzahl-Recency-Quelle: `automatenlager.sales_transactions` (`settlement_at`), Drehzahl: `automatenlager.v_slot_turnover` · Drift-Guard: `dashboard/lib/db-schema.js`
- WF1 Prod-ID (unverändert): `wnGAwHhgfXq2ATM8` (30 Nodes)
