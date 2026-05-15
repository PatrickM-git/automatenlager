# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-15 (Session 9 – Phase A5+A6: GuV-Dashboard)

### Neue Funktion dieser Session

#### Phase A5: `/api/guv` Endpoint

Neuer API-Endpoint im Dashboard-Server (`dashboard/server.js`):

```
GET http://127.0.0.1:8787/api/guv?zeitraum=monat&maschine=&von=&bis=
```

**Parameter:**
| Parameter  | Werte                           | Beschreibung |
|---|---|---|
| `zeitraum` | `woche`, `monat`, `quartal`, `custom` | Voreinstellung: `monat` |
| `von`      | YYYY-MM-DD                      | Nur bei `zeitraum=custom` |
| `bis`      | YYYY-MM-DD                      | Nur bei `zeitraum=custom` |
| `maschine` | machine_id oder leer            | Leer = alle Maschinen |

**Datenquelle:** Live-Fetch von `GuV_Tagesposten` via Google Sheets CSV. Fallback auf lokale XLSX.

**Response-Struktur:**
```json
{
  "von": "2026-05-01", "bis": "2026-05-15",
  "kpis": { "umsatz_brutto": 0.0, "wareneinsatz_brutto": 0.0, "guv": 0.0, "quantity_sold": 0, "guv_marge_pct": null },
  "maschinen": ["457107528"],
  "produkte": [{ "product_key": "...", "nayax_product_name": "...", "quantity_sold": 0, "umsatz_brutto": 0.0, "wareneinsatz_brutto": 0.0, "guv": 0.0, "guv_marge_pct": null }],
  "rowCount": 0, "totalRows": 0, "parseWarnings": 0
}
```

**Robustheit:** Zahlenfelder (guv, umsatz_brutto, wareneinsatz_brutto) die von Google Sheets als Datumsformat exportiert werden (bekanntes Snickers-Problem), werden als 0 gewertet und in `parseWarnings` gezählt.

#### Phase A6: GuV-Frontend-Section

Neue Section im Dashboard unter Navigation „GuV & Umsatz" (zwischen n8n Live und Einstellungen):

- **Zeitraum-Tabs:** Monat | Quartal | Woche | Eigener Zeitraum
- **Maschinen-Dropdown:** dynamisch befüllt aus API-Antwort
- **4 KPI-Tiles:** Umsatz (brutto), Wareneinsatz (brutto), GuV (Rohertrag) inkl. Marge-%, Stück verkauft
- **Produkttabelle:** sortiert nach Umsatz, mit Spalten Stück / Umsatz / Wareneinsatz / GuV / Marge
- **Status-Zeile:** Quelle, Gesamtzeilen, Parse-Warnungen (z.B. Snickers-Datumsformat)

#### WF7, WF8, WF9 in Dashboard-Workflow-Landschaft

`workflowFiles` in `server.js` um WF7, WF8, WF9 erweitert — alle drei erscheinen jetzt in der Workflow-Landschaft-Section mit spezifischen Checks:
- WF7: Webhook-Trigger vorhanden, Google-Sheets-Update vorhanden
- WF8: Schedule-Trigger vorhanden, GuV-Append vorhanden
- WF9: Drive-Trigger vorhanden, Idempotenz-Schutz vorhanden

---

### Offenes Problem aus Session 8: Google Drive OAuth2 Credential abgelaufen

Das Credential `Google Drive - Automatenlager` (ID: `UcOBo2UdCzAv1SBG`) gibt einen
Auth-Fehler zurück (Refresh Token abgelaufen/widerrufen).

**WF9 kann erst produktiv genutzt werden, wenn das Credential erneuert ist.**

**Fix:** n8n → Credentials → `Google Drive - Automatenlager` → reconnect → mit Google re-authentifizieren.

---

### Snickers-GuV-Formatierungsproblem

In `GuV_Tagesposten` enthält die `guv`-Spalte für Snickers einen Datumswert (Google Sheets hat die Zahl 4.00 als Datum formatiert). Der Dashboard-Endpoint erkennt das (`parseWarnings`) und wertet den Wert als 0.

**Fix im Sheet:** Google Sheet öffnen → `GuV_Tagesposten` → Spalte `guv` → Format auf „Zahl" stellen → WF8 erneut ausführen um korrekte Werte zu schreiben.

---

## Nächste Schritte

**Priorität 1 (Sofort-Aktionen, nur manuell möglich):**
- Google Drive Credential in n8n re-authentifizieren (`UcOBo2UdCzAv1SBG`)
- Test-Pickliste manuell aus Google Drive Ordner „pickliste unbearbeitet" entfernen
- GuV_Tagesposten Spalte `guv` in Google Sheets auf Format „Zahl" stellen

**Priorität 2 (nach Auffüllen, Montag 2026-05-18):**
- WF9 manuell testen: `GET http://127.0.0.1:5678/webhook/pickliste-verarbeiten?file_id=<PDF_FILE_ID>`
- WF9 aktivieren (Drive Trigger läuft dann automatisch)

**Priorität 3 (technisch):**
- T08g Snickers Drift: `current_machine_qty` im Sheet manuell auf 3 setzen → test_suite 25/25
- WF8 in n8n aktivieren (Cron täglich 02:00) sobald GuV-Sheet-Format korrigiert

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
| WF8 | qwpQMhZqDAIs8Wi9 | — | GuV Tagesposten Aggregator (tägl. 02:00 wenn aktiv) |
| WF9 | UtXagT58XYNwxUM5 | inaktiv | Pickliste verarbeiten (Drive PDF → Batch-Refill) |

---

## Wichtige IDs und Pfade

| Was | Wert |
|---|---|
| Google Sheet ID | `12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo` |
| Google Sheets Credential ID | `5XfHt3SzjHCj8B5H` |
| Google Drive Credential ID | `UcOBo2UdCzAv1SBG` ⚠️ re-auth nötig |
| Maschinen-ID | `457107528` |
| Nayax Maschinenname | CR-FCRvMMfAiraF |
| WF3 ID | `2PFfPf0sVmMW7Fpp` |
| WF5 ID | `A1TQ7CnHXonafVIv` |
| WF7 ID | `nla63DjpTgJrFXDj` |
| WF7 Webhook-Path | `nachfuellung` |
| WF8 ID | `qwpQMhZqDAIs8Wi9` |
| WF9 ID | `UtXagT58XYNwxUM5` |
| WF9 Webhook-Path | `pickliste-verarbeiten` |
| Dashboard | `http://127.0.0.1:8787/` |
| GuV-Endpoint | `http://127.0.0.1:8787/api/guv` |
| n8n | `http://127.0.0.1:5678/` |
| Projekt-Root | `C:/Users/patri/Documents/mein-erstes-Projekt/` |
| Test-Suite | `guv_check_tmp/tests/test_suite.js` |
| Patch-Skripte | `guv_check_tmp/patch_*.js` |
| Pickliste unbearbeitet | `1Djrp-44NtazCB3pa-07S-uK769gJ2ZcS` |
| Pickliste archiviert | `1mOMTE-vTAKFqOO5DW_q9UQ1Hgd7MHV38` |

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
