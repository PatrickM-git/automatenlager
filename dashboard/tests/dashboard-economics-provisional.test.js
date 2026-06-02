'use strict';

// TDD für Issue #40: GuV-Auswertung um den laufenden Tag erweitern.
// Die GuV-Tabelle/KPIs lesen guv_daily (WF8, 1×/Tag um 02:00). Heutige (und bis
// zum nächsten Nacht-Lauf auch gestrige) Verkäufe fehlen, obwohl sie live in
// sales_transactions stehen -> oben (Live-Kachel #38) und unten (Tabelle) zeigen
// widersprüchliche Zahlen.
//
// Option A (gewählt, kleinste ehrliche Lösung, keine WF-Änderung): die noch nicht
// aggregierten Verkäufe (seit dem letzten guv_daily-Tag) als klar markierte,
// VORLÄUFIGE Position ergänzen — nur Umsatz + Menge. Die Marge bleibt auf den
// endgültigen guv_daily-Zahlen (kein EK live -> keine stille Falsch-Marge).

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildEconomicsData } = require('../lib/economics.js');

function baseRows(extra = {}) {
  // Ein endgültiger guv_daily-Produktposten (Juni-Aggregat aus der Nacht).
  return {
    byProduct: [{
      product_id: 21, product_name: 'Haribo Goldbären',
      month: '2026-06-01', qty: 14, revenue_net: 18.82,
      revenue_gross: 22.40, gross_profit: 9.10, db_net: 7.60,
    }],
    ...extra,
  };
}

test('ohne provisional: totalsWithProvisional == endgültige Totals, provisional.hasProvisional=false', () => {
  const data = buildEconomicsData(baseRows(), { mode: 'month' });
  assert.equal(data.provisional.hasProvisional, false);
  assert.equal(data.totalsWithProvisional.revenue_gross, data.totals.revenue_gross);
  assert.equal(data.totalsWithProvisional.qty, data.totals.qty);
});

test('mit provisional: Umsatz+Menge werden ergänzt, klar als vorläufig markiert', () => {
  const data = buildEconomicsData(baseRows({
    provisional: { revenue_gross: 4.80, qty: 3, from_date: '2026-06-02', to_date: '2026-06-02' },
  }), { mode: 'month' });

  assert.equal(data.provisional.hasProvisional, true);
  assert.equal(data.provisional.revenueGross, 4.80);
  assert.equal(data.provisional.qty, 3);
  assert.equal(data.provisional.fromDate, '2026-06-02');
  assert.equal(data.provisional.toDate, '2026-06-02');

  // Headline-Umsatz/Menge inkl. laufendem Tag (konsistent zur Live-Kachel):
  assert.equal(data.totalsWithProvisional.revenue_gross, 27.20); // 22.40 + 4.80
  assert.equal(data.totalsWithProvisional.qty, 17);              // 14 + 3
});

test('provisional fälscht die Marge NICHT: endgültige Totals (Marge-Basis) bleiben unberührt', () => {
  const withProv = buildEconomicsData(baseRows({
    provisional: { revenue_gross: 100.00, qty: 50, from_date: '2026-06-02', to_date: '2026-06-02' },
  }), { mode: 'month' });

  // gross_profit / db_net (Marge-Basis) stammen NUR aus guv_daily -> unverändert.
  assert.equal(withProv.totals.gross_profit, 9.10);
  assert.equal(withProv.totals.db_net, 7.60);
  assert.equal(withProv.totals.revenue_gross, 22.40, 'endgültiger Umsatz bleibt separat erhalten');
  // Die vorläufige Position trägt keinen Gewinn (EK unbekannt) -> kein margin-Feld.
  assert.ok(!('gross_profit' in data_or(withProv.provisional)), 'provisional ohne Gewinn');
});

function data_or(x) { return x || {}; }

test('provisional mit 0 Umsatz -> hasProvisional=false (nichts Vorläufiges anzeigen)', () => {
  const data = buildEconomicsData(baseRows({
    provisional: { revenue_gross: 0, qty: 0, from_date: null, to_date: null },
  }), { mode: 'month' });
  assert.equal(data.provisional.hasProvisional, false);
  assert.equal(data.totalsWithProvisional.revenue_gross, data.totals.revenue_gross);
});
