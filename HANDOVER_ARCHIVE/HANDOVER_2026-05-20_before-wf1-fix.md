# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-19 (Session 14 – WF5 Email-Dedup-Fix)

### Diese Session

1. **WF5 Duplikat-Warnungen in E-Mail behoben**:
   - Problem: LOW_BATCH-Warnungen für dasselbe Produkt erschienen doppelt in "Sonstige Hinweise" (z.B. Red Bull, Snickers, Erdnüsse, Cola Zero, Capri Sun)
   - Ursache: `Code - Email Zusammenfassung erstellen` kombiniert Alerts aus zwei Pfaden (Code-MHD frische Alerts + Code-Offene-Hinweise Sheet-Einträge) ohne Cross-Pfad-Dedup
   - Fix: `// PATCH EMAIL_DEDUP` in `Code - Email Zusammenfassung erstellen` eingefügt — dedup nach `type::product_key`, bevorzugt Eintrag mit MDB-Code
   - Patch-Script: `guv_check_tmp/patch_wf5_email_dedup.js`
   - Lokales JSON aktualisiert: `WF5 - MHD und niedrige Lagercharge ueberwachen.json`

---

## Stand: 2026-05-18 (Session 13 – WF7/WF8/WF9 JSON-Export aktualisiert)

### Diese Session

1. **WF7/WF8/WF9 JSON-Exporte aktualisiert** (Vorbereitung Miniserver-Migration):
   - `WF7 - Nachfuellung melden.json` → Stand 2026-05-13 (13 Nodes)
   - `WF8 - GuV Tagesposten Aggregator.json` → Stand 2026-05-15 (8 Nodes) — war veraltet (2026-05-12)
   - `WF9 - Pickliste verarbeiten.json` → Stand 2026-05-18 (23 Nodes)
   - Alle WF1–WF9 haben jetzt aktuelle JSON-Exporte im Projektordner ✅

---

## Stand: 2026-05-18 (Session 11+12 – Historischer Abgleich + GuV-Backfill abgeschlossen)

### Diese Session

1. **Duplo MHD-Bereinigung**: Status → `abgelaufen` gesetzt (MHD 2026-05-18 erreicht).
   - Physische Entnahme durch User geplant: 2026-05-19
   - Duplo bleibt im Sheet bis User die Checkliste manuell einträgt (s.u.)

2. **Historischer Abgleich abgeschlossen (manuell verifiziert)**:
   - 43 `INSUFFICIENT_BATCH_STOCK`-Einträge in `Verarbeitete_Transaktionen` analysiert
   - Diese sind **kein Fehler** — Artefakt des Cutover-Prozesses (Bestandsaufnahme 02.05. hatte Vorverkäufe bereits eingerechnet)
   - User hat alle Werte physisch nachgezählt und alle Rechnungen hochgeladen
   - **Google Sheets ist verifizierte Single Point of Truth** — keine Script-Korrekturen nötig/erlaubt
   - Wichtige Korrekturen durch User: Snickers initial_qty 77→17 (Handschrift-Lesefehler korrigiert), Falcone Nussnougat remaining=19 ✅, Red Bull remaining=4 ✅

3. **Pick Up vorbereitet**: Produkt existiert (SKU_PICK_UP, Zeile 49 Produkte, Zeile 43 Lagerchargen, 22 Stück, MHD Sep 2026). Checkliste für manuelle Eintragung erstellt.

4. **M&M's MDB 64 aufgelöst**: Alias "M&M's" → SKU_M_AND_M_CRISPY in Produkt_Aliase eingetragen. VT-Eintrag 6751983710 als MANUALLY_RESOLVED markiert. WF4-Mapping für zukünftige Transaktionen bereit.

5. **GuV historisches Backfill abgeschlossen** ✅:
   - Quelle: `_nayax_sales.json` (alle 491 Transaktionen, Okt 2025 – Mai 10, 2026)
   - 397 neue Einträge in `GuV_Tagesposten` geschrieben (Batches via n8n)
   - Umsatz: **€710,30** | GuV: **€376,35** für den historischen Zeitraum
   - Dedup-Mechanismus (date|machine_id|product_key) verhindert Doppler mit WF8
   - WF8 läuft ab Mai 11 täglich weiter, keine Konflikte
   - Backfill-Script: `guv_check_tmp/guv_historic_backfill.js` (idempotent, nochmals ausführbar)
   - **Dashboard zeigt jetzt GuV ab Okt 2025** — Zeitraum "Gesamt" auswählen

---

### Offene User-Aktionen (morgen, 2026-05-19)

**Pick Up in Automat einsetzen + Google Sheets manuell befüllen:**

| Sheet | Zeile | Feld | Wert |
|---|---|---|---|
| Produkte | 49 | `mdb_code` | 10 |
| Produkte | 49 | `active` | TRUE |
| Produkte | 49 | `replenishment_status` | aktiv |
| Produkte | 49 | `sale_price_eur` | (nach Preisangabe) |
| Produkte | 49 | `target_stock` | 12 |
| Produkte | 49 | `machine_capacity` | 12 |
| Produkte | 49 | `current_machine_qty` | (wie viele eingelegt) |
| Produkte | 49 | `valid_from` | 2026-05-19 |
| Lagerchargen | 43 | `status` | aktiv |
| Lagerchargen | 2 (Duplo) | `status` | ausgesondert |
| Lagerchargen | 2 (Duplo) | `remaining_qty` | 0 |
| Produkte | 2 (Duplo) | `active` | FALSE |
| Produkte | 2 (Duplo) | `current_machine_qty` | 0 |

---

### Offene technische Punkte

**MHD-nahe Produkte (in den nächsten 2 Wochen):**
- Nick Nacks: MHD 2026-05-27 (9 Tage), remaining=22, in_machine=5 → Neueinkauf planen
- Twix Salted Caramel: MHD 2026-05-31 (13 Tage), remaining=16, in_machine=13 → Neueinkauf planen

**WF3 läuft korrekt** — INSUFF-Einträge aus Catchup sind bekannte historische Artefakte, kein Handlungsbedarf.

**GuV Dashboard**: Zeitraum "Gesamt" oder "Jahr" wählen, um historische Daten ab Okt 2025 zu sehen.

---

### Wichtige Grundsätze (unveränderlich)

- **Google Sheets = Single Point of Truth** — Scripts dürfen `remaining_qty`/`initial_qty` nur mit expliziter User-Freigabe ändern
- **INSUFFICIENT_BATCH_STOCK** in `Verarbeitete_Transaktionen` = historisches Artefakt, kein Bug
- Neue Verkäufe: WF3 bucht korrekt ab (Status OK)
- Neue Einkäufe: WF1 → WF2 → Lagercharge anlegen

---

## Workflows (Übersicht)

| WF | ID | Status | Beschreibung |
|---|---|---|---|
| WF1 | — | aktiv | Rechnungseingang mit Claude |
| WF2 | — | aktiv | Smart Product Selection, Freigabe |
| WF3 | 2PFfPf0sVmMW7Fpp | aktiv | Nayax FIFO Lagerbestand (manueller Abruf) |
| WF4 | — | aktiv | MDB Produktzuordnung |
| WF5 | A1TQ7CnHXonafVIv | aktiv | MHD + niedrige Lagercharge (tägl. 07:00) |
| WF6 | 5ODAKv8R4Qahh1Ce | inaktiv | Produktstatus neu berechnen (alt) |
| WF7 | nla63DjpTgJrFXDj | aktiv | Nachfüllung melden (Webhook GET) |
| WF8 | qwpQMhZqDAIs8Wi9 | aktiv | GuV Tagesposten Aggregator (tägl. 02:00) |
| WF9 | UtXagT58XYNwxUM5 | aktiv | Pickliste verarbeiten (Drive PDF → Batch-Refill) |

---

## Wichtige IDs und Pfade

| Was | Wert |
|---|---|
| Google Sheet ID | `12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo` |
| Google Sheets Credential ID | `5XfHt3SzjHCj8B5H` |
| Google Drive Credential ID | `UcOBo2UdCzAv1SBG` |
| Maschinen-ID (Nayax Haupt) | `457107528` |
| Nayax Maschinenname | CR-FCRvMMfAiraF |
| WF3 ID | `2PFfPf0sVmMW7Fpp` |
| WF5 ID | `A1TQ7CnHXonafVIv` |
| WF7 ID | `nla63DjpTgJrFXDj` |
| WF8 ID | `qwpQMhZqDAIs8Wi9` |
| WF9 ID | `UtXagT58XYNwxUM5` |
| WF9 Webhook-Path | `pickliste-verarbeiten` |
| WF9 Pickliste-Ordner (unbearbeitet) | `1Djrp-44NtazCB3pa-07S-uK769gJ2ZcS` |
| WF9 Pickliste-Ordner (archiviert) | `1mOMTE-vTAKFqOO5DW_q9UQ1Hgd7MHV38` |
| Dashboard | `http://127.0.0.1:8787/` |
| GuV-Endpoint | `http://127.0.0.1:8787/api/guv` |
| n8n | `http://127.0.0.1:5678/` |
| Projekt-Root | `C:/Users/patri/Documents/mein-erstes-Projekt/` |

---

## Nayax-Endpoint-Status

Nur `/operational/v1/machines/{id}/lastSales` → 200. Alle anderen → 404.
Auto-Refill-Inferenz in WF3 ist der einzige Mechanismus.

---

## Modell-Semantik (unveränderlich)

- `Lagercharge.remaining_qty` = TOTAL physisch (Slot + Backstock)
- `Produkte.current_machine_qty` = nur Slot (Subset)
- Slot-Updates → Lager bleibt unverändert
- Verkauf → beide reduziert
- WF9-Refill → nur `current_machine_qty` erhöht, `remaining_qty` unverändert

---

## Cutover-Kontext (historisch, für WF3-Verständnis)

- Cutover: `2026-05-02T10:00:00Z` (12:00 Uhr MESZ)
- Bestandsaufnahme am 02.05. hat Vorverkäufe bereits eingerechnet
- `SKIPPED_BEFORE_CUTOVER` und `INSUFFICIENT_BATCH_STOCK` im Catchup = erwartetes Verhalten, kein Fehler
- Ab Cutover laufen alle WF3-Buchungen korrekt als `OK`
