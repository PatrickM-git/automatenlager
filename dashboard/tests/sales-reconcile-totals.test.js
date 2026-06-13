'use strict';

// #229 — Täglicher Moma↔DB-Reconciliation-Alarm. Reiner Vergleichskern, test-first.
// Check A (Import-Vollständigkeit): Nayax/Moma-Tagessumme vs. sales_transactions.
// Check B (Buchungs-Vollständigkeit): sales_transactions vs. guv_daily.

const assert = require('node:assert/strict');
const test = require('node:test');
const { reconcileDailyTotals } = require('../lib/jobs/sales-reconcile-totals.js');

test('#229 keine Abweichung -> keine Alarme', () => {
  const r = reconcileDailyTotals({
    salesByDay: { '2026-06-08': 19.80, '2026-06-09': 11.90 },
    guvByDay: { '2026-06-08': 19.80, '2026-06-09': 11.90 },
    nayaxByDay: { '2026-06-08': 19.80, '2026-06-09': 11.90 },
  });
  assert.equal(r.alerts.length, 0);
});

test('#229 Check B (Buchungsluecke): sales > guv ueber Schwelle -> bookingDelta-Alarm', () => {
  const r = reconcileDailyTotals({
    salesByDay: { '2026-06-08': 19.80 },
    guvByDay: { '2026-06-08': 17.60 }, // GuV 2,20 zu niedrig (Einfrier-Bug-Klasse #228)
    nayaxByDay: { '2026-06-08': 19.80 },
  });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].date, '2026-06-08');
  assert.equal(r.alerts[0].bookingDelta, 2.2);
});

test('#229 Check A (Importluecke): nayax > sales ueber Schwelle -> importDelta-Alarm', () => {
  const r = reconcileDailyTotals({
    salesByDay: { '2026-06-08': 17.60 }, // 2,20 fehlen im Import (wie real am 08.06.)
    guvByDay: { '2026-06-08': 17.60 },
    nayaxByDay: { '2026-06-08': 19.80 }, // Moma-Wahrheit
  });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].importDelta, 2.2);
});

test('#229 Toleranz: Abweichung <= Schwelle -> kein Alarm (Rundung)', () => {
  const r = reconcileDailyTotals({
    salesByDay: { '2026-06-08': 19.80 },
    guvByDay: { '2026-06-08': 19.79 }, // 1 Cent
    nayaxByDay: { '2026-06-08': 19.80 },
    thresholdEur: 0.01,
  });
  assert.equal(r.alerts.length, 0, '1 Cent ist innerhalb der Toleranz');
});

test('#229 ausserhalb des Nayax-Fensters: importDelta null, Buchungs-Check trotzdem aktiv', () => {
  const r = reconcileDailyTotals({
    salesByDay: { '2026-05-01': 50.00 },
    guvByDay: { '2026-05-01': 48.00 }, // Buchungsluecke
    nayaxByDay: {}, // alter Tag, nicht im Nayax-Fenster
  });
  assert.equal(r.days[0].importDelta, null, 'kein Nayax-Wert -> importDelta null');
  assert.equal(r.alerts.length, 1, 'Buchungsluecke trotzdem erkannt');
  assert.equal(r.alerts[0].importDelta, null);
  assert.equal(r.alerts[0].bookingDelta, 2.0);
});

test('#229 buildReconcileEmail: fasst Alarme menschenlesbar zusammen', () => {
  const { buildReconcileEmail } = require('../lib/jobs/sales-reconcile-totals.js');
  const mail = buildReconcileEmail([
    { date: '2026-06-08', importDelta: 2.2, bookingDelta: null },
  ], 't_faltrix');
  assert.match(mail.subject, /Reconciliation|Abweichung/i);
  assert.match(mail.text, /2026-06-08/);
  assert.match(mail.text, /2[,.]2/);
});
