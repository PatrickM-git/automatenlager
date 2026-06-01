'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const v3js = fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'), 'utf8');
const v3css = fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.css'), 'utf8');

test('AC-WO1: /lager-Loader lädt den Viewer (Admin-Gating)', () => {
  // Im Lager-Zweig wird /api/dashboard mitgeladen und canTriggerActions gesetzt.
  assert.ok(/_lagerCanEdit\s*=\s*!!viewer\.canTriggerActions/.test(v3js));
});

test('AC-WO2: Karten-Mapping reicht batch_key durch', () => {
  assert.ok(/batch_key:\s*String\(r\.batch_key/.test(v3js));
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
  assert.ok(/mountSlotDialog\(/.test(block.slice(0, 1600)));
});

test('AC-WO7: CSS für den Aussortieren-Knopf vorhanden', () => {
  assert.ok(/\.v3-lager-card__writeoff\s*\{/.test(v3css));
});
