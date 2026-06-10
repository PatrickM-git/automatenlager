# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-10_c-guv-bruch-audit.md`.

## Session 2026-06-10 (spät abends) — GuV-Bruch-Audit + B-1/B-2/B-3 Fixes

**Branch `main`**, commits `d6436dd`–`f746672`, deployt. Suite **1322/1323 grün** (1 skip: deploy-gated BYPASSRLS-Test).

### Ursachen der Brüche (Root Cause Analysis)

**B-1 — LATERAL ignoriert `remaining_qty` (Lichtenauer Still 1.05€ statt 0.85€)**

`guv-aggregate.js` portierte die WF8-Batch-Lookup-Logik 1:1: „älteste aktive Charge mit `received_at <= Verkaufsdatum`". WF8 hätte dazu `status='leer'` benötigt — WF3/n8n setzt das aber **nie aktiv**: der DB-Trigger dekrementiert nur `remaining_qty`; `status` bleibt `'aktiv'` auch wenn `remaining_qty=0`. Beim Port wurde der fehlende `remaining_qty > 0`-Filter nicht ergänzt. Mit `ON CONFLICT DO NOTHING` wurde der Fehler eingefroren (kein Überschreiben alter Zeilen).

**B-3 — Twix / 7 Days falsche EK-Preise (WF2-Parse-Bugs)**
- **Twix** (0.016€ → 0.480€): WF2 hat den Packungspreis als Stückpreis übernommen (OCR-Fehler bei der Mengenerkennung).
- **7 Days Croissant** (0.5056€ → 0.4725€): WF2 hat MwSt (7%) vor der Division durch Packungsgröße 4 angewendet statt danach.

**B-4 — `mandant_id`-Fehler in Tests** (bereits in `fc1dcd8` behoben): Migration 0032 benannte `classification_settings.mandant_id → tenant_id` um; einige Test-INSERTs nutzten noch den alten Namen.

### Umgesetzte Fixes

#### B-1: guv-aggregate LATERAL-Bug — KOMPLETT
- **`dashboard/lib/jobs/guv-aggregate.js`** (`d6436dd`): LATERAL-Subquery filtert jetzt `AND sb.remaining_qty > 0` und schließt `'leer'` aus der Statusliste aus.
- **Regressionstest** `B1-fix LIVE` in `dashboard/tests/dashboard-jobs-guv-aggregate.test.js` hinzugefügt (14/14 grün).
- **Deployt auf Mini**: Container neu gestartet; guv-aggregate läuft alle 15 min (`runOnStart: true`).

#### B-2: Lichtenauer Still historische Zeilen — KOMPLETT
- `B_LICHTENAUER_STILL_20260502_1`: `status` auf `'leer'` gesetzt (war `'aktiv'` mit `remaining_qty=0`).
- 6 fehlerhafte `guv_daily`-Zeilen (seit 2026-05-29, `source='wf8_guv_aggregator'`) gelöscht.
- guv-aggregate re-inseriert mit korrektem EK 0.7140 × 1.19 ≈ **0.85€** beim nächsten Lauf.
- Verifiziert: 21 korrekte Zeilen vor 2026-05-29 mit 1.05€ (alter Batch) bleiben erhalten.

#### B-3: Twix + 7 Days EK-Korrekturen — KOMPLETT
- **Twix** `B_TWIX_ORIGINAL_20260529_*`: `unit_cost_net` 0.016 → 0.4800; 1 `guv_daily`-Zeile restated; Audit-Log geschrieben.
- **7 Days** `B_7_DAYS_CROISSANT_20260529_*`: `unit_cost_net` 0.5056 → 0.4725; 4 `guv_daily`-Zeilen restated; 4 Audit-Log-Einträge.
- Restatement-Formel: `new_cogs = old_cogs × (new_ek / old_ek)`, Fallback `qty × new_ek` wenn `old_cogs≈0`.

#### Temp-SQL-Dateien (B-2/B-3)
- Commits `f5ab63f`/`bcf0631`/`e973100`: SQL-Dateien eingecheckt und ausgeführt.
- Commit `f746672`: Temp-Dateien nach Ausführung gelöscht (sauberes Repo).

### Noch ausstehend

1. **Sprite/Fanta Exotic/Coca-Cola EK** (3 Chargen, alle `unit_cost_net=1.2852`, Platzhalter aus 2026-05-02): Echte Rechnungspreise nachschlagen, dann im Dashboard → Lager → EK-Chargen (Admin) korrigieren. Chargen-Keys:
   - `B_SPRITE_20260502_1` (remaining=21)
   - `B_FANTA_EXOTIC_20260502_1` (remaining=19)
   - `B_COCA_COLA_20260502_1` (remaining=20)

2. **Lichtenauer Still Verifikation**: Nach nächstem guv-aggregate-Lauf prüfen, ob neue Zeilen seit 2026-05-29 mit `cost_of_goods ≈ 0.85€` erscheinen.

3. **Mini-Pull `f746672`**: Cleanup-Commit noch nicht auf den Mini gepullt.
   ```bash
   wsl -d Ubuntu-24.04 bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only"
   ```

4. **Uncommitted Changes auf Dev-PC**:
   - `dashboard/lib/jobs/invoice-intake.js` (WF1/WF2-Port, in Arbeit)
   - `dashboard/lib/jobs/monitor.js` (Worker-Health-Monitoring)
   - Diese gehören zu A2/A3 und brauchen eigenen Issue/PR.

5. **Cutover #198**: Shadow-Streak noch bei 0 (letzter Lauf war vor Deploy). Täglich 01:00 Uhr läuft der Check. Nach 7 übereinstimmenden Tagen kommt die Cutover-Mail → dann WF3_CUTOVER=1 setzen.

6. **Nach Cutover**: Migration 0031 (global uniques drop, deploy-gated) + 0033 (BYPASSRLS-Entzug) anwenden.

### Cutover #198 Status
- Shadow-Streak nach Fix noch bei 0 (letzter Lauf war vor Deploy `d6436dd`).
- Automatischer Check 01:00 Uhr; nach 7 Tagen Streak → Cutover-Mail.
- Nach Cutover + 7 Tagen: Migration 0031 anwenden, dann 0033, dann n8n WF3/WF1/WF2/WF4 deaktivieren.

## Nächste Schritte

1. **Mini-Pull** (`f746672`, Cleanup-Commit): `wsl -d Ubuntu-24.04 bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only"`.
2. **Sprite/Fanta/Cola EK-Korrekturen** (#211): Rechnung nachschlagen → Dashboard → Lager → EK-Chargen.
3. **Lichtenauer Still** verifizieren: GuV-Panel prüfen ob neue Zeilen seit 2026-05-29 korrekt sind.
4. **Cutover abwarten**: Morgen früh Email prüfen.
5. **Nach Cutover**: Migration 0031 + 0033 deployen, n8n-WFs deaktivieren.
6. **A2-Fortsetzung**: `invoice-intake.js` + `monitor.js` fertigstellen und committen (eigener Issue).
7. **A3**: Monitoring/Alerting + Off-Site-Backup.
