'use strict';

/**
 * Invariant-Guard: Bestandswirksame Lagerchargen MÜSSEN einen Einkaufspreis tragen.
 * ------------------------------------------------------------------------------
 * Invariant:
 *   "Jede bestandswirksame Charge (status ∈ {aktiv, active, reserve} oder leer)
 *    MUSS unit_cost_net > 0 haben."
 *
 * Hintergrund: WF2 legt Chargen aus Rechnungsvorschlägen an. Im Node
 * „Prepare PGW – WF2 Product+Batch" wird der EK mit `Number(item.unit_cost) || 0`
 * gesetzt — fehlt der Preis upstream, landet stillschweigend 0 in der DB
 * (`unit_cost_net = 0`). Folge: FIFO-Verkäufe aus so einer Charge buchen
 * Wareneinsatz 0 → scheinbar 100 % Marge in der Live-„heute"-Ansicht
 * (dashboard/lib/economics.js). Ein solcher Vorfall trat real auf: 4 Chargen
 * (Erdnüsse/Snickers/Cola Zero/Red Bull, Rechnung 20.05.2026) kamen ohne EK in
 * die DB, obwohl das Quell-Sheet die Preise hatte.
 *
 * Dieser Guard nagelt fest, dass keine bestandswirksame Charge ohne EK existiert,
 * damit der nächste solche Drift sofort und präzise auffällt — statt erst über
 * verzerrte GuV-Kennzahlen. Status-Definition wird aus lib/stock-status.js
 * wiederverwendet (single source of truth). Verwandtes read-side-Invariant
 * „inaktive Slots zählen nie als Bestand": tests/dashboard-inactive-slot-stock-invariant.test.js.
 *
 * Verwendet von:
 *   - tests/dashboard-stock-cost-invariant.test.js  (Guard; überspringt offline)
 *   - GET /api/v2/_diagnostics/stock-cost           (Laufzeit-Report, Admin)
 *   - Startup-Check in server.js                    (Log-Warnung beim Start)
 *
 * Reine Detektion — der Guard ändert keine Daten (Projektregel: keine
 * automatischen Lager-Patches). Gefundene Chargen werden nur gemeldet.
 */

const { availableBatchStatusSqlList } = require('./stock-status.js');

const SCHEMA = 'automatenlager';

// Bestandswirksam = Status in der kanonischen „verfügbar"-Liste ODER leer/NULL
// (Alt-Daten ohne gesetzten Status gelten als verfügbar, vgl. isAvailableBatchStatus).
// Die Status-Werte sind hartcodierte Konstanten (keine User-Eingabe) → keine Injection.
const OFFENDERS_SQL = `
  SELECT batch_id, product_id, batch_key, unit_cost_net, remaining_qty, status, received_at
    FROM ${SCHEMA}.stock_batches
   WHERE coalesce(unit_cost_net, 0) <= 0
     AND (status IS NULL
          OR btrim(status) = ''
          OR lower(btrim(status)) IN (${availableBatchStatusSqlList()}))
   ORDER BY received_at DESC, batch_id DESC`;

/**
 * Führt den Invariant-Check gegen eine offene pg-Client-Verbindung aus.
 * Liefert { healthy, offenders, checkedAt } — wirft nur bei DB-Fehlern.
 */
async function runStockCostCheck(client) {
  const res = await client.query(OFFENDERS_SQL);
  const offenders = res.rows.map((r) => ({
    batchId: Number(r.batch_id),
    productId: Number(r.product_id),
    batchKey: r.batch_key,
    unitCostNet: Number(r.unit_cost_net),
    remainingQty: Number(r.remaining_qty),
    status: r.status,
    receivedAt: r.received_at,
  }));
  return {
    healthy: offenders.length === 0,
    offenders,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  OFFENDERS_SQL,
  runStockCostCheck,
};
