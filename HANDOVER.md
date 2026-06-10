# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-10_b-ek-investigation.md`.

## Session 2026-06-10 (abends) — #209 EK-Korrektur pro Lagercharge + GuV-Restatement

**Commit `fc1dcd8`** auf `main`, gepusht + deployt. Suite **1322/1323 grün** (1 skip: deploy-gated BYPASSRLS-Test).

### #209 EK-Preis pro Lagercharge korrigierbar — KOMPLETT (Code + Tests + Deploy)

**Warum Charge, nicht Produkt:** Jede Lagercharge hat einen eigenen EK aus der Eingangsrechnung. Korrekturen an der Quelle (Charge) sind sauber; die GuV ist abgeleitet.

#### Neue Dateien
- **`dashboard/lib/batch-ek-correction.js`**:
  - `validateBatchEkUpdate({ batchKey, unitCostNet })` — Validierung.
  - `applyBatchEkUpdate(db, tenant, { batchKey, unitCostNet, runId })` — atomare Tx:
    1. `stock_batches.unit_cost_net` für die Charge aktualisieren (FOR UPDATE).
    2. FIFO-Datumsgrenze berechnen: nächste Charge nach `received_at` der bearbeiteten Charge.
    3. Alle `guv_daily`-Zeilen in dem Zeitfenster (product_id + received_at ≤ posting_date < nächste received_at) restaten: `new_cogs = old_cogs × (new_ek / old_ek)`; Fallback `qty × new_ek` wenn `old_ek ≈ 0`.
    4. `audit.guv_restatement_log` schreiben (runId, Kontext, Alt-/Neu-Werte).
  
- **`dashboard/tests/dashboard-batch-ek-correction.test.js`**: 5 Live-Sandbox-Tests:
  - Validierung; Restatement mit Audit-Log-Check; Mandanten-Isolation; Datumsgrenze; BATCH_NOT_FOUND.

#### Geänderte Dateien
- **`dashboard/server.js`**: 2 neue Routen:
  - `GET /api/v2/batches` — alle aktiven Chargen mit `unit_cost_net`, `received_at` (lesen: betrieb.lesen).
  - `PUT /api/v2/batches/unit-cost` — Admin-only (canTriggerActions), body: `{ batch_key, unit_cost_net }`, Audit-Log in `logs/batch-ek-corrections.jsonl`.
- **`dashboard/public/v3.js`**:
  - `/lager`-Route lädt zusätzlich `/api/v2/batches` → `ekBatches`.
  - `renderEkChargenSection()` — Tabelle mit allen Chargen + EK, nur für Admins sichtbar.
  - `openEkEditDialog()` — Modal mit Inline-Edit + Restatement-Feedback (reload nach Speichern).
  - `bindEkChargenEdit()` — Event-Delegation auf Edit-Buttons.

#### Sandbox-Fixes (pre-existing, post-0032-Deploy)
- **`guv-restatement.test.js`**: `mandant_id` → `tenant_id` in Classification-Settings-INSERT.
- **`guv-restatement-preflight.test.js`**: `mandant_id` → `tenant_id` in SELECT.
- **`dashboard-mt-0012-business-keys.test.js`**: `workflow_state_pkey`-Assertion aktualisiert (Mini-DB hat bereits `PRIMARY KEY (tenant_id, workflow_key)` — 0031 teilweise deployed).
- **`dashboard-v3-einstellungen.test.js`**: `tenantColumn()` (entfernt in #108) → `tenant_id` hardkodiert.

### Offene EK-Fehler (#211) — noch zu beheben

3 konkrete EK-Fehler in der DB (laut Rechnungsvergleich, letzter Session):
1. **Twix** (`batch_key = ?`): `0.016` → `0.480` (WF2-Parse-Fehler).
2. **7 Days Croissant** (`batch_key = ?`): `0.5056` → `0.4725` (MwSt vor Stück-Division angewendet).
3. **Sprite/Fanta/Coca-Cola Mai** (3 Chargen): `1.2852` → echt je Produkt (Platzhalter).

**Nächster Schritt für #211:** Im Dashboard → Lager → EK-Chargen (Admin) die 3 Chargen suchen, `unit_cost_net` korrigieren. Die GuV-Zeilen werden automatisch restated.

### WF2-Bug (#211 verwandt)
7 Days Croissant: WF2 rechnet MwSt (7%) VOR der Division durch 4 (Packungsgröße) an. Fix in n8n-Workflow erforderlich (wenn 7 Days wieder eingekauft wird). Späteres Thema.

### Cutover #198 Status
- Shadow-Streak nach Fix noch bei 0 (letzter Lauf war vor Deploy).
- Nächster automatischer Run um 01:00 sollte `equal=true` → Cutover-Mail senden.
- Nach Cutover-Mail + 7 Tagen Streak: Migration 0033 anwenden, n8n WF3/WF1/WF2/WF4 deaktivieren.

## Nächste Schritte

1. **#211 EK-Korrekturen**: Im /lager Admin-Panel die 3 falschen EK-Preise korrigieren.
2. **Cutover abwarten**: Morgen früh Email prüfen ob Cutover-Mail kam.
3. **Nach Cutover**: Migration 0031 (global uniques drop, deploy-gated) + 0033 (BYPASSRLS) anwenden.
4. **A3 Monitoring/Alerting** + Off-Site-Backup.
