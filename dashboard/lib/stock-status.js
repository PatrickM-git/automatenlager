'use strict';

/**
 * Einzige Quelle der Wahrheit: welche `stock_batches.status`-Werte als
 * VERFÜGBARER Bestand zählen.
 *
 * Hintergrund (Session 31, 2026-06-01): `stock_batches.status` ist ein
 * Freitext-Feld. Die Workflows schreiben `aktiv`/`active`, aus manuellen
 * Sheet-Einträgen stammen zusätzlich `reserve`, `ausgesondert`, `leer` und
 * `wartet_nachkauf`. Die Dashboard-Queries kannten bisher nur `aktiv`/`active`
 * (an einer Stelle sogar nur `aktiv`) — dadurch war eine `reserve`-Charge
 * (z. B. Pick Up, 22 Stk.) im Backstock unsichtbar (Bestand 0 statt 22),
 * obwohl die Menge sauber in der DB lag. Mit dieser Konstante zählen alle
 * Bestands-Queries dieselben Status.
 *
 * Bewusst NICHT verfügbar: `ausgesondert` (ausgebucht), `leer` (0),
 * `wartet_nachkauf` (0) — diese bleiben korrekt ausgeblendet.
 *
 * Hinweis: Die Bedeutung von `remaining_qty` (Gesamtbestand vs. Lager-only)
 * ist zwischen WF7/WF3/Dashboard noch uneinheitlich — das ist ein separates
 * Datenmodell-Thema (dokumentiert in docs/data-model/remaining-qty-semantics.md)
 * und wird hier NICHT angefasst. Diese Konstante regelt nur, WELCHE Chargen
 * zählen. Verwandtes Invariant „inaktive Slots zählen nie als Bestand": siehe
 * tests/dashboard-inactive-slot-stock-invariant.test.js.
 */

const AVAILABLE_BATCH_STATUSES = ['aktiv', 'active', 'reserve'];

/**
 * Prüft einen Status-Wert (JS-seitig, z. B. in lib/refill.js).
 * `null`/leer gilt als verfügbar (Alt-Daten ohne gesetzten Status).
 */
function isAvailableBatchStatus(status) {
  if (status == null || status === '') return true;
  return AVAILABLE_BATCH_STATUSES.includes(String(status).trim().toLowerCase());
}

/**
 * SQL-Fragment für rohe Queries, z. B. `WHERE sb.status IN (${availableBatchStatusSqlList()})`.
 * Liefert: `'aktiv', 'active', 'reserve'`. Werte sind hartcodierte Konstanten
 * (keine User-Eingabe) → keine Injection.
 */
function availableBatchStatusSqlList() {
  return AVAILABLE_BATCH_STATUSES.map((s) => `'${s}'`).join(', ');
}

module.exports = {
  AVAILABLE_BATCH_STATUSES,
  isAvailableBatchStatus,
  availableBatchStatusSqlList,
};
