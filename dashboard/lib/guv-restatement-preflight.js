'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY finanzieller Trockenlauf für das GuV-Restatement (Issue #177).
// SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
//       §"Preflight-Erweiterung" + §"cost_basis-Marker & Klassifizierung"
//
// REINER Kern (kein I/O): nimmt bereits gelesene guv_daily-Zeilen (+ Produkt-
// Kategorie/vat_rate_pct) und liefert den Report + ein Exit-Code-Gate. Der Runner
// (tools/preflight-guv-daily.js) liest die Daten und ruft diese Funktionen — er
// schreibt nichts (ausschließlich SELECT/Katalog).
//
// Die simulierte neue Kostenbasis nutzt EXAKT denselben Pfad wie der korrigierte
// Nacht-Job: resolveCategory(...).mwstPct → costBasisMultiplier (keine zweite Formel).
// ─────────────────────────────────────────────────────────────────────────────

const { costBasisMultiplier } = require('./guv-ek.js');
const { resolveCategory } = require('./category-config.js');

function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Klassifiziert EINE Zeile gegen die effektive Kategorie-Config.
//   - catMwst:        kanonischer Kategorie-MwSt-Satz (Fallback defaultMwstPct).
//   - categoryKnown:  ob die Kategorie auflösbar war (sonst Default-Faktor sichtbar).
//   - safeNetto:      NULL-Marker-Zeile, die sicher als netto klassifizierbar ist
//                     (USt wurde abgezogen ⇒ revenue_net < revenue_gross; oder MwSt 0).
//   - bruttoImplying: NULL-Marker-Zeile, die BRUTTO impliziert (revenue_net == gross
//                     trotz MwSt > 0) ⇒ harte Anomalie, NICHT blind restaten.
function classifyRow(row, effConfig) {
  const cat = resolveCategory(effConfig, row.category);
  const catMwst = cat.mwstPct;
  const revGross = round2(toNum(row.revenue_gross));
  const revNet = round2(toNum(row.revenue_net));
  const isNull = row.cost_basis == null;
  let safeNetto = false;
  let bruttoImplying = false;
  if (isNull) {
    if (catMwst <= 0) {
      safeNetto = true; // ohne MwSt sind netto und brutto identisch ⇒ unkritisch
    } else if (revNet < revGross) {
      safeNetto = true; // USt wurde abgezogen ⇒ eindeutig netto gebucht
    } else {
      bruttoImplying = true; // revenue_net == gross trotz MwSt ⇒ sieht brutto aus
    }
  }
  return { catMwst, categoryKnown: cat.known, isNull, safeNetto, bruttoImplying };
}

/**
 * Baut den finanziellen Trockenlauf-Report.
 * @param {object} args
 * @param {object[]} args.rows  guv_daily-Zeilen, je: { guv_key, source, cost_basis,
 *        cost_of_goods, revenue_gross, revenue_net, category }
 * @param {boolean} args.kleinunternehmer  effektives KU-Flag (global aus __default__)
 * @param {object}  args.effConfig  buildEffectiveConfig(...) (für resolveCategory)
 * @param {object[]} [args.products]  je Produkt { product_key, category, vat_rate_pct }
 *        für die Reconciliation vat_rate_pct vs. Kategorie-Satz.
 * @param {number}  [args.topN=20]
 */
function buildRestatementPreflightReport({ rows = [], kleinunternehmer = false, effConfig, products = [], topN = 20 } = {}) {
  const bySource = {};
  const byCostBasis = { netto: 0, brutto: 0, null: 0 };
  let nullCostBasisCount = 0;
  let kuNettoCandidateCount = 0;
  let nonKuBruttoCount = 0;
  let bruttoImplyingNullCount = 0;
  let historicBackfillNoCategoryCount = 0;
  const safeNettoKeys = [];
  const unclearKeys = [];

  let sumOldCogs = 0;
  let simSumNewCogs = 0;
  const perKeyDiff = [];

  for (const row of rows) {
    const source = row.source == null ? '(null)' : String(row.source);
    bySource[source] = (bySource[source] || 0) + 1;

    const cb = row.cost_basis == null ? 'null' : String(row.cost_basis);
    if (cb === 'netto') byCostBasis.netto++;
    else if (cb === 'brutto') byCostBasis.brutto++;
    else { byCostBasis.null++; nullCostBasisCount++; }

    const cls = classifyRow(row, effConfig);

    // Anomalie: Nicht-KU-Mandant, aber Zeile als brutto markiert (erwartet 0).
    if (cb === 'brutto' && !kleinunternehmer) nonKuBruttoCount++;
    // Harte Anomalie: NULL-Zeile, die brutto impliziert.
    if (cls.bruttoImplying) { bruttoImplyingNullCount++; unclearKeys.push(row.guv_key); }
    else if (cls.isNull) safeNettoKeys.push(row.guv_key);

    if (source === 'historic_backfill' && !cls.categoryKnown) historicBackfillNoCategoryCount++;

    // Restatement-Kandidaten = effektiv KU UND (netto markiert ODER sicher-netto NULL).
    const isNettoBasis = cb === 'netto' || (cls.isNull && cls.safeNetto);
    if (kleinunternehmer && isNettoBasis) {
      kuNettoCandidateCount++;
      const oldCogs = round2(toNum(row.cost_of_goods));
      const newCogs = round2(oldCogs * costBasisMultiplier(cls.catMwst, { kleinunternehmer: true }));
      sumOldCogs += oldCogs;
      simSumNewCogs += newCogs;
      perKeyDiff.push({ guv_key: row.guv_key, source, catMwst: cls.catMwst, old_cogs: oldCogs, new_cogs: newCogs, diff: round2(newCogs - oldCogs) });
    }
  }

  sumOldCogs = round2(sumOldCogs);
  simSumNewCogs = round2(simSumNewCogs);
  // Höhere Kosten ⇒ Gewinn SINKT ⇒ Differenz ist negativ.
  const simGrossProfitDelta = round2(sumOldCogs - simSumNewCogs);

  const topDiffs = perKeyDiff
    .slice()
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, topN);

  // Reconciliation je Produkt: vat_rate_pct vs. Kategorie-Satz (erwartet identisch).
  const reconciliation = [];
  for (const p of products) {
    const cat = resolveCategory(effConfig, p.category);
    const legacy = p.vat_rate_pct == null ? null : toNum(p.vat_rate_pct);
    const match = legacy != null && Math.abs(legacy - cat.mwstPct) < 0.001;
    reconciliation.push({ product_key: p.product_key, category: p.category, vat_rate_pct: legacy, category_mwst: cat.mwstPct, category_known: cat.known, match });
  }
  const reconciliationMismatches = reconciliation.filter((r) => !r.match);

  return {
    bySource,
    byCostBasis,
    nullCostBasisCount,
    kuNettoCandidateCount,
    nonKuBruttoCount,
    bruttoImplyingNullCount,
    historicBackfillNoCategoryCount,
    safeNettoKeys,
    unclearKeys,
    sumOldCogs,
    simSumNewCogs,
    simGrossProfitDelta,
    topDiffs,
    reconciliation,
    reconciliationMismatches,
    kleinunternehmer,
    rowCount: rows.length,
  };
}

/**
 * Exit-Code-Gate (für CI-/Deploy-Doku referenzierbar):
 *   0 = freigabefähig (alles eindeutig, keine Anomalie)
 *   1 = HARTE Anomalie (Nicht-KU-Zeile mit brutto ODER brutto-implizierende NULL-Zeile)
 *       ⇒ Restatement blockiert
 *   2 = WARNUNG / manuelle Prüfung (vat_rate_pct↔Kategorie-Abweichung ODER
 *       historic_backfill ohne auflösbare Kategorie)
 * Vorrang: 1 vor 2 vor 0.
 */
function decideExitCode(report) {
  if (report.nonKuBruttoCount > 0 || report.bruttoImplyingNullCount > 0) return 1;
  if (report.reconciliationMismatches.length > 0 || report.historicBackfillNoCategoryCount > 0) return 2;
  return 0;
}

module.exports = { classifyRow, buildRestatementPreflightReport, decideExitCode, round2 };
