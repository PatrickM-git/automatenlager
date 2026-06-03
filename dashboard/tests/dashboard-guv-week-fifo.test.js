'use strict';

// Anpassungswünsche GuV-Seite:
//  - KW-/Wochenauswahl + taggenauer eigener Zeitraum  -> resolveDateRange
//  - echte GuV/Marge inkl. heute via sequenzieller FIFO-Bewertung
//    -> fifoProvisionalCostForProduct + buildEconomicsData(provisional mit cost)

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveDateRange,
  isoWeekStart,
  isoWeeksInYear,
  fifoProvisionalCostForProduct,
  buildEconomicsData,
} = require('../lib/economics.js');

function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* ---- ISO-Kalenderwochen --------------------------------------------------- */

test('isoWeekStart: KW 1/2026 beginnt Mo 2025-12-29 (Woche enthält den 4. Januar)', () => {
  assert.equal(ymd(isoWeekStart(2026, 1)), '2025-12-29');
});

test('isoWeekStart: KW 23/2026 beginnt Mo 2026-06-01', () => {
  assert.equal(ymd(isoWeekStart(2026, 23)), '2026-06-01');
});

test('isoWeeksInYear: 2026 hat 53 Wochen, 2025 hat 52', () => {
  assert.equal(isoWeeksInYear(2026), 53);
  assert.equal(isoWeeksInYear(2025), 52);
});

/* ---- resolveDateRange ----------------------------------------------------- */

test('resolveDateRange mode=week liefert Mo–So der KW, granularity=day', () => {
  const r = resolveDateRange({ mode: 'week', year: '2026', week: '23' });
  assert.deepEqual(
    { fromDate: r.fromDate, toDate: r.toDate, granularity: r.granularity },
    { fromDate: '2026-06-01', toDate: '2026-06-07', granularity: 'day' },
  );
});

test('resolveDateRange mode=custom taggenau gibt die exakten Tage zurück (granularity=day bei kurzer Spanne)', () => {
  const r = resolveDateRange({ mode: 'custom', from: '2026-06-02', to: '2026-06-10' });
  assert.equal(r.fromDate, '2026-06-02');
  assert.equal(r.toDate, '2026-06-10');
  assert.equal(r.granularity, 'day');
});

test('resolveDateRange mode=custom dreht vertauschte Grenzen', () => {
  const r = resolveDateRange({ mode: 'custom', from: '2026-06-10', to: '2026-06-02' });
  assert.equal(r.fromDate, '2026-06-02');
  assert.equal(r.toDate, '2026-06-10');
});

test('resolveDateRange mode=custom über >45 Tage schaltet auf granularity=month', () => {
  const r = resolveDateRange({ mode: 'custom', from: '2026-01-01', to: '2026-06-30' });
  assert.equal(r.granularity, 'month');
});

test('resolveDateRange mode=month liefert echte Monatsränder (erster–letzter Tag)', () => {
  const r = resolveDateRange({ mode: 'month', from: '2026-02', to: '2026-02' });
  assert.equal(r.fromDate, '2026-02-01');
  assert.equal(r.toDate, '2026-02-28'); // 2026 ist kein Schaltjahr
  assert.equal(r.granularity, 'day');
});

test('resolveDateRange mode=quarter Q2 -> 01.04. bis 30.06., granularity=month', () => {
  const r = resolveDateRange({ mode: 'quarter', year: '2026', quarter: '2' });
  assert.equal(r.fromDate, '2026-04-01');
  assert.equal(r.toDate, '2026-06-30');
  assert.equal(r.granularity, 'month');
});

/* ---- sequenzielle FIFO-Bewertung ----------------------------------------- */

test('FIFO: heutige Menge wird gegen die Frontier-Charge bewertet (Normalfall)', () => {
  const batches = [
    { batch_id: 33, initial_qty: 18, remaining_qty: 2, unit_cost_net: '0.8782', received_at: '2026-05-01' },
    { batch_id: 205, initial_qty: 33, remaining_qty: 33, unit_cost_net: '0.7140', received_at: '2026-05-28' },
  ];
  const r = fifoProvisionalCostForProduct(batches, 2);
  assert.equal(r.cost, 1.76); // 2 × 0.8782 = 1.7564 -> 1.76
  assert.equal(r.complete, true);
});

test('FIFO: Menge greift über die Frontier hinaus in die ältere (geleerte) Charge zurück', () => {
  const batches = [
    { batch_id: 1, initial_qty: 10, remaining_qty: 0, unit_cost_net: '1.00', received_at: '2026-04-01' },
    { batch_id: 2, initial_qty: 5, remaining_qty: 3, unit_cost_net: '2.00', received_at: '2026-05-01' },
  ];
  // Zuletzt verbraucht: 2 Stk. aus Charge 2 (frontier), davor aus Charge 1.
  const r = fifoProvisionalCostForProduct(batches, 3);
  assert.equal(r.cost, 5.0); // 2×2.00 + 1×1.00
  assert.equal(r.complete, true);
});

test('FIFO: noch unberührte neuere Chargen (consumed=0) werden übersprungen', () => {
  const batches = [
    { batch_id: 1, initial_qty: 10, remaining_qty: 4, unit_cost_net: '1.50', received_at: '2026-05-01' },
    { batch_id: 2, initial_qty: 10, remaining_qty: 10, unit_cost_net: '9.99', received_at: '2026-05-20' },
  ];
  const r = fifoProvisionalCostForProduct(batches, 2);
  assert.equal(r.cost, 3.0); // 2×1.50, NICHT die teure unberührte Charge
});

test('FIFO: reicht die verbrauchte Historie nicht, ist complete=false (keine erfundenen Kosten)', () => {
  const batches = [
    { batch_id: 1, initial_qty: 5, remaining_qty: 4, unit_cost_net: '1.00', received_at: '2026-05-01' },
  ];
  const r = fifoProvisionalCostForProduct(batches, 3); // nur 1 Stk. verbraucht
  assert.equal(r.allocated, 1);
  assert.equal(r.complete, false);
  assert.equal(r.cost, 1.0);
});

test('FIFO: ohne Chargen -> Kosten 0, nicht complete', () => {
  const r = fifoProvisionalCostForProduct([], 2);
  assert.equal(r.cost, 0);
  assert.equal(r.complete, false);
});

test('FIFO: Nullkosten-Charge (fehlender EK) -> missingCost=true, KEIN geschätzter Wert', () => {
  // Realfall Snickers: aktive Frontier-Charge ohne EK (unit_cost_net = 0).
  const batches = [
    { batch_id: 3, initial_qty: 17, remaining_qty: 0, unit_cost_net: '0.4815', received_at: '2026-05-01' },
    { batch_id: 49, initial_qty: 64, remaining_qty: 43, unit_cost_net: '0.0000', received_at: '2026-05-19' },
  ];
  const r = fifoProvisionalCostForProduct(batches, 1);
  assert.equal(r.missingCost, true);
  assert.equal(r.cost, 0);        // nichts geschätzt – EK fehlt eben
  assert.equal(r.complete, true); // Menge ist zugeordnet, nur der EK fehlt
});

test('FIFO: bekannter EK -> missingCost=false', () => {
  const batches = [{ batch_id: 1, initial_qty: 10, remaining_qty: 6, unit_cost_net: '1.20', received_at: '2026-05-01' }];
  const r = fifoProvisionalCostForProduct(batches, 2);
  assert.equal(r.missingCost, false);
  assert.equal(r.cost, 2.4);
});

/* ---- buildEconomicsData: vorläufige GuV/Marge inkl. heute ----------------- */

function finalRows() {
  return {
    byProduct: [{
      product_id: 21, product_name: 'Haribo Goldbären',
      month: '2026-06-01', qty: 14, revenue_net: 18.82,
      revenue_gross: 22.40, gross_profit: 9.10, db_net: 7.60,
    }],
  };
}

test('Live-FIFO: provisional mit cost trägt Gewinn -> totalsWithProvisional.gross_profit inkl. heute', () => {
  const data = buildEconomicsData(finalRows({}), { mode: 'month' });
  const withProv = buildEconomicsData({
    ...finalRows(),
    provisional: {
      revenue_gross: 4.80, revenue_net: 4.03, qty: 3, cost: 2.10, costComplete: true,
      byProduct: [{ product_id: 21, product_name: 'Haribo Goldbären', qty: 3, revenue_gross: 4.80, revenue_net: 4.03, cost: 2.10 }],
      from_date: '2026-06-03', to_date: '2026-06-03',
    },
  }, { mode: 'month' });

  // Endgültige Totale bleiben die reine Nacht-Aggregation.
  assert.equal(withProv.totals.gross_profit, 9.10);
  // „inkl. heute": Umsatz, Menge UND Gewinn werden ergänzt.
  assert.equal(withProv.totalsWithProvisional.revenue_gross, 27.20); // 22.40 + 4.80
  assert.equal(withProv.totalsWithProvisional.qty, 17);              // 14 + 3
  assert.equal(withProv.totalsWithProvisional.gross_profit, 11.80);  // 9.10 + (4.80-2.10)
  assert.equal(withProv.provisional.hasCost, true);
  assert.equal(withProv.provisional.grossProfit, 2.70);
  // Ohne provisional bleibt alles bei der Nacht-Aggregation.
  assert.equal(data.totalsWithProvisional.gross_profit, 9.10);
});

test('Live-FIFO: provisional-Produktposten werden in die Top-Produkt-Tabelle gemischt', () => {
  const data = buildEconomicsData({
    ...finalRows(),
    provisional: {
      revenue_gross: 7.20, revenue_net: 6.04, qty: 5, cost: 3.10, costComplete: true,
      byProduct: [
        { product_id: 21, product_name: 'Haribo Goldbären', qty: 3, revenue_gross: 4.80, revenue_net: 4.03, cost: 2.10 },
        { product_id: 99, product_name: 'Neu Heute', qty: 2, revenue_gross: 2.40, revenue_net: 2.01, cost: 1.00 },
      ],
      from_date: '2026-06-03', to_date: '2026-06-03',
    },
  }, { mode: 'month' });

  const haribo = data.byProduct.find((r) => r.product_id === 21);
  assert.equal(haribo.qty, 17);            // 14 + 3
  assert.equal(haribo.revenue_gross, 27.20);
  assert.equal(haribo.gross_profit, 11.80); // 9.10 + 2.70
  const neu = data.byProduct.find((r) => r.product_id === 99);
  assert.ok(neu, 'reines Heute-Produkt erscheint in der Tabelle');
  assert.equal(neu.qty, 2);
  assert.equal(neu.gross_profit, 1.40);     // 2.40 - 1.00
});

test('Live-FIFO: ohne EK (hasCost=false) bleibt die Marge-Basis unangetastet', () => {
  const data = buildEconomicsData({
    ...finalRows(),
    // kein cost-Feld -> EK live nicht zuordenbar
    provisional: { revenue_gross: 100.0, qty: 50, from_date: '2026-06-03', to_date: '2026-06-03' },
  }, { mode: 'month' });
  assert.equal(data.provisional.hasCost, false);
  assert.equal(data.totalsWithProvisional.gross_profit, 9.10); // unverändert
  assert.equal(data.totalsWithProvisional.revenue_gross, 122.40); // Umsatz aber schon inkl.
  // Tabelle NICHT mit Heute gemischt (sonst Marge je Produkt verfälscht).
  assert.equal(data.byProduct.length, 1);
});

/* ---- Frontend (v3.js / v3.css) ------------------------------------------- */

test('AC-UI: v3.js bietet einen Wochen-/KW-Tab mit scrollbarem Dropdown', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /btn\('week', 'Woche'\)/, 'Woche-Tab im Zeitraum-Wähler');
  assert.match(js, /data-guv-week\b/, 'KW-Dropdown markiert');
  assert.match(js, /guvWeekOptions/, 'KW-Optionen werden erzeugt');
  assert.match(js, /currentIsoWeek/, 'aktuelle KW als Default (vorgescrollt)');
});

test('AC-UI: eigener Zeitraum ist taggenau (type="date" statt month)', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /type="date" data-guv-from/, 'Von als Tagesdatum');
  assert.match(js, /type="date" data-guv-to/, 'Bis als Tagesdatum');
});

test('AC-UI: v3.css stylt die KW-Auswahl und stellt den Filter in eine eigene Zeile', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-guv-weekpick/, 'KW-Auswahl-Styling');
  // Automat-Filter: eigene Zeile (volle Breite + Trennlinie), kein unruhiger Umbruch.
  assert.match(css, /\.v3-guv-period__filter\s*\{[\s\S]*?border-top:/, 'Filter in eigener Zeile mit Trennlinie');
});

/* ---- Fehlender Einkaufspreis: ehrlich statt geschätzt ---------------------- */

test('Missing-EK: Posten ohne EK fließt NICHT in GuV/Marge, Zeile als cost_missing markiert', () => {
  const data = buildEconomicsData({
    byProduct: [], // keine Nacht-Aggregation
    provisional: {
      revenue_gross: 4.0, revenue_net: 4.0, qty: 2, cost: 0, costMissing: true,
      byProduct: [{ product_id: 53, product_name: 'Red Bull', qty: 2, revenue_gross: 4.0, revenue_net: 4.0, cost: 0, cost_missing: true }],
      from_date: '2026-06-03', to_date: '2026-06-03',
    },
  }, { mode: 'month' });

  assert.equal(data.costMissing, true);
  // Umsatz/Menge inkl. heute, aber GuV bleibt 0 (kein erfundener Gewinn).
  assert.equal(data.totalsWithProvisional.revenue_gross, 4.0);
  assert.equal(data.totalsWithProvisional.qty, 2);
  assert.equal(data.totalsWithProvisional.gross_profit, 0);
  assert.equal(data.totalsWithProvisional.revenue_gross_costable, 0); // nichts costable
  const rb = data.byProduct.find((r) => r.product_id === 53);
  assert.equal(rb.cost_missing, true);
  assert.equal(rb.margin_gross_pct, null); // Tabelle zeigt „–"
});

test('Missing-EK: gemischt – bekannter Posten zählt, fehlender nicht (Marge-Basis = costable)', () => {
  const data = buildEconomicsData({
    byProduct: [],
    provisional: {
      revenue_gross: 6.0, revenue_net: 6.0, qty: 3,
      byProduct: [
        { product_id: 1, product_name: 'Bekannt', qty: 1, revenue_gross: 2.0, revenue_net: 2.0, cost: 1.0, cost_missing: false },
        { product_id: 2, product_name: 'OhneEK', qty: 2, revenue_gross: 4.0, revenue_net: 4.0, cost: 0, cost_missing: true },
      ],
      from_date: '2026-06-03', to_date: '2026-06-03',
    },
  }, { mode: 'month' });

  assert.equal(data.totalsWithProvisional.revenue_gross, 6.0);          // alle
  assert.equal(data.totalsWithProvisional.gross_profit, 1.0);           // nur bekannter (2-1)
  assert.equal(data.totalsWithProvisional.revenue_gross_costable, 2.0); // nur bekannter Umsatz
  assert.equal(data.costMissing, true);
});

test('missingCostBatches: aktive Chargen ohne EK werden durchgereicht (für das Dashboard-Banner)', () => {
  const data = buildEconomicsData({
    byProduct: [],
    missingCostBatches: [
      { product_id: 5, product_name: 'Snickers', batch_key: 'B_SNICKERS_20260520', remaining_qty: 43 },
      { product_id: 53, product_name: 'Red Bull', batch_key: 'B_RED_BULL_20260520', remaining_qty: 15 },
    ],
  }, { mode: 'month' });
  assert.equal(data.missingCostBatches.length, 2);
  assert.equal(data.missingCostBatches[0].product_name, 'Snickers');
  assert.equal(data.missingCostBatches[0].batch_key, 'B_SNICKERS_20260520');
  assert.equal(data.costMissing, true);
});

test('AC-UI: v3.js zeigt ein Warnbanner für fehlende Einkaufspreise', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /guvMissingCostBanner/, 'Banner-Funktion vorhanden');
  assert.match(js, /missingCostBatches/, 'liest die fehlenden EK-Chargen');
  assert.match(js, /Einkaufspreis fehlt/, 'klarer Hinweistext');
});
