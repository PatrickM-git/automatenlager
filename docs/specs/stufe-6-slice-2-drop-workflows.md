# Stufe 6 Slice 2 — Ehrlich stillgelegte Workflows (DROP, nicht portiert)

Issue #162. Parent-SPEC: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md`.

Drei n8n-Workflows werden bei der n8n-Ablösung **nicht** nach Backend-Code portiert,
sondern ehrlich stillgelegt. Begründung je Workflow + nachprüfbarer Mini-Status
(Stand 2026-06-09, per n8n-API gegen die Mini-Instanz verifiziert).

| Workflow | Mini-Status (live) | Entscheidung | Begründung |
|---|---|---|---|
| **WF0 – product_slot_id Backfill** | **existiert nicht mehr** (nicht in der Mini-WF-Liste) | DROP | Einmaliger Backfill der `product_slot_id`/`product_slot_key`-Spalte aus der Sheets-Ära. Bereits ausgeführt und abgeschlossen; kein wiederkehrender Prozess. Auf dem Mini schon entfernt. |
| **WF-Update-Check** | inaktiv (`active=false`) | DROP | n8n-spezifischer Self-Update-/Versions-Check der n8n-Instanz. Hat im Backend (Render-Cron + Code) keine Entsprechung und keinen Zweck. |
| **WF-Drift-Check** | aktiv | DROP | n8n-spezifischer Konsistenz-/Drift-Check Sheets↔PG. Die DB-Konsistenzprüfung ist in Slice 1 bereits als `lib/jobs/db-validation.js` portiert (Worker-Cron); der Sheets-Vergleich entfällt, weil Sheets als Schreibschicht abgelöst ist. |

## Marker im Export

Jede der drei lokalen WF-JSONs trägt ein ASCII-Feld `"_stillgelegt"` (oben), das die
Stilllegung dokumentiert. ASCII bewusst, damit der Encoding-Guard
(`dashboard/tests/encoding-umlaut-fix.test.js`, U+FFFD/Mojibake) nicht anschlägt.

## Deploy-/Ops-Schritt (vom Betreiber auszuführen)

Code-seitig ist nichts zu tun (kein Port). Auf der Mini-Instanz:

- **WF-Drift-Check** deaktivieren (n8n UI/API), sobald `db-validation.js` als
  verbindlich gilt. (WF0/WF-Update-Check sind bereits weg bzw. inaktiv.)
- Rückweg: Workflow in n8n wieder aktivieren — solange `BYPASSRLS` (n8n_app) bis
  Slice 4 besteht, jederzeit reversibel.
