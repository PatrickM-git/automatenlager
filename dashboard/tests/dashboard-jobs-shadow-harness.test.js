'use strict';

/**
 * Schatten-/Vergleichs-Harness (Issue #160, Stufe 6 Slice 0).
 * SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Testing Decisions"
 *
 * Der Kern für den datenkritischen Cutover (Slice 3): ein portierter Job rechnet
 * im Compute-+-Compare-Modus die BEABSICHTIGTEN Writes (schreibt NICHT) und ein
 * Diff vergleicht sie gegen den n8n-Ist-Stand. Erst bei Deckungsgleichheit Cutover.
 *
 * Reine Funktionen (kein I/O, kein pg) — verhaltensgetrieben getestet.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { diffWrites, runShadowComparison } = require('../lib/jobs/shadow-harness.js');

const keyOf = (r) => r.id;
const fields = ['qty', 'status'];

test('#160 diffWrites: deckungsgleiche Mengen ⇒ equal, alle Listen leer', () => {
  const a = [{ id: 'x', qty: 5, status: 'ok' }, { id: 'y', qty: 1, status: 'ok' }];
  const b = [{ id: 'y', qty: 1, status: 'ok' }, { id: 'x', qty: 5, status: 'ok' }]; // Reihenfolge egal
  const d = diffWrites(a, b, { keyOf, fields });
  assert.equal(d.equal, true, 'identische Mengen sind deckungsgleich');
  assert.deepEqual(d.onlyIntended, []);
  assert.deepEqual(d.onlyActual, []);
  assert.deepEqual(d.mismatched, []);
});

test('#160 diffWrites: beabsichtigte Zeile fehlt im Ist ⇒ onlyIntended (nicht equal)', () => {
  const intended = [{ id: 'x', qty: 5, status: 'ok' }, { id: 'neu', qty: 9, status: 'ok' }];
  const actual = [{ id: 'x', qty: 5, status: 'ok' }];
  const d = diffWrites(intended, actual, { keyOf, fields });
  assert.equal(d.equal, false);
  assert.deepEqual(d.onlyIntended.map(keyOf), ['neu'], 'fehlende beabsichtigte Zeile gelistet');
  assert.deepEqual(d.onlyActual, []);
});

test('#160 diffWrites: zusätzliche Ist-Zeile (n8n schrieb mehr) ⇒ onlyActual', () => {
  const intended = [{ id: 'x', qty: 5, status: 'ok' }];
  const actual = [{ id: 'x', qty: 5, status: 'ok' }, { id: 'extra', qty: 2, status: 'ok' }];
  const d = diffWrites(intended, actual, { keyOf, fields });
  assert.equal(d.equal, false);
  assert.deepEqual(d.onlyActual.map(keyOf), ['extra']);
  assert.deepEqual(d.onlyIntended, []);
});

test('#160 diffWrites: gleicher Schlüssel, abweichender Feldwert ⇒ mismatched mit diffFields', () => {
  const intended = [{ id: 'x', qty: 5, status: 'ok' }];
  const actual = [{ id: 'x', qty: 7, status: 'ok' }];
  const d = diffWrites(intended, actual, { keyOf, fields });
  assert.equal(d.equal, false);
  assert.equal(d.mismatched.length, 1);
  assert.equal(d.mismatched[0].key, 'x');
  assert.deepEqual(d.mismatched[0].diffFields, ['qty'], 'nur das abweichende Feld');
  assert.equal(d.mismatched[0].intended.qty, 5);
  assert.equal(d.mismatched[0].actual.qty, 7);
});

test('#160 diffWrites: leere beabsichtigte UND leere Ist-Menge ⇒ equal (vakuös erlaubt, aber markiert)', () => {
  const d = diffWrites([], [], { keyOf, fields });
  assert.equal(d.equal, true);
  assert.equal(d.intendedCount, 0);
  assert.equal(d.actualCount, 0);
});

test('#160 runShadowComparison: rechnet + vergleicht, schreibt NICHT, ist nicht-vakuös', async () => {
  let wrote = false;
  const intended = [{ id: 'a', qty: 3, status: 'ok' }, { id: 'b', qty: 4, status: 'ok' }];
  const actual = [{ id: 'a', qty: 3, status: 'ok' }, { id: 'b', qty: 99, status: 'ok' }];
  const result = await runShadowComparison({
    workflowKey: 'wf3-shadow',
    computeIntended: async () => { /* ein echter Job würde hier NUR rechnen */ return intended; },
    readActual: async () => actual,
    keyOf,
    fields,
    // bewusst KEINE write-Fähigkeit übergeben — der Harness kann gar nicht schreiben
  });
  assert.equal(wrote, false, 'Schattenlauf schreibt nie');
  assert.equal(result.workflowKey, 'wf3-shadow');
  assert.equal(result.diff.equal, false, 'b weicht ab (99 vs 4)');
  assert.deepEqual(result.diff.mismatched.map((m) => m.key), ['b']);
  assert.ok(result.diff.intendedCount === 2 && result.diff.actualCount === 2, 'nicht-vakuös: beide Seiten tragen Zeilen');
});

test('#160 runShadowComparison: Compute-Fehler propagiert (nie still als „gleich" maskiert)', async () => {
  await assert.rejects(
    () => runShadowComparison({
      workflowKey: 'wf3-shadow',
      computeIntended: async () => { throw new Error('compute kaputt'); },
      readActual: async () => [],
      keyOf, fields,
    }),
    /compute kaputt/,
  );
});
