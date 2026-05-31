'use strict';
const assert = require('node:assert/strict');
const test   = require('node:test');

const { resolvePgUrl } = require('../lib/pg-url.js');

const PG = 'postgresql://u:p@127.0.0.1:15432/homelab';
const ALT = 'postgresql://u:p@127.0.0.1:15432/other';

/* ---- AC-PG1: process.env hat Vorrang vor .env.local ---------------------- */
test('AC-PG1: process.env.DASHBOARD_V2_PG_URL wins over the .env.local value', () => {
  const got = resolvePgUrl({ DASHBOARD_V2_PG_URL: PG }, { DASHBOARD_V2_PG_URL: ALT });
  assert.equal(got, PG);
});

/* ---- AC-PG2: Fallback auf .env.local, wenn process.env leer -------------- */
test('AC-PG2: falls back to the .env.local value when process.env has none', () => {
  const got = resolvePgUrl({}, { DASHBOARD_V2_PG_URL: PG });
  assert.equal(got, PG);
});

/* ---- AC-PG3: Aliase POSTGRES_URL / DATABASE_URL -------------------------- */
test('AC-PG3: recognises POSTGRES_URL and DATABASE_URL aliases from .env.local', () => {
  assert.equal(resolvePgUrl({}, { POSTGRES_URL: PG }), PG);
  assert.equal(resolvePgUrl({}, { DATABASE_URL: PG }), PG);
});

test('AC-PG3b: process.env alias still beats .env.local primary key', () => {
  assert.equal(resolvePgUrl({ POSTGRES_URL: PG }, { DASHBOARD_V2_PG_URL: ALT }), PG);
});

/* ---- AC-PG4: nichts gesetzt -> leerer String (PG_UNCONFIGURED) ----------- */
test('AC-PG4: returns empty string when nothing is configured', () => {
  assert.equal(resolvePgUrl({}, {}), '');
  assert.equal(resolvePgUrl(undefined, undefined), '');
});

/* ---- AC-PG5: trimmt Whitespace ------------------------------------------- */
test('AC-PG5: trims surrounding whitespace', () => {
  assert.equal(resolvePgUrl({ DASHBOARD_V2_PG_URL: '  ' + PG + '  ' }, {}), PG);
});

/* ---- AC-PG6: explizit gesetzter (auch leerer) Wert hat Vorrang ----------- */
/* Schützt den Test-Vertrag: `DASHBOARD_V2_PG_URL=''` erzwingt „unkonfiguriert"
   und darf NICHT auf die echte .env.local zurückfallen. Der Fallback greift
   nur, wenn der Schlüssel in der Prozess-Umgebung komplett fehlt. */
test('AC-PG6: an explicit (even empty) process.env value wins over .env.local', () => {
  assert.equal(resolvePgUrl({ DASHBOARD_V2_PG_URL: '' }, { DASHBOARD_V2_PG_URL: PG }), '');
});

test('AC-PG6b: only an ABSENT process key triggers the .env.local fallback', () => {
  assert.equal(resolvePgUrl({ N8N_API_KEY: 'x' }, { DASHBOARD_V2_PG_URL: PG }), PG);
});
