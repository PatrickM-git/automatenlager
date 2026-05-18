# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-05-13 (Session 7 – Auto-Resolve + WF7 Nachfüllung, Test-Suite 24/25)

### Neue Funktionen dieser Session

#### 1. WF5 Auto-Resolve: Warnungen lösen sich selbst auf

**Problem vorher:** Wenn Lager wieder aufgefüllt wurde (neue Charge per WF1+WF2),
blieben EMPTY_BATCH / LOW_BATCH / INSUFFICIENT_BATCH_STOCK Einträge in
`Fehler_und_Hinweise` als `resolved=FALSE` stehen. User musste manuell
`resolved=TRUE` setzen.

**Lösung:** `patch_wf5_auto_resolve.js` erweitert WF5 um zwei neue Nodes:

- `Extract - Auto-Resolve Hinweise` (Code)
- `Google Sheets - Hinweise auflösen` (GSheets update, matched auf `created_at`)

**Logik in `Code - MHD und Lagercharge pruefen` (am Ende, nach Alert-Generierung):**

```
Für jeden ungelösten Hint in Fehler_und_Hinweise:
  EMPTY_BATCH             → auto-resolve wenn totalRemaining > 0
  INSUFFICIENT_BATCH_STOCK → auto-resolve wenn totalRemaining > 0
  LOW_BATCH               → auto-resolve wenn totalRemaining > lowBatchThreshold (5)
  LOW_STOCK               → auto-resolve wenn current_machine_qty >= min_stock
```

Marker: `// PATCH AUTO_RESOLVE_WF5`

**WF5 läuft täglich um 07:00** — also wird jede Verbesserung innerhalb von
24 Stunden automatisch erkannt und aufgelöst.

#### 2. WF7 Nachfüllung melden (ID: nla63DjpTgJrFXDj)

**Problem:** WF3 Auto-Refill funktioniert nur bei einem Verkauf. Wenn User den
Automaten auffüllt, aber danach **wochenlang kein Verkauf** stattfindet, bleibt
`current_machine_qty` stale = 0 im Sheet (obwohl Slot voll ist).

**Lösung:** Neuer Webhook-Workflow WF7.

Aufruf (GET):
```
http://127.0.0.1:5678/webhook/nachfuellung?product_key=SKU_COCA_COLA_ZERO&qty=8
```

Parameter:
| Parameter    | Pflicht | Beschreibung |
|---|---|---|
| `product_key` | ✓ | z.B. `SKU_COCA_COLA_ZERO` |
| `qty`         |   | Stück jetzt im Slot (default: `machine_capacity`) |
| `notes`       |   | Freitext-Bemerkung |

Aktionen:
1. Liest alle aktiven Slots des Produkts aus `Produkte`
2. Setzt `current_machine_qty = qty` (oder `machine_capacity` wenn qty fehlt)
3. Setzt `last_stock_update_source = WF6_NACHFUELLUNG`
4. Markiert alle offenen EMPTY_BATCH / LOW_STOCK / INSUFFICIENT_BATCH_STOCK /
   LOW_BATCH Einträge für diesen `product_key` als `resolved=TRUE`
5. Schreibt Audit-Eintrag `type=NACHFUELLUNG` in `Fehler_und_Hinweise`

**Dashboard-Integration:** Die URL kann als Button in das Dashboard eingebaut
werden (z.B. per `/api/trigger` Proxy oder direkt als `<a href=...>`).

#### 3. Snickers T08g Drift (offenes Problem)

Test T08g zeigt: `SKU_SNICKERS: slot=4 > lager=3`.

Das bedeutet `current_machine_qty=4` aber `Lagerchargen.remaining_qty=3`.
Das ist widersprüchlich (Slot ist Subset von Lager). Mögliche Ursachen:
- Snickers wurde seit dem manuellen `init`-Fix (17 statt 77) einmal verkauft
  aber `current_machine_qty` wurde nicht entsprechend angepasst
- Oder die Lagercharge hat ein veraltetes `remaining_qty`

**Fix:** Entweder manuell `current_machine_qty` im Sheet auf 3 setzen,
ODER `inventory_apply.js` nach Inventur laufen lassen.

---

### Vollständige Auto-Resolve-Logik (Übersicht)

| Auslöser | Mechanismus | Zeitverzögerung |
|---|---|---|
| Produkt wird nach EMPTY_BATCH wieder verkauft | WF3 Auto-Refill → WF5 erkennt remaining>0 am nächsten Morgen → auto-resolve | < 24h nach erstem Sale |
| Neue Lieferung per WF1+WF2 | Lagercharge.remaining erhöht → WF5 erkennt next morning | < 24h |
| Manuell auffüllen (keine Sales) | WF7 Nachfüllung melden → sofort | sofort |
| User setzt resolved=TRUE manuell | Direkt im Sheet | sofort |

### Wann bekommst du eine Email?

| Situation | Email? | Auto-Resolve? |
|---|---|---|
| Lager komplett leer (EMPTY_BATCH) | **Ja** — einmal, dann 7 Tage Ruhe | **Ja** — wenn remaining > 0 (WF5 täglich) |
| Lager unter Schwellwert (LOW_BATCH) | **Ja** — einmal, dann 7 Tage Ruhe | **Ja** — wenn remaining > 5 (WF5 täglich) |
| MHD läuft in ≤30 Tagen | **Ja** — einmal, dann 7 Tage Ruhe | Nein (Datum-basiert) |
| MHD abgelaufen | **Ja** — kritisch | Nein (manuell oder neue Charge) |
| UNKNOWN_PRODUCT | **Ja** — einmal | Nein (WF4-Fix nötig) |
| Slot leer (LOW_STOCK) | info-only, 7 Tage Ruhe | **Ja** — wenn cmq >= min_stock (WF5) |
| Slot leer (Auto-Refill) | Nein | Automatisch durch WF3-Sale |

---

## Vorheriger Stand (Session 6 – Mail-Dedup + Auto-Refill)

### Mail-Dedup in WF5 (verhindert tägliche Wiederholungs-Spam)

User-Anforderung: "einmal benachrichtigen, dann ruhig". WF5 hatte das
Problem, dass `EMPTY_BATCH`/`LOW_BATCH`/`MHD_WARNING`/`LOW_STOCK` jeden
Tag neu erzeugt wurden — gleiche Mail jeden Morgen.

Lösung in `Code - MHD und Lagercharge pruefen`:
- Beim Start: lese `Fehler_und_Hinweise`, bilde Set von
  `(type, product_key, batch_id)` mit `resolved=FALSE` UND `created_at`
  innerhalb der letzten **7 Tage**.
- Vor jedem Alert-Push: `shouldEmitAlert(type, pk, batch)` prüft das Set.
  Wenn schon vorhanden → Alert wird NICHT erzeugt (kein Sheet-Schreiben,
  keine Mail).
- Nach 7 Tagen ohne Resolution → automatischer Reminder.
- Wenn User `resolved=TRUE` setzt → beim nächsten Auftreten wieder Alert.

Patch: `guv_check_tmp/patch_wf5_dedup.js`

### Falcone Nussnougat Inventur-Korrektur

User-Bestätigung: "alles im Slot, Lager-Backstock leer". Slot-Summe = 19
(MDB 20 mit 7 + MDB 24 mit 12). Lager.remaining war 11, gesetzt auf 19.
Initial bleibt 40 (Sonderposten-Lieferung 07.03.). Differenz 21 sind
historische Verkäufe und Schwund.

Audit-Eintrag in `Fehler_und_Hinweise` (type=INVENTUR_RESET).

### Aktuelle Test-Suite (25 Tests, 24/25)

| Test | Status |
|---|---|
| T01 Produkte aktive haben pk + mdb + slot_id | ✓ |
| T02 slot_id Format | ✓ |
| T03 Lagerchargen aktiv+remain>0 haben pk + mhd | ✓ |
| T04 OK-Tx haben pk + batch_id_abgebucht | ✓ |
| T05 keine UNKNOWN_PRODUCT-Tx über aktive Slots | ✓ |
| T06 Tx product_keys existieren | ✓ |
| T07 jeder MDB max 1 active Slot | ✓ |
| T08 keine Doppelbuchung | ✓ |
| T08b Schwund-Info | ✓ |
| T08c keine doppelten transaction_id | ✓ |
| T08d kein remain > initial | ✓ |
| T08e keine negativen remaining_qty | ✓ |
| T08f Rechnungs-Chargen: initial = Lieferung | ✓ |
| **T08g Slot current_qty ≤ aktive Lager-Summe** | **✗ SKU_SNICKERS slot=4 > lager=3** |
| T09a FIFO slot-basiert | ✓ |
| T09b Regex tolerant | ✓ |
| T09c Auto-Refill-Inferenz vorhanden | ✓ |
| T09d WF5-Code: Auto-Resolve-Patch | ✓ |
| T09e WF5: Extract-Auto-Resolve-Node vorhanden | ✓ |
| T09f WF5-Code: Dedup-Patch vorhanden | ✓ |
| T09g WF7 Nachfuellung-Webhook: aktiv | ✓ |
| T10 Produktbestand Update sauber | ✓ |
| T11 Produkte lesen kein machine_id Filter | ✓ |
| T12 Dashboard erreichbar | ✓ |
| T13 Letzter WF3-Run success | ✓ |

---

## Refill-Workflow Übersicht (vollständig)

| Situation | Was tun? | Was passiert automatisch? |
|---|---|---|
| Slot vom Backstock auffüllen, Sale folgt bald | Nichts | WF3 Auto-Refill beim nächsten Sale |
| Slot auffüllen, keine Sales für Wochen | **WF7 Webhook aufrufen** | Slot-Update + Warning-Resolve sofort |
| Neue Lieferung (Metro/Sonderposten) | WF1 PDF-Upload → WF2 Approve | Lagercharge angelegt, WF5 löst EMPTY_BATCH auf |
| Manuelle Inventur | `inventory_export.js` + `inventory_apply.js` | Alle Werte zurückgesetzt |

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
| WF7 | nla63DjpTgJrFXDj | **aktiv** | **Nachfüllung melden (Webhook GET)** |
| WF8 | qwpQMhZqDAIs8Wi9 | — | GuV Tagesposten Aggregator |

---

## Nayax-Endpoint-Status

Nur `/operational/v1/machines/{id}/lastSales` → 200.
Alle anderen Inventory-Endpoints (currentInventory, productMatrix, refills, slots etc.) → 404.
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

Neu in WF3 `Code - FIFO berechnen` (Funktion `queueProductQtyDeduction`):
```
Bei jedem Sale:
  Wenn current_machine_qty <= 0 UND Lager.remaining > 0:
    → infer: User hat Slot aufgefüllt
    → setze current_machine_qty = MIN(machine_capacity, lager_remaining)
    → DANN normaler Abzug -1
    → Audit-Warning AUTO_REFILL_SLOT (severity=info)

  Wenn current_machine_qty <= 0 UND Lager.remaining = 0:
    → INSUFFICIENT_BATCH_STOCK (Lager wirklich leer)
    → Email-Alert: "Bitte neue Lagercharge ergänzen"
```

Patch-Skript: `guv_check_tmp/patch_wf3_auto_refill.js`
Validierung: `guv_check_tmp/test_auto_refill_simulation.js` (lokale VM-Sandbox)

---

## Diagnose: Herkunft der `initial_qty`-Werte

ALLE Chargen mit `supplier='Bestandsaufnahme...'` (34 von 46 Chargen)
stammen aus einer manuellen Inventur am 2026-05-02 (Handschrift). Die `initial_qty`
ist NICHT aus Rechnungen geparst, sondern handschriftlich gezählt.

Inventur-Tools in `guv_check_tmp/`:
- `inventory_export.js [suffix]` — legt `Inventur_<datum><suffix>` im Sheet an
- `inventory_apply.js [suffix] [--dry-run]` — appliert real_total/real_im_slot zurück

Im Sheet liegt bereits `Inventur_2026-05-13_v2`.

---

## Wichtigster Bugfix (Session A3): `Produkte lesen` Filter

Root-Cause für UNKNOWN_PRODUCT Fehler: Filter `machine_id = MachineID` im
`Google Sheets - Produkte lesen` Node lieferte nur 1 von 40 Produkten.

Fix: `guv_check_tmp/patch_wf3_read_filter.js` — machine_id-Filter entfernt.
Aktiv-Filter bleibt. WF3 Execution 488: jetzt 36 Items statt 1.

---

## Aktueller nächster Schritt (aus CLAUDE.md)

**Phase A4 Test: WF8 (`qwpQMhZqDAIs8Wi9`) manuell ausführen**

- Im n8n UI WF8 öffnen, "Execute workflow"
- Prüfen: kommen GuV-Einträge in GuV_Tagesposten an?
- Bei Erfolg WF8 auf "active" setzen (Cron täglich 02:00)

Danach **Phase A5**: Dashboard `/api/guv` Endpoint.

---

## Wichtige IDs und Pfade

| Was | Wert |
|---|---|
| Google Sheet ID | `12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo` |
| Google Sheets Credential ID | `5XfHt3SzjHCj8B5H` |
| Maschinen-ID | `457107528` |
| Nayax Maschinenname | CR-FCRvMMfAiraF |
| WF3 ID | `2PFfPf0sVmMW7Fpp` |
| WF5 ID | `A1TQ7CnHXonafVIv` |
| WF7 ID | `nla63DjpTgJrFXDj` |
| WF7 Webhook-Path | `nachfuellung` |
| Dashboard | `http://127.0.0.1:8787/` |
| n8n | `http://127.0.0.1:5678/` |
| Projekt-Root | `C:/Users/patri/Documents/mein-erstes-Projekt/` |
| Test-Suite | `guv_check_tmp/tests/test_suite.js` |
| Patch-Skripte | `guv_check_tmp/patch_*.js` |
