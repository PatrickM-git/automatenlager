'use strict';
// #34: MHD-Risiko-Fenster ist in /einstellungen editierbar (v3-Optik) + in der Config.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG, mergeConfig, sanitizeOverride } = require('../lib/category-config.js');

test('mhdRiskDays in DEFAULT_CONFIG (30) + Override/Sanitize', () => {
  assert.equal(DEFAULT_CONFIG.mhdRiskDays, 30);
  assert.equal(mergeConfig().mhdRiskDays, 30);
  assert.equal(mergeConfig({ mhdRiskDays: 14 }).mhdRiskDays, 14);
  assert.equal(sanitizeOverride({ mhdRiskDays: '21' }).mhdRiskDays, 21);
});

test('v3 /einstellungen rendert das MHD-Risiko-Fenster-Feld (data-set-key mhdRiskDays)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'), 'utf8');
  assert.match(src, /numField\('MHD-Risiko-Fenster \(Tage\)', 'mhdRiskDays'/);
});
