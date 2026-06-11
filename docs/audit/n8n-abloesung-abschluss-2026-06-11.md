# n8n-Ablösung — Abschlussprotokoll (Stufe 6 KOMPLETT)

> 2026-06-11. Dieses Dokument hält fest, WAS abgelöst wurde, WIE es validiert ist,
> und wie der Rückweg aussieht. Kontext: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md`,
> Tagesablauf in `HANDOVER.md`.

## Endzustand

**Alle 18 n8n-Workflows sind deaktiviert. Jede Fach- und Hilfslogik läuft als
Backend-Code** (Dashboard-Endpunkte + Worker-Jobs durch die Mandanten-Tür, RLS).
`n8n_app` hat **kein BYPASSRLS mehr** (Migration 0033) — der RLS-Backstop gilt
damit **systemweit ohne Ausnahme**. Der n8n-Container läuft als inertes Archiv
weiter (Ausführungshistorie), kann aber jederzeit gestoppt werden.

## Wer hat wen ersetzt (vollständige Tabelle)

| n8n-Workflow | Ersatz | Seit |
|---|---|---|
| WF0 Backfill | obsolet (einmaliger Sheets-Backfill) | Slice 2 |
| WF1 Rechnungseingang | Worker `lib/jobs/invoice-intake.js` (Drive-Poll + Claude-OCR, `WF1_CUTOVER=1`) + **Dashboard-Upload direkt in den Drive-Ordner** (`google-drive-client.upload()`, eigenes Ordnerpaar `GOOGLE_DRIVE_INVOICE_*`) | **2026-06-11** |
| WF2 Produktfreigabe | Dashboard `POST /api/v2/invoice-proposal/approve` (Produkt+Alias+Charge atomar via db.tx) — war seit Slice 3 in-process, n8n-Form war nur noch Alt-Eingang | **2026-06-11** (deaktiviert) |
| WF3 Nayax-FIFO | Worker `lib/jobs/nayax-sales.js` (`WF3_CUTOVER=1`) | 2026-06-11 (früh) |
| WF4 Slot-Zuordnung | Dashboard `POST /api/v2/slot-change/confirm` → **`applySlotChange()`** in `lib/jobs/wf4-slot-write.js` (close+open atomar durch die Tür; ersetzt `SLOT_CHANGE_WEBHOOK_URL`) | **2026-06-11** |
| WF5 MHD-Monitor | Worker `lib/jobs/wf5-monitor.js` | Slice 2 |
| WF7 Nachfüllung | Dashboard `lib/refill-apply.js` | früher |
| WF8 GuV-Aggregat | Worker `lib/jobs/guv-aggregate.js` | Slice 1 |
| WF9 Pickliste | Worker `lib/jobs/picklist.js` | Slice 2 |
| WF-PGW (Schreib-Durchreicher) | obsolet — kein n8n-Schreiber mehr; Event-Semantik lebt getestet in `wf4-slot-write.js` weiter | **2026-06-11** |
| WF-Nayax-Abgleich | Dashboard `nayax-abgleich/preview|apply`: **`fetchNayaxMachineProducts()`** (direkt Nayax-API inkl. Namens-Anreicherung) + **`applySlotAssignmentEvents()`** durch die Tür (ersetzt `NAYAX_ABGLEICH_WEBHOOK_URL`) | **2026-06-11** |
| WF-Monitor | Worker `wf-worker-monitor` + `anomaly-monitor` (audit.workflow_runs) | 2026-06-11 (früh) |
| WF-Val / WF-MatView-Refresh / WF-Claude-Proposals / WF-Nayax-Devices-Sync | Worker-Jobs (`db-validation`, `matview-refresh`, `claude-proposals`, `nayax-devices-sync`) | Slice 1/2 |
| WF-Drift-Check / WF-Update-Check / WF-Migrate | obsolet (prüften n8n-Eigenzustand bzw. Migrations via n8n; Migrationen laufen per psql/Tunnel) | **2026-06-11** |

## Validierung

- **Suite:** voller Lauf grün (inkl. neuer Tests: `drive.upload` multipart,
  `buildInvoiceDriveFromEnv`, `applySlotChange` LIVE im Rollback-Sandbox gegen die
  Prod-DB, `fetchNayaxMachineProducts` inkl. Detail-Cache/Fallback/Fehlertoleranz).
- **WF3-Cutover-Erstlauf:** `--run wf3-nayax-fifo` → mode:cutover, 200 Sales,
  0 Doppelbuchungen (Dedup über processedTxIds), Watermark repariert.
- **Live-Smoke nach Deploy:** `/health` ok; Worker-Log `Invoice-Drive: live`;
  Abgleich-Preview liefert Diff direkt von der Nayax-API.
- **Sicherheitsnachweis:** `dashboard-bypassrls-security.test.js` greift nach 0033
  (n8n_app = NOBYPASSRLS), vorher bewusst geskippt.

## Bekannte Verhaltens-Hinweise (kein Bug, dokumentiert)

1. **WF1-Schatten lief auf dem Mini nie scharf** — `WF1_TENANT_ID`/`NAYAX_TENANT_ID`
   fehlten in der Env, der Job meldete „skipped". Der Cutover stützt sich daher auf
   die Testsuite (Intake-Apply LIVE-getestet) statt auf Schatten-Tage. Rechnungen
   sind zudem inert, bis ein Mensch den Vorschlag freigibt — geringes Risiko.
2. **Invoice-Intake pollte vorher den Picklisten-Ordner** (geteilter Drive-Client) —
   mit dem eigenen Ordnerpaar `GOOGLE_DRIVE_INVOICE_*` behoben.
3. **Obsolete Env-Variablen:** `INVOICE_UPLOAD_WEBHOOK_URL` (nur noch Fallback ohne
   Invoice-Ordner), `SLOT_CHANGE_WEBHOOK_URL`, `NAYAX_ABGLEICH_WEBHOOK_URL` (tot),
   `N8N_BASE_URL`/`N8N_API_KEY` (nur noch für die Status-Anzeige der Alt-Oberfläche).
4. **cutover-readiness-monitor** ist gegenstandslos (keine Schatten mehr) — läuft
   harmlos weiter, kann beim nächsten Aufräumen aus dem Worker-Schedule fallen.

## Rückweg (falls je nötig)

1. Migration-0033-Gegenstück: `ALTER ROLE n8n_app BYPASSRLS;` (Infra-Rolle).
2. Betroffenen n8n-Workflow per API aktivieren (IDs in diesem Doc/HANDOVER).
3. Env-Flag zurück (`WF3_CUTOVER`/`WF1_CUTOVER` entfernen ⇒ Schattenbetrieb) bzw.
   Webhook-Env wieder setzen (`SLOT_CHANGE_WEBHOOK_URL`, `NAYAX_ABGLEICH_WEBHOOK_URL`,
   `INVOICE_UPLOAD_WEBHOOK_URL`) — die Webhook-Fallback-Pfade wurden NICHT entfernt
   (Upload) bzw. sind per git revert wiederherstellbar (Slot-Change, Abgleich).
4. Container-Restart Dashboard + Worker.

## Folgearbeiten (Ideen, bewusst NICHT heute)

- n8n-Container ganz stoppen + aus dem Compose nehmen (nach ein paar Wochen Ruhe);
  vorher Ausführungshistorie exportieren, falls gewünscht.
- `cutover-monitor`/`shadow-harness` aus dem Worker-Schedule nehmen (Code als
  Vorbild für künftige Schatten-Migrationen behalten).
- Alte Webhook-Codepfade (Upload-Fallback) nach einer Schonfrist entfernen.
- `N8N_BASE_URL`-abhängige Status-Anzeigen der Alt-Oberfläche (index.html) stilllegen.
- ROADMAP A2 = erledigt; nächster Fokus laut ROADMAP: A3 Betriebsreife
  (Monitoring/Off-Site-Backup), dann A4 Self-Service.
