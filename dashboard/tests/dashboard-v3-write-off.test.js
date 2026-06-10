'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const v3js = fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'), 'utf8');
const v3css = fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.css'), 'utf8');

test('AC-WO1: /lager-Loader setzt das Admin-Gating aus /api/v2/batches', () => {
  // Gating-Quelle ist die /api/v2/batches-Antwort (canTriggerActions) — /lager
  // lädt bewusst NICHT mehr /api/dashboard (4s-n8n-Timeout, #209).
  assert.ok(/_lagerCanEdit\s*=\s*!!\(batchEk\s*&&\s*batchEk\.canTriggerActions\)/.test(v3js));
});

test('AC-WO2: Tabellen-Zeile reicht batch_key als data-Attribut durch', () => {
  // Lager nutzt jetzt eine Tabelle statt Karten; batch_key wird als data-batch-key
  // auf den Aussortieren-Button geschrieben.
  assert.ok(/data-batch-key.*esc\(b\.batch_key\)/.test(v3js), 'data-batch-key im Button-HTML');
});

test('AC-WO3: Aussortieren-Knopf nur für Admins gerendert', () => {
  assert.ok(/_lagerCanEdit\s*&&\s*card\.batch_key/.test(v3js));
  assert.ok(/data-writeoff-btn/.test(v3js));
});

test('AC-WO4: Knopf-Binding ist in renderRoute verdrahtet', () => {
  assert.ok(/bindLagerWriteOff\(\)/.test(v3js));
});

test('AC-WO5: Dialog postet an den Write-off-Endpoint mit Guard', () => {
  assert.ok(/postJson\(\s*'\/api\/v2\/inventory\/write-off'/.test(v3js));
  assert.ok(/expected_remaining_qty/.test(v3js));
});

test('AC-WO6: Dialog wird auf document.body portiert (mountSlotDialog)', () => {
  // openWriteOffDialog nutzt mountSlotDialog -> Portal (transform-Vorfahr-Falle)
  const block = v3js.slice(v3js.indexOf('function openWriteOffDialog'));
  assert.ok(/mountSlotDialog\(/.test(block.slice(0, 2200)));
});

test('AC-WO7: CSS für den Aussortieren-Knopf vorhanden', () => {
  assert.ok(/\.v3-lager-card__writeoff\s*\{/.test(v3css));
});
