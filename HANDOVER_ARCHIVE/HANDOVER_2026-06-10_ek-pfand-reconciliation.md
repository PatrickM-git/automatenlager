# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-10_lager-fix-wf3-constraint.md`.

## Session 2026-06-10 (Nachmittag) — Cutover-Guard-Fix + EK/Pfand-Kostenbasis-Reconciliation

### Cutover-Guard (n8n-Ablösung)
- **Threshold 7 → 1 Tag** (`cutover-monitor.js` `DEFAULT_THRESHOLD`), per `CUTOVER_STREAK_THRESHOLD` überschreibbar.
- **Shadow-Window-Bug behoben** (`nayax-sales.js` `runNayaxSalesShadow`): Vergleichsfenster startete bei `Watermark−2d` → alte n8n-Movements polluteten `onlyActual` → `equal=false` (Streak blieb 0). Jetzt: Fenster ab frühester Transaktion der aktuellen Sales-Charge. Befund kam aus Issue [#206](https://github.com/PatrickM-git/automatenlager/issues/206) (Guard hatte ihn **automatisch** eröffnet — funktionierte, war nur im Dashboard unsichtbar).
- Commit `437d171`, deployt, Suite grün (16/16 nayax-sales, 9/9 cutover).
- **Status n8n-Ablösung:** Fundament + nicht-kritische Jobs LIVE. WF3/WF1 = Schatten. Nach 1 deckungsgleicher Nacht → Cutover-Mail → n8n WF3/WF1 deaktivieren, dann WF2/WF4 + Migration 0033 (BYPASSRLS-Entzug).

### EK/Pfand-Kostenbasis — Reconciliation gegen Metro-Rechnungen (Steuerberater-Bericht)
**Entscheidung des Nutzers:** Nur **Flaschen-/Dosenpfand 0,25 €/Stück** gehört in die Warenkosten (Kunde nimmt Flasche → verloren); **Kistenpfand NICHT** (leere Kiste wird abgegeben → rückholbar). Kanonisch: `unit_cost_net` = **Netto + 0,25 Pfand**; GuV = `× MwSt` = brutto. Memory `ek-pfand-kostenbasis`.
- **Aktive Lichtenauer-Chargen korrigiert:** still → **0,600** (0,350+0,25), medium → **0,761** (0,511+0,25). (Zwischenschritt 0,7364 mit Kistenpfand 0,386 war falsch — 4,25 €/Kiste = 11×0,25 + 1,50 Kistenpfand.)
- **Sheet-Befund:** Spalte `unit_cost` mischt Basen — Rechnungs-Import-Zeilen = netto+Pfand (OHNE MwSt), 02.05-Bestandsaufnahme-Zeilen = brutto (MIT MwSt, ×1,19). Daher GuV teils Doppel-MwSt (z.B. Red Bull Spring 2,09 = 1,7612×1,19).
- **guv_daily restated** (reversibel, Backup `automatenlager.guv_daily_bak_20260610`), je Produkt EINHEITLICH netto+Pfand × MwSt:
  - Lichtenauer still → **0,71** (war wild: 1,05/0,85/0,42), medium → **0,91** (zwei 0,00-Bug-Zeilen gefixt) — = Sheet-Spalte G
  - Red Bull → **1,29** (netto 0,83+0,25 DPG), Red Bull Spring → **1,76** (netto 1,23+0,25; KEIN Verlust mehr, VK 2,00 > 1,76)
  - Coca Cola Zero → **0,99** (netto 0,58 + 0,25 DPG)
- **Gesamt-Audit:** Rest aller Produkte im Rundungsbereich (≤0,03) korrekt.

### Alle 8 Rechnungen abgeglichen (Proton Drive `…/03 Füllmaterial/02 Rechnungen`)
Lücken gefüllt aus echten Metro-Rechnungen (Batches + guv_daily, Backup `guv_daily_bak_20260610`):
- **Coca Cola** → 0,99 (24.01.2026: net 0,580+0,25), **Sprite/Fanta Exotic** → 0,92 (24.09.2025: net 0,520+0,25). Platzhalter 1,2852 weg.
- **Red Bull Spring** bestätigt 1,76 (28.02.2026: net 1,230+0,25 = exakt Sheet-Spalte G).
- **Hochwald Eiskaffee** Historie auf **7%** restated (04.06.-Rechnung Klasse B=7%, Milchgetränk): 0,94×1,07=1,01 (war 1,12 @19%).
- Gesamt-Audit: ALLE Produkte jetzt ≤0,03 Rundung. Sauber für den Steuerberater-Bericht.

### NOCH OFFEN (EK) — nur noch architektonisch/minor
1. **Hochwald go-forward**: guv-aggregate nutzt Kategorie-MwSt (getraenk=19%) → neue Hochwald-Zeilen wieder 19%. Echte Lösung = **Per-Produkt-MwSt (Stufe 6)**. Historie ist korrekt (7%).
2. **Lichtenauer DPG↔MW**: aktive 29.05-Charge ist MW (Pur net 0,350 / medium 0,511 → 0,71/0,91). 2025/früh-2026 war DPG (net 0,488+0,25 = 0,738 → ~0,88). Historie steht auf der MW-Standardkost — bei Bedarf periodengenau splitten (kleiner Effekt).
3. **Red Bull go-forward:** FIFO-Front-Charge = 1,48 (→1,76); Historie auf 1,08 (→1,29, lt. Nutzer). Sprung bis 1,48-Charge leer.
4. **Capri Sun** (kein Pfand, 19%): Chargen stehen brutto-in-net (0,4165=0,35×1,19) → ggf. Doppel-MwSt bei Verkäufen prüfen (geringe Stückzahl).

## Session 2026-06-10 (sehr spät) — Alle Seiten hängen + 45 Warnungen + WF3-Constraint

**Branch `main`**, Commits `95001bf`–`c0d65d8`, deployt (außer WF3-Constraint-Fix, Mini offline).

### Root Causes dieser Session

**Alle Seiten hängen auf "wird geladen..."**
Alle 5 Frontend-Routen (`/guv`, `/lager`, `/slots`, `/monitoring`, `/onboarding` + Nav-Init) riefen
`fetchJson('/api/dashboard')` auf — nur für `viewer.canTriggerActions`. `buildDashboard()` macht
`fetchN8nWorkflows()` + `readGoogleSheetsLive()` = **4+ Sekunden**. `Promise.all` wartete auf alle
→ ALLE Seiten hingen.

**Fix (Commit `c0d65d8`):** Alle 5 Vorkommen in `dashboard/public/v3.js` durch
`fetchJson('/api/v2/viewer')` ersetzt. Der neue Endpoint `/api/v2/viewer` (Commit `5e11545`) gibt
nur Viewer-Metadaten zurück, keine n8n/Sheets-Calls. Seiten laden jetzt in <500ms.

**45 Warnungen im Dashboard (Heute-Screen)**
Quelle: `wf-monitor` Job (Worker-Health-Monitor) meldet WF3 n8n (`wbOhFKXQqBpJWB1w`) als
`WORKFLOW_ERROR`. Der echte Fehler aus n8n-Execution 11038 lautet:
```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```
WF3-Knoten „Google Sheets - letzter Verkaufsworkflow aktualisieren" macht:
```sql
INSERT INTO automatenlager.workflow_state (workflow_key, ...)
ON CONFLICT (workflow_key) DO UPDATE ...
```
**Root cause:** Migration 0031 wurde zu früh (vor Cutover #198) auf die Mini-DB angewendet.
Sie änderte den PK von `(workflow_key)` auf `(tenant_id, workflow_key)` — damit gibt es keinen
Unique-Constraint mehr auf `workflow_key` allein, und WF3's `ON CONFLICT (workflow_key)` schlägt
mit 42P10 fehl.

### ⚠ KRITISCHER AUSSTEHENDER FIX (Mini muss online sein)

**Wenn Mini wieder erreichbar:** Kompatibilitäts-Unique für WF3 eintragen:
```sql
ALTER TABLE automatenlager.workflow_state
  ADD CONSTRAINT workflow_state_key_uk UNIQUE (workflow_key);
```
Ausführen via:
```bash
ssh miniserver "docker exec homelab-postgres psql -U postgres -d automatenlager -c \
  \"ALTER TABLE automatenlager.workflow_state ADD CONSTRAINT workflow_state_key_uk UNIQUE (workflow_key);\""
```
Danach die 45 akkumulierten Warnungen löschen:
```sql
DELETE FROM automatenlager.warnings
  WHERE warning_key LIKE '%wf-monitor%' OR source = 'wf-worker-monitor';
-- oder: alle warnings mit type IN ('WORKFLOW_ERROR','AUTH_ERROR') die WF3 betreffen
```
Dieser Fix ist ein **einmaliger Single-Tenant-Compat-Hack** bis Cutover #198 WF3 deaktiviert.
Nach Cutover: Constraint wieder droppen (oder Migration 0031 übernimmt das bereits korrekt).

### B-5 EK-Korrekturen (aus voriger Session, jetzt live)

- **Twix guv_daily 2026-06-04**: `cost_of_goods` 16,50€ → 0,57€ ✓
- **Lichtenauer still batch `B_LICHTENAUER_STILL_20260529_*`**: `unit_cost_net` 0,7140€ → 0,35€ ✓

### Aktueller Zustand

- GuV zeigt live: „Umsatz Jun 26: 127,90 EUR, Marge: 40,4%" ✓
- Lager lädt in <500ms, EK-Preis-Sektion sichtbar, Lichtenauer still 0,35€ ✓
- WF3 schlägt fehl (seit 0031-Premature-Deploy) → 45 Warnungen akkumuliert
- Mini war bei Session-Ende **offline** (Tailscale zeigt „offline, last seen 1m ago")

### Noch ausstehend

1. **⚠ WF3-Constraint-Fix** (s.o., sobald Mini online) — HÖCHSTE PRIORITÄT
2. **45 Warnungen bereinigen** nach Fix
3. **Sprite/Fanta Exotic/Coca-Cola EK** (alle 1,2852€ Platzhalter aus 2026-05-02):
   Echte Rechnungspreise → Dashboard → Lager → EK-Preis pro Charge → ✎ EK.
   Batch-Keys: `B_SPRITE_20260502_1`, `B_FANTA_EXOTIC_20260502_1`, `B_COCA_COLA_20260502_1`
4. **Lichtenauer medium** (0,9057€): prüfen ob korrekt laut Rechnung.
5. **7 Days Croissant Double** (0,5056€): prüfen ob korrekt laut Rechnung.
6. **Red Bull Spring**: EK brutto 2,09€ > VK 2,00€. VK im Automaten auf ≥ 2,20€ anheben.
7. **Cutover #198**: Shadow-Streak noch bei 0. Nach 7 übereinstimmenden Tagen kommt Cutover-Mail.
8. **Nach Cutover**: Migration 0033 (BYPASSRLS-Entzug) deployen, n8n WF3/WF1/WF2/WF4 deaktivieren.
   Migration 0031 ist BEREITS auf der Mini-DB aktiv (wurde zu früh deployed).

## Nächste Schritte

1. **WF3-Constraint-Fix** sofort ausführen (SQL s.o., sobald Mini online) → Warnungen bereinigen.
2. **EK-Korrekturen**: Sprite/Fanta/Cola + Lichtenauer medium + 7 Days Double nach Rechnungsprüfung.
3. **Cutover abwarten**: Täglich 01:00 Uhr Check; nach 7 Tagen Streak → Cutover-Mail.
4. **A3**: Monitoring/Alerting + Off-Site-Backup (nächste größere Aufgabe nach Cutover).
