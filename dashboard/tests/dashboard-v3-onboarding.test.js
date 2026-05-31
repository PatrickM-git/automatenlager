'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');

const { buildOnboardingFunnel } = require('../lib/onboarding-flow.js');

/* ====================================================================== */
/* Onboarding-Cockpit (v2-Parität + domänenkorrekt)                       */
/* ====================================================================== */
/* Diese Seite ERFASST keine Stammdaten. Sie nimmt Rechnungen an (Upload ->  */
/* WF1), routet offene Freigaben ins WF2-Formular und stößt unbekannte       */
/* Nayax-Produkte an. Slot-Zuordnung läuft über die Sortiment-Seite.         */

const DATA = {
  total_invoices: 12,
  wf2_form_url: 'http://127.0.0.1:5678/form/wf2',
  pending_approvals: [
    { invoice_key: 'INV-1', invoice_number: '2026-001', supplier_name: 'Lekkerland', invoice_date: '2026-05-20', open_items: 3 },
    { invoice_key: 'INV-2', invoice_number: '2026-002', supplier_name: 'Metro',      invoice_date: '2026-05-22', open_items: 1 },
  ],
  unknown_products: [{ product_key: 'Neu 1', tx_count: 9 }, { product_key: 'Neu 2', tx_count: 3 }],
  products_by_status: {
    intern_erstellt: [{ product_id: 1, name: 'A' }],
    bereit_fur_moma: [{ product_id: 2, name: 'B' }, { product_id: 3, name: 'C' }],
    slot_offen:      [{ product_id: 4, name: 'D' }],
    verkaufsbereit:  [{ product_id: 5, name: 'E' }, { product_id: 6, name: 'F' }, { product_id: 7, name: 'G' }],
  },
};

/* ---- AC-O1: Schlanke Statuszeile – kein „Rechnungen", kein „Slot offen" -- */
test('AC-O1: status stages are Freigabe -> Nayax-Verknüpfung -> Verkaufsbereit', () => {
  const f = buildOnboardingFunnel(DATA);
  assert.deepEqual(f.stages.map((s) => s.key), ['approvals', 'nayax_pending', 'verkaufsbereit']);
  assert.deepEqual(f.stages.map((s) => s.count), [2, 2, 3]);
  // explizit NICHT mehr dabei: invoices/Rechnungen und slot_offen
  assert.ok(!f.stages.some((s) => s.key === 'invoices' || s.key === 'slot_offen'));
});

/* ---- AC-O2: „Nayax-Verknüpfung offen" = bereit_fur_moma ------------------ */
test('AC-O2: nayaxPendingCount maps to the bereit_fur_moma lifecycle state', () => {
  const f = buildOnboardingFunnel(DATA);
  assert.equal(f.nayaxPendingCount, 2);
  assert.equal(f.verkaufsbereitCount, 3);
});

/* ---- AC-O3: Offene Rechnungsfreigaben + WF2-URL durchgereicht ------------ */
test('AC-O3: pending approvals and the WF2 form URL are surfaced', () => {
  const f = buildOnboardingFunnel(DATA);
  assert.equal(f.approvalsCount, 2);
  assert.equal(f.approvals[0].invoice_key, 'INV-1');
  assert.equal(f.wf2FormUrl, 'http://127.0.0.1:5678/form/wf2');
  assert.equal(buildOnboardingFunnel({}).wf2FormUrl, '');
});

/* ---- AC-O4: Unbekannte Nayax-Produkte ------------------------------------ */
test('AC-O4: unknown Nayax products are surfaced', () => {
  const f = buildOnboardingFunnel(DATA);
  assert.equal(f.unknownCount, 2);
  assert.equal(f.unknownProducts[0].product_key, 'Neu 1');
});

/* ---- AC-O5: Robust bei leeren Daten -------------------------------------- */
test('AC-O5: buildOnboardingFunnel handles empty/missing data', () => {
  const f = buildOnboardingFunnel({});
  assert.deepEqual(f.stages.map((s) => s.count), [0, 0, 0]);
  assert.equal(f.approvalsCount, 0);
  assert.equal(f.nayaxPendingCount, 0);
  assert.equal(f.verkaufsbereitCount, 0);
  assert.equal(f.unknownCount, 0);
  assert.equal(buildOnboardingFunnel(undefined).approvalsCount, 0);
});

/* ---- AC-O6: Stammdaten-Stepper bleibt entfernt --------------------------- */
test('AC-O6: the master-data entry stepper stays removed (owned by WF2)', () => {
  const mod = require('../lib/onboarding-flow.js');
  assert.equal(typeof mod.buildOnboardingSteps, 'undefined');
});

/* ====================================================================== */
/* Frontend-Wiring (statische Präsenz)                                    */
/* ====================================================================== */

test('AC-O7: v3.js renders the cockpit and fetches the onboarding data', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /renderOnboardingPage/, 'v3.js must define renderOnboardingPage');
  assert.match(js, /\/api\/v2\/onboarding/, 'v3.js must fetch /api/v2/onboarding');
});

test('AC-O7b: the hollow onboarding-start action (fake green, no webhook wired) is gone', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.doesNotMatch(js, /\/api\/v2\/onboarding\/start\b/, 'the no-op onboarding/start trigger must be removed');
  assert.doesNotMatch(js, /data-onb-start/, 'the misleading "Onboarding anstoßen" button must be removed');
});

test('AC-O8: invoice upload (file/camera) is wired to WF1 via the v2 upload endpoint', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /\/api\/v2\/uploads\/invoice/, 'upload must POST to the invoice upload endpoint');
  assert.match(js, /type="file"/, 'an invoice file input must exist');
  assert.match(js, /accept=/, 'the file input must accept PDF and image types');
  assert.match(js, /FormData/, 'upload must send multipart FormData');
});

test('AC-O9: open approvals route to the WF2 form for data entry', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /wf2FormUrl|wf2_form_url/, 'approvals must route to the WF2 form');
});

test('AC-O10: v3.css defines onboarding + upload classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-onb-/, 'v3.css must define .v3-onb-* classes');
  assert.match(css, /\.v3-onb-upload/, 'v3.css must style the invoice upload card');
});
