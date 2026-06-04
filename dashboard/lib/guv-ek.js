'use strict';

// Issue #51: EINE eindeutige EK-Semantik für `Lagerchargen.unit_cost` /
// `stock_batches.unit_cost_net`.
//
// DEFINITION (am Rechnungsbeleg 20.05.2026 belegt): der Wert ist NETTO.
// Die Lieferanten-Rechnung weist Stückpreise netto aus (Summe der Zeilen =
// NETTO-WARENWERT; MwSt wird erst darunter addiert). Beispiel Snickers:
// STÜCK INT KD PREIS 0,480 netto (Steuergruppe B = 7 %) -> steht so im Sheet.
//
// Konsequenz für alle Verbraucher:
//  - WF2 schreibt unit_cost direkt nach unit_cost_net -> korrekt (netto).
//  - economics.js verrechnet unit_cost_net direkt als Wareneinsatz -> korrekt.
//  - WF8 muss den Wert ebenfalls als netto behandeln: ek_preis_netto = unit_cost,
//    ek_preis_brutto = unit_cost * (1 + mwst/100). Der gebuchte Wareneinsatz
//    (cost_of_goods) bleibt menge * unit_cost (netto-Basis) und damit unverändert.

function toNum(value) {
  const n = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Aus dem Netto-Einkaufspreis die konsistenten netto/brutto-Werte ableiten.
// `unitCostNet` ist netto; `mwstSatz` in Prozent (z. B. 7 oder 19).
function ekFromNet(unitCostNet, mwstSatz) {
  const net = toNum(unitCostNet);
  const rate = toNum(mwstSatz);
  if (net <= 0) return { ekNetto: 0, ekBrutto: 0 };
  const brutto = rate > 0 ? net * (1 + rate / 100) : net;
  return { ekNetto: round4(net), ekBrutto: round4(brutto) };
}

// Gebuchter Wareneinsatz auf Netto-Basis (= guv_daily.cost_of_goods).
// Bewusst menge * netto-EK, damit cost_of_goods unverändert zur bisherigen
// Buchung bleibt (keine Verschiebung historischer GuV-Werte).
function wareneinsatzNet(qty, unitCostNet) {
  const q = toNum(qty);
  const net = toNum(unitCostNet);
  if (q <= 0 || net <= 0) return 0;
  return round2(q * net);
}

// Issue #56: Wirtschaftlicher Wareneinsatz je nach Besteuerungsmodell.
// EINE gemeinsame Basis für economics.js (Live) und WF8 (guv_daily), damit
// derselbe Slot/Posten nie unterschiedlich bewertet wird.
//   - regelbesteuert (Default): netto — Vorsteuer wird erstattet, netto ist
//     der echte Aufwand. Identisch zu wareneinsatzNet (keine Verschiebung).
//   - Kleinunternehmer (§19 UStG): brutto — gezahlte MwSt ist echte, nicht
//     erstattete Kosten -> netto-EK × (1 + mwst/100).
// `mwstSatz` in Prozent (z. B. 7 oder 19). Fehlt eine gültige MwSt, wird NICHT
// erfunden -> Rückfall auf netto (kein geratener Aufschlag).
function wareneinsatzCostBasis(qty, unitCostNet, mwstSatz, opts = {}) {
  const q = toNum(qty);
  const net = toNum(unitCostNet);
  if (q <= 0 || net <= 0) return 0;
  const rate = toNum(mwstSatz);
  const kleinunternehmer = !!(opts && opts.kleinunternehmer);
  const unit = kleinunternehmer && rate > 0 ? net * (1 + rate / 100) : net;
  return round2(q * unit);
}

module.exports = { ekFromNet, wareneinsatzNet, wareneinsatzCostBasis, toNum, round2, round4 };
