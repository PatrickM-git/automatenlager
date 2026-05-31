# SPEC: Nayax Bestand-Drift-Fix (Live-Re-Verankerung)

Status: Entwurf · Erstellt 2026-05-31 · Bezug: Issue #1 (Bestand-Drift)

## Problem

Das Dashboard zeigt pro Slot `current_machine_qty`. Dieser Wert wird seit dem
Cutover (2026-05-02) **selbst fortgeschrieben** und nie gegen die Realität
re-verankert. WF3 (`Code - FIFO berechnen`) zählt anhand der Nayax-`lastSales`
hoch/runter, hat aber stille Nicht-Abzug-Pfade. Ergebnis: messbare Drift
(Stand 2026-05-31, Automat 457107528: 27 von 40 Slots weichen ab, meist zeigt
das Dashboard zu viel).

## Verifizierte Datenkette (read-only, 2026-05-31)

```
Nayax lastSales
  → WF3 "Code - FIFO berechnen"   (zählt current_machine_qty selbst)
  → WF3 "Produktbestand Update"   (schreibt Sheet Produkte.current_machine_qty)
  → Sync Sheet → PG automatenlager.slot_assignments.current_machine_qty
  → Dashboard  (lib/assortment-slots.js → queryAssortmentSlotsPg)
```

Match-Schlüssel durchgängig: **machine_id + mdb_code**.

## Verifizierte Wahrheitsquelle (Nayax-Live, getestet 2026-05-31)

- `GET https://lynx.nayax.com/operational/v1/machines/{machine_id}/machineProducts`
  liefert je Slot u.a. `MDBCode, PAR, MissingStockByMDB, MissingStockByDEX, MDBMissingStockLastUpdated`.
- **On-Hand (Ist-Bestand) = `PAR − MissingStockByMDB`.**
- **NUR MDB verwenden, NIE DEX** — `MissingStockByDEX` ist bei allen 40 Slots 0
  (DEX ungepflegt); DEX würde alle Slots fälschlich als „voll" zeigen.
- `pickList` ist ohne erzeugte Moma-Pickliste leer → unbrauchbar.
- Credential (n8n, Mini): httpHeaderAuth `6JLrl6bb2ns3ISYe` ("Nayax Lynx API").
- WF3 echte ID auf Mini: `wbOhFKXQqBpJWB1w`.

## Lösung — phasenweise

### Phase 1 — Drift-Report (read-only, KEINE Schreibvorgänge)

Ziel: Drift sichtbar machen, bevor irgendetwas geschrieben wird.

Reihenfolge (User-Entscheid: „Beides"):

1. **Dashboard-Ansicht** (zuerst)
   - Neuer Mini-Workflow „WF-Nayax-Bestand" (Webhook GET) auf der HP Mini, der
     `machineProducts` für eine `machine_id` abruft und je Slot
     `{ mdb_code, product_name, par, missing_mdb, on_hand, last_update }` zurückgibt.
     Self-contained, read-only, nutzt Credential `6JLrl6bb2ns3ISYe`.
   - Dashboard: neuer read-only Endpunkt `GET /api/v2/nayax/stock-drift?machine=<key>`
     - ruft den Mini-Webhook über eine neue env-Variable `NAYAX_STOCK_WEBHOOK_URL`
       auf. Diese ist noch NICHT vorhanden und wird neu eingeführt — analog zum
       bestehenden Muster `INVOICE_UPLOAD_WEBHOOK_URL` (server.js:87,
       `directWebhookEnv`, Session 24): optionaler fester Webhook-Override,
       unabhängig von `N8N_BASE_URL`,
     - liest die Dashboard-Sicht via `queryAssortmentSlotsPg`,
     - joint per `machine_id + mdb_code` und liefert je Slot
       `{ mdb_code, product, dashboard_qty, nayax_on_hand, diff }` + Summen.
   - Logik test-first in `dashboard/lib/nayax-stock-drift.js`
     (reine Funktion `buildStockDrift(pgSlots, nayaxItems)`), Test
     `dashboard/tests/dashboard-v2-nayax-stock-drift.test.js`.
   - Frontend: read-only Drift-Tabelle, v3-design-konsistent (Tokens/Klassen
     wiederverwenden, Vanilla-JS/SVG). Filter pro Automat (parametrisch).
   - `.env.example`: `NAYAX_STOCK_WEBHOOK_URL=` dokumentieren.

2. **Mail-Report** (später)
   - Täglicher Mini-Workflow (Pattern wie WF-Val): berechnet die Drift,
     mailt eine Slot-Liste der Abweichungen.

### Phase 2 — Re-Anchor (schreibend) — NOCH OFFEN

Bewusst nicht festgelegt; erst Report aus Phase 1 ansehen. Leitplanken stehen
fest:
- Setzt `current_machine_qty` aus On-Hand (`PAR − MissingStockByMDB`),
- **nur über bestehende idempotente Pfade** (kein neuer Roh-Schreibpfad),
- mit Audit-Trail,
- **nur MDB, nie DEX**,
- Google-Sheets-Lagerdaten nie ohne explizite Freigabe,
- je Automat parametrisch (machine_id), perspektivisch mandantenfähig.

## Nicht-Ziele

- Keine Änderung an v2/Legacy (streng additiv).
- Keine produktive Änderung an Nayax/Moma.
- Phase 2 wird in dieser SPEC nicht final entworfen.

## Offene Fragen

- Latenz einer manuellen Moma-Füllstandsänderung bis `machineProducts` (für
  spätere Auto-Re-Anchor-Taktung relevant).
- Umgang mit Slots, die im Dashboard, aber nicht (mehr) in Nayax sind und
  umgekehrt (nur melden vs. anlegen).
