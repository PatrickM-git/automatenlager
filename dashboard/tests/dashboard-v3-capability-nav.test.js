'use strict';
// #29: Die v3-Shell blendet Reiter nach Fähigkeit ein/aus (Komfort; Server erzwingt).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'v3.js'), 'utf8');

test('Routen tragen eine cap (GuV=finanzen.lesen, Einstellungen=system.verwalten)', () => {
  assert.match(SRC, /path:\s*'\/guv'[^}]*cap:\s*'finanzen\.lesen'/);
  assert.match(SRC, /path:\s*'\/einstellungen'[^}]*cap:\s*'system\.verwalten'/);
  assert.match(SRC, /path:\s*'\/onboarding'[^}]*cap:\s*'bestand\.schreiben'/);
});

test('viewerCan + Nav-Filter vorhanden; Caps werden aus /api/dashboard geladen', () => {
  assert.match(SRC, /function viewerCan\(/);
  assert.match(SRC, /ROUTES\.filter\(function \(r\) \{ return viewerCan\(r\.cap\); \}\)/);
  assert.match(SRC, /setViewerCaps\(v\.capabilities\)/);
});

test('Nayax-Übernehmen ist an nayax.schreiben gebunden', () => {
  assert.match(SRC, /viewerCan\('nayax\.schreiben'\)/);
});
