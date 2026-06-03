'use strict';

// TDD für Issue #51 (AC2/AC3): Contract-/Drift-Guard für WF8.
//
// WF8 (Node „Code - GuV aggregieren") behandelte `unit_cost` fälschlich als
// BRUTTO und leitete ek_preis_netto per `/(1+mwst)` ab — inkonsistent zu
// WF2/economics.js (die unit_cost als netto lesen) und zum gebuchten
// cost_of_goods. Dieser Guard fixiert die vereinheitlichte Netto-Definition und
// verhindert ein Zurückfallen auf die Brutto-Annahme.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const WF8_PATH = path.join(__dirname, '..', '..', 'WF8 - GuV Tagesposten Aggregator.json');

function aggregatorCodes() {
  const wf = JSON.parse(fs.readFileSync(WF8_PATH, 'utf8'));
  const codes = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.name === 'Code - GuV aggregieren' && o.parameters && o.parameters.jsCode) {
        codes.push(o.parameters.jsCode);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(wf);
  return codes;
}

test('WF8 enthält die Aggregator-Node mit jsCode', () => {
  const codes = aggregatorCodes();
  assert.ok(codes.length >= 1, 'Node „Code - GuV aggregieren" mit jsCode nicht gefunden');
});

test('WF8 behandelt unit_cost als NETTO, nicht als brutto (AC2)', () => {
  for (const code of aggregatorCodes()) {
    // ekNetto kommt direkt aus unit_cost (netto), nicht aus einer Division.
    assert.match(code, /ekNetto\s*=\s*num\(\s*firstBatch\.unit_cost\s*\)/,
      'ek-Netto muss direkt aus firstBatch.unit_cost (netto) stammen');
    // ek-Brutto wird durch AUFschlagen der MwSt abgeleitet (Multiplikation).
    assert.match(code, /ekBrutto\s*=\s*[^;\n]*ekNetto\s*\*\s*\(\s*1\s*\+\s*mwstEinkauf\s*\/\s*100\s*\)/,
      'ek-Brutto muss netto * (1 + mwst/100) sein');
  }
});

test('WF8 enthält NICHT mehr die alte Brutto->Netto-Division (Anti-Regression, AC3)', () => {
  for (const code of aggregatorCodes()) {
    assert.doesNotMatch(code, /ekNetto\s*=\s*[^;\n]*ekBrutto\s*\/\s*\(\s*1\s*\+\s*mwstEinkauf/,
      'alte Logik ekNetto = ekBrutto/(1+mwst) darf nicht zurückkehren');
    assert.doesNotMatch(code, /ekBrutto\s*=\s*num\(\s*firstBatch\.unit_cost\s*\)/,
      'unit_cost darf nicht direkt als ek-Brutto interpretiert werden');
  }
});

test('WF8 bucht Wareneinsatz auf Netto-Basis (cost_of_goods unverändert, AC3/AC5)', () => {
  for (const code of aggregatorCodes()) {
    assert.match(code, /warenein\s*=\s*qty\s*\*\s*ekNetto/,
      'Wareneinsatz muss qty * ekNetto (netto) sein -> cost_of_goods bleibt wie bisher menge*unit_cost');
  }
});
