# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-10_d-lager-fix.md`.

## Session 2026-06-10 (spät) — Lager-Seite hängt + EK-Korrekturen B-5

**Branch `main`**, Commits `95001bf`–`33016f6`, deployt. Suite 1322/1323 grün.

### Root Causes dieser Session

**Lager-Seite lädt nicht (EK-Sektion unsichtbar)**
`/lager` rief im `Promise.all` auch `/api/dashboard` auf — nur um `viewer.canTriggerActions` zu lesen. `buildDashboard()` macht dabei `fetchN8nWorkflows()` + `readGoogleSheetsLive()`, was **4+ Sekunden** dauert. Die anderen 3 Calls kamen in ~200ms zurück, aber `Promise.all` wartet auf alle → Seite blieb auf "wird geladen...".
Fix: `canTriggerActions` direkt in `/api/v2/batches` mitliefern; `/api/dashboard` aus dem Lager-Promise.all entfernt. Lager-Seite lädt jetzt in <500ms.

**Tailscale-Header wurde injiziert** (war kein Bug): Debug-Endpoint bestätigte `tailscale-user-login: patrickmatthes2609@gmail.com` ✓. Das Auth-System war korrekt, nur die Seite lud nicht durch.

**B-5 EK-Korrekturen**
- **Twix guv_daily 2026-06-04**: `cost_of_goods` 16,50€ → 0,57€ (Kartonpreis aus altem WF8-Sheets-Eintrag)
- **Lichtenauer still batch**: `unit_cost_net` 0,7140€ → **0,35€** laut Rechnung 29.05. (WF2 hatte offenbar einen 2er-Pack-Preis als Stückpreis übernommen)

### Aktueller Zustand (verifiziert im Browser via Tailscale)

- `/lager` lädt schnell, zeigt EK-Preis-Sektion mit Admin-Badge ✓
- Lichtenauer still: 0,35€ in der EK-Tabelle ✓
- 7 Days Croissant: 0,4725€ ✓
- Twix original: guv_daily 2026-06-04 korrigiert ✓

### Noch ausstehend

1. **Sprite/Fanta Exotic/Coca-Cola EK** (alle 1,2852€, Platzhalter aus 2026-05-02):
   Echte Rechnungspreise nachschlagen → Dashboard → Lager → EK-Preis pro Charge → ✎ EK.
   Batch-Keys: `B_SPRITE_20260502_1`, `B_FANTA_EXOTIC_20260502_1`, `B_COCA_COLA_20260502_1`

2. **Lichtenauer medium** (0,9057€): noch prüfen ob korrekt laut Rechnung.

3. **7 Days Croissant Double** (0,5056€): noch prüfen ob korrekt laut Rechnung.

4. **Red Bull Spring**: echter betrieblicher Verlust — EK brutto 2,09€ > VK 2,00€. VK im Automaten auf ≥ 2,20€ anheben.

5. **GuV heute zeigt 0€**: WF3 läuft täglich 01:00 — tagsüber keine neuen Transaktionen in der DB, das ist normal.

6. **41 Fehlermeldungen im Dashboard**: Quelle noch unklar (wahrscheinlich n8n-Interface, nicht der Worker). Worker selbst läuft stabil.

7. **Cutover #198**: Shadow-Streak noch bei 0. Täglich 01:00 Uhr Check; nach 7 übereinstimmenden Tagen kommt die Cutover-Mail.

8. **Nach Cutover**: Migration 0031 (global uniques drop) + 0033 (BYPASSRLS-Entzug) deployen, n8n WF3/WF1/WF2/WF4 deaktivieren.

## Nächste Schritte

1. **EK-Korrekturen**: Im Dashboard → Lager → EK-Preis pro Charge die Platzhalter-Preise korrigieren (Sprite/Fanta/Cola + Lichtenauer medium + 7 Days Double nach Rechnungsprüfung).
2. **Cutover abwarten**: Morgen früh Email prüfen.
3. **A3**: Monitoring/Alerting + Off-Site-Backup (nächste größere Aufgabe nach Cutover).
