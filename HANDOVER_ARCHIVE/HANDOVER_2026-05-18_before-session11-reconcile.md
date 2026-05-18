# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-18 (Session 10 – WF9 Pickliste produktiv)

### Diese Session: WF9 vollständig getestet und produktiv

WF9 (Pickliste verarbeiten) ist jetzt vollständig funktionsfähig und getestet.

#### Bugfixes in WF9 (Code - Pickliste verarbeiten)

**Bug 1: `c.active` → `c.status`**
Die Lagerchargen-Tabelle hat die Spalte `status` (Wert: `"aktiv"`), nicht `active`.
WF9-Code prüfte `c.active` → immer `undefined` → alle Chargen übersprungen → `remainingByKey` leer → alles gecappt auf 0.

**Bug 2: Fill-Berechnung falsch**
Alt: `effective = min(pickQty, totalRemaining)` — nutzte Gesamtlager statt Backstock.
Fix: `effectiveFill = min(pickQty, remaining - currentInMachine)` — nur Backstock zählt.
Neues Slot-Qty: `currentInMachine + fillThisSlot` (additiv, nicht absolut).

**Bug 3: Apostroph-Normalisierung**
Claude liest Apostrophe aus PDFs inkonsistent (U+00B4, U+0027, U+2018, U+2019).
Fix in `clean()`: `.replace(/´|`|'|'/g, "'")` — alle Varianten → U+0027.

**Bug 4: Webhook responseMode**
WF9 Webhook-Node hatte `responseMode: "lastNode"` aber zwei `Respond to Webhook`-Nodes → Error.
Fix: `responseMode` auf `"responseNode"` geändert.

#### Testergebnis (Pickliste vom 13.05.2026)

20/20 Produktnamen erkannt. Caps korrekt angewendet:
- Snickers: pick=9 → gecappt auf 1 (backstock=1) ✅
- Red Bull: pick=3 → gecappt auf 2 (backstock=2) ✅
- Duplo: pick=2 → gecappt auf 0 (backstock=0) ✅
- Cola Zero, Capri Sun, Falcone Nussnougat: 0 (backstock=0) ✅

#### Produkte-Sheet: machine_id pro Produkt

Jedes Produkt im Produkte-Sheet hat eine andere `machine_id` (457107528–457107575).
Das ist **normal** — Nayax vergibt pro Slot eine eigene ID. Kein Datenfehler.
WF3-Transaktionen laufen alle unter Haupt-ID `457107528`.

---

### Aktueller WF9-Betrieb

WF9 ist **aktiv**. Zwei Trigger:
1. **Google Drive Trigger** (pollt alle 60s): erkennt neue Dateien im Ordner „Pickliste unbearbeitet" (`1Djrp-44NtazCB3pa-07S-uK769gJ2ZcS`)
2. **Webhook** (zuverlässiger): `GET http://127.0.0.1:5678/webhook/pickliste-verarbeiten?file_id=<ID>`

**Wichtig:** Idempotenz über `PICKLISTE_VERARBEITET`-Eintrag in `Fehler_und_Hinweise`. Dieselbe File-ID wird nie zweimal verarbeitet.

#### Was WF9 tut

1. PDF aus Google Drive herunterladen
2. Claude parst Pickliste → Produktname + Menge
3. Backstock berechnen (`remaining_qty - current_machine_qty`)
4. Effektive Menge = `min(pick, backstock)`
5. `current_machine_qty` in Produkte aktualisieren
6. Offene Warnungen (LOW_BATCH etc.) auflösen
7. Audit-Einträge in `Fehler_und_Hinweise` schreiben
8. Datei ins Archiv verschieben (`1mOMTE-vTAKFqOO5DW_q9UQ1Hgd7MHV38`)

---

### Patch-Datei

`guv_check_tmp/wf9_pickliste_code.js` — aktueller korrekter Code für `Code - Pickliste verarbeiten`.
Bei Bedarf: `node guv_check_tmp/patch_wf9.js` (noch nicht erstellt — direkt über API patchen).

---

### Offene Punkte

**Nächste echte Auffüllung:**
- Neue Pickliste in Ordner „Pickliste unbearbeitet" legen → WF9 löst automatisch aus
- ODER: File-ID holen → `GET http://127.0.0.1:5678/webhook/pickliste-verarbeiten?file_id=<ID>`

**Lagerchargen bereinigen (später):**
- Abgelaufene Produkte (MHD überschritten): `remaining_qty` auf 0 setzen, `current_machine_qty` anpassen
- Historischen Abgleich mit Nayax-Transaktions-Excel als Source of Truth

**GuV-Daten (WF8):**
- WF8 läuft täglich 02:00 (wenn aktiv) und aggregiert `GuV_Tagesposten`
- Dashboard `/api/guv` zeigt KPIs + Produkttabelle

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
| WF7 Webhook-Path | `nachfuellung` |
| WF8 ID | `qwpQMhZqDAIs8Wi9` |
| WF9 ID | `UtXagT58XYNwxUM5` |
| WF9 Webhook-Path | `pickliste-verarbeiten` |
| WF9 Pickliste-Ordner (unbearbeitet) | `1Djrp-44NtazCB3pa-07S-uK769gJ2ZcS` |
| WF9 Pickliste-Ordner (archiviert) | `1mOMTE-vTAKFqOO5DW_q9UQ1Hgd7MHV38` |
| Dashboard | `http://127.0.0.1:8787/` |
| GuV-Endpoint | `http://127.0.0.1:8787/api/guv` |
| n8n | `http://127.0.0.1:5678/` |
| Projekt-Root | `C:/Users/patri/Documents/mein-erstes-Projekt/` |
| WF9 Code-Datei | `guv_check_tmp/wf9_pickliste_code.js` |

---

## Nayax-Endpoint-Status

Nur `/operational/v1/machines/{id}/lastSales` → 200.
Alle anderen Inventory-Endpoints → 404.
→ Kein Nayax Slot-Status abrufbar. Auto-Refill-Inferenz in WF3 ist der einzige Mechanismus.

---

## Konzept: Auto-Refill-Inferenz im WF3 (Modell A)

User-Anforderung: Auffüll-Vorgang am Automaten soll NICHT manuell ins Sheet
nachgepflegt werden müssen. Slot-Updates dürfen Lager NICHT beeinflussen.

Modell-Semantik (unveränderlich):
- `Lagercharge.remaining_qty` = TOTAL physisch (Slot + Backstock)
- `Produkte.current_machine_qty` = nur Slot (Subset)
- Slot-Updates → Lager bleibt unverändert (matchingColumns verhindert das)
- Verkauf → beide reduziert
- WF9-Refill → nur `current_machine_qty` erhöht, `remaining_qty` unverändert

---

## Snickers-GuV-Formatierungsproblem (gelöst)

In `GuV_Tagesposten` hatte die `guv`-Spalte für Snickers einen Datumswert (Google Sheets hatte die Zahl 4.00 als Datum formatiert). Gelöst durch WF8-Patch: `fmt()` durch `r2()/r4()` ersetzt — schreibt echte JS-Zahlen statt Strings.

Patch-Datei: `guv_check_tmp/patch_wf8_numbers.js`
