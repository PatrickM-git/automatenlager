'use strict';

// TDD für Issue #51 (AC4): economics.js muss `unit_cost_net` als NETTO verrechnen,
// konsistent zur kanonischen Definition in lib/guv-ek.js. Lock gegen ein
// versehentliches Einführen einer MwSt-Division (Brutto-Annahme) im Live-FIFO.

const assert = require('node:assert/strict');
const test = require('node:test');

const { fifoProvisionalCostForProduct } = require('../lib/economics.js');
const { wareneinsatzNet } = require('../lib/guv-ek.js');

test('fifoProvisionalCostForProduct nimmt unit_cost_net direkt (netto) = wareneinsatzNet', () => {
  // Eine voll verbrauchte Charge: 64 Stück Snickers à 0,48 netto.
  const batches = [{ batch_id: 1, initial_qty: 64, remaining_qty: 0, unit_cost_net: 0.48, received_at: '2026-05-20' }];
  const res = fifoProvisionalCostForProduct(batches, 64);
  assert.equal(res.cost, wareneinsatzNet(64, 0.48)); // 30,72
  assert.equal(res.cost, 30.72);
});

test('economics.js dividiert NICHT durch (1+mwst) — kein Brutto-Missverständnis', () => {
  const batches = [{ batch_id: 1, initial_qty: 10, remaining_qty: 0, unit_cost_net: 1.07, received_at: '2026-05-20' }];
  const res = fifoProvisionalCostForProduct(batches, 10);
  assert.equal(res.cost, 10.7);          // 10 * 1,07 (netto as-is)
  assert.notEqual(res.cost, 10.0);       // wäre 10 * (1,07/1,07) bei falscher Brutto-Division
});
