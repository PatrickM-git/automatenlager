'use strict';

/**
 * Finanzieller Preflight-Trockenlauf für das GuV-Restatement (Issue #177).
 * SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md §"Preflight-Erweiterung"
 *
 * Reine, verhaltensgetriebene Tests des Report-Kerns + Exit-Code-Gate sowie ein
 * Live-Smoke gegen die echte Mini-DB (read-only, in der Rollback-Sandbox, mit 0028).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildRestatementPreflightReport, decideExitCode, classifyRow } = require('../lib/guv-restatement-preflight.js');
const { buildEffectiveConfig, sanitizeOverride } = require('../lib/category-config.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

const eff = buildEffectiveConfig(sanitizeOverride({})); // snack 7 %, getraenk 19 %, default 19 %

// Netto-gebuchte Beispielzeile (USt abgezogen ⇒ revenue_net < revenue_gross).
const nettoRow = (over = {}) => ({
  guv_key: 'k1', source: 'wf8_guv_aggregator', cost_basis: null,
  cost_of_goods: 10, revenue_gross: 100, revenue_net: 93.46, category: 'snack', ...over,
});

test('#177 Report: Zeilen je source + je cost_basis + NULL-Zähler', () => {
  const rep = buildRestatementPreflightReport({
    rows: [
      nettoRow({ guv_key: 'a' }),
      nettoRow({ guv_key: 'b', cost_basis: 'netto' }),
      nettoRow({ guv_key: 'c', cost_basis: 'brutto' }),
      nettoRow({ guv_key: 'd', source: 'historic_backfill' }),
    ],
    kleinunternehmer: false, effConfig: eff, products: [],
  });
  assert.equal(rep.bySource.wf8_guv_aggregator, 3);
  assert.equal(rep.bySource.historic_backfill, 1);
  assert.equal(rep.byCostBasis.netto, 1);
  assert.equal(rep.byCostBasis.brutto, 1);
  assert.equal(rep.byCostBasis.null, 2);
  assert.equal(rep.nullCostBasisCount, 2);
});

test('#177 Klassifizierung: USt abgezogen ⇒ sicher netto; revenue_net==gross mit MwSt ⇒ brutto-implizierend', () => {
  const safe = classifyRow(nettoRow(), eff);
  assert.equal(safe.safeNetto, true);
  assert.equal(safe.bruttoImplying, false);

  const anomaly = classifyRow(nettoRow({ revenue_net: 100 }), eff); // == gross, snack 7 %
  assert.equal(anomaly.bruttoImplying, true);
  assert.equal(anomaly.safeNetto, false);

  // MwSt 0 (unbekannte Kategorie mit 0?-Fall hier nicht; teste explizit 0 über revenue gleich + catMwst 0):
  const zero = classifyRow({ ...nettoRow(), category: 'snack', revenue_net: 100, revenue_gross: 100, cost_basis: 'netto' }, eff);
  assert.equal(zero.isNull, false, 'nicht-NULL ⇒ keine Neuklassifizierung');
});

test('#177 Report nennt sichere netto-Kandidaten und unklare (brutto-implizierende) Keys', () => {
  const rep = buildRestatementPreflightReport({
    rows: [nettoRow({ guv_key: 'safe' }), nettoRow({ guv_key: 'unklar', revenue_net: 100 })],
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.deepEqual(rep.safeNettoKeys, ['safe']);
  assert.deepEqual(rep.unclearKeys, ['unklar']);
  assert.equal(rep.bruttoImplyingNullCount, 1);
});

test('#177 KU-Kandidaten + Nicht-KU-brutto-Anomalie', () => {
  const repKu = buildRestatementPreflightReport({
    rows: [nettoRow({ guv_key: 'a' }), nettoRow({ guv_key: 'b', cost_basis: 'netto' })],
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.equal(repKu.kuNettoCandidateCount, 2, 'KU: netto-Marker + sicher-netto NULL sind Kandidaten');
  assert.equal(repKu.nonKuBruttoCount, 0);

  const repReg = buildRestatementPreflightReport({
    rows: [nettoRow({ guv_key: 'c', cost_basis: 'brutto' })],
    kleinunternehmer: false, effConfig: eff, products: [],
  });
  assert.equal(repReg.kuNettoCandidateCount, 0, 'regelbesteuert ⇒ keine Kandidaten');
  assert.equal(repReg.nonKuBruttoCount, 1, 'brutto bei Nicht-KU ⇒ Anomalie');
});

test('#177 simulierte Σ neuer COGS + Gross-Profit-Differenz (gleicher costBasisMultiplier-Pfad)', () => {
  const rep = buildRestatementPreflightReport({
    rows: [
      nettoRow({ guv_key: 'snack', category: 'snack', cost_of_goods: 10 }),       // ×1,07 → 10,70
      nettoRow({ guv_key: 'drink', category: 'getraenk', cost_of_goods: 10 }),    // ×1,19 → 11,90
    ],
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.equal(rep.sumOldCogs, 20);
  assert.equal(rep.simSumNewCogs, 22.6, '10,70 + 11,90');
  assert.equal(rep.simGrossProfitDelta, -2.6, 'Gewinn sinkt um die Mehrkosten');
});

test('#177 Top-N größte Einzel-Differenzen je guv_key, nach Betrag sortiert', () => {
  const rep = buildRestatementPreflightReport({
    rows: [
      nettoRow({ guv_key: 'klein', category: 'snack', cost_of_goods: 1 }),    // diff 0,07
      nettoRow({ guv_key: 'gross', category: 'getraenk', cost_of_goods: 100 }), // diff 19,00
    ],
    kleinunternehmer: true, effConfig: eff, products: [], topN: 1,
  });
  assert.equal(rep.topDiffs.length, 1);
  assert.equal(rep.topDiffs[0].guv_key, 'gross', 'größte Differenz zuerst');
  assert.equal(rep.topDiffs[0].diff, 19);
});

test('#177 historic_backfill ohne auflösbare Kategorie wird separat gezählt', () => {
  const rep = buildRestatementPreflightReport({
    rows: [
      nettoRow({ guv_key: 'hb', source: 'historic_backfill', category: 'gibtsnicht' }), // Default 19 %
      nettoRow({ guv_key: 'hb2', source: 'historic_backfill', category: 'snack' }),      // auflösbar
    ],
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.equal(rep.historicBackfillNoCategoryCount, 1);
});

test('#177 Reconciliation: vat_rate_pct vs. Kategorie-Satz — Übereinstimmung + Abweichungen', () => {
  const rep = buildRestatementPreflightReport({
    rows: [],
    kleinunternehmer: true, effConfig: eff,
    products: [
      { product_key: 'p_ok', category: 'snack', vat_rate_pct: 7 },        // match
      { product_key: 'p_bad', category: 'getraenk', vat_rate_pct: 7 },    // 7 != 19
      { product_key: 'p_null', category: 'snack', vat_rate_pct: null },   // kein Legacy-Wert ⇒ mismatch
    ],
  });
  assert.equal(rep.reconciliation.length, 3);
  assert.equal(rep.reconciliation.find((r) => r.product_key === 'p_ok').match, true);
  const mism = rep.reconciliationMismatches.map((r) => r.product_key).sort();
  assert.deepEqual(mism, ['p_bad', 'p_null']);
});

test('#177 Exit-Code-Gate: 0 freigabefähig, 1 harte Anomalie, 2 Warnung (Vorrang 1>2>0)', () => {
  const clean = buildRestatementPreflightReport({
    rows: [nettoRow()], kleinunternehmer: true, effConfig: eff,
    products: [{ product_key: 'p', category: 'snack', vat_rate_pct: 7 }],
  });
  assert.equal(decideExitCode(clean), 0);

  const warn = buildRestatementPreflightReport({
    rows: [nettoRow({ source: 'historic_backfill', category: 'gibtsnicht' })],
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.equal(decideExitCode(warn), 2, 'historic_backfill ohne Kategorie ⇒ Warnung');

  const hard = buildRestatementPreflightReport({
    rows: [nettoRow({ revenue_net: 100 })], // brutto-implizierende NULL-Zeile
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.equal(decideExitCode(hard), 1);

  // Vorrang: harte Anomalie UND Warnung gleichzeitig ⇒ 1.
  const both = buildRestatementPreflightReport({
    rows: [nettoRow({ revenue_net: 100 }), nettoRow({ guv_key: 'x', source: 'historic_backfill', category: 'gibtsnicht' })],
    kleinunternehmer: true, effConfig: eff, products: [],
  });
  assert.equal(decideExitCode(both), 1, 'harte Anomalie hat Vorrang vor Warnung');
});

// ── Live-Smoke (read-only, Rollback-Sandbox, mit cost_basis-Spalte aus 0028) ─────

test('#177 LIVE: Bestand je source/cost_basis + reproduzierbarer Exit-Code (read-only)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28); // cost_basis-Spalte (auf dem Mini noch nicht deployt)

    const gather = async () => {
      const rows = (await client.query(
        `SELECT gd.guv_key, gd.source, gd.cost_basis,
                gd.cost_of_goods, gd.revenue_gross, gd.revenue_net,
                p.category AS category
           FROM automatenlager.guv_daily gd
           LEFT JOIN automatenlager.products p ON p.product_id = gd.product_id AND p.tenant_id = gd.tenant_id`)).rows;
      const products = (await client.query(
        `SELECT product_key, category, vat_rate_pct FROM automatenlager.products`)).rows;
      const cfg = (await client.query(
        `SELECT config FROM automatenlager.classification_settings WHERE tenant_id='__default__'`)).rows[0];
      return { rows, products, config: (cfg && cfg.config) || {} };
    };

    const { readKleinunternehmer } = require('../lib/guv-ek.js');
    const data = await gather();
    const report = buildRestatementPreflightReport({
      rows: data.rows,
      kleinunternehmer: readKleinunternehmer(data.config),
      effConfig: buildEffectiveConfig(sanitizeOverride(data.config)),
      products: data.products,
    });
    assert.equal(typeof report.bySource, 'object', 'liefert Bestand je source');
    assert.equal(typeof report.byCostBasis.null, 'number');
    assert.equal(report.rowCount, data.rows.length);

    const code1 = decideExitCode(report);
    assert.ok([0, 1, 2].includes(code1), 'Exit-Code ist 0/1/2');
    // Reproduzierbar: zweiter Lauf auf unveränderter (Rollback-)DB ⇒ derselbe Code.
    const report2 = buildRestatementPreflightReport({
      rows: (await gather()).rows,
      kleinunternehmer: readKleinunternehmer(data.config),
      effConfig: buildEffectiveConfig(sanitizeOverride(data.config)),
      products: data.products,
    });
    assert.equal(decideExitCode(report2), code1, 'Exit-Code reproduzierbar');
  });
});
