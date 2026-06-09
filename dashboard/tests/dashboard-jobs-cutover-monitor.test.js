'use strict';

/**
 * Cutover-Readiness-Wächter (Stufe 6, Slice 3 → #198). Zählt deckungsgleiche
 * Schattenläufe MIT Aktivität und mailt bei Erreichen der Schwelle. Read-only
 * gegenüber den Domänendaten; nur Streak-Persistenz in workflow_state.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const cm = require('../lib/jobs/cutover-monitor.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── Ebene 1: updateStreak ────────────────────────────────────────────────────
test('#198 updateStreak: keine Aktivität ⇒ Stand unverändert (vakuös zählt nicht)', () => {
  const r = cm.updateStreak({ streak: 3, alerted: false }, { equal: true, hadActivity: false }, 7);
  assert.deepEqual(r.state, { streak: 3, alerted: false });
  assert.equal(r.shouldAlert, false);
});

test('#198 updateStreak: deckungsgleich + Aktivität ⇒ +1; ungleich ⇒ Reset', () => {
  assert.equal(cm.updateStreak({ streak: 3, alerted: false }, { equal: true, hadActivity: true }, 7).state.streak, 4);
  assert.deepEqual(cm.updateStreak({ streak: 5, alerted: false }, { equal: false, hadActivity: true }, 7).state, { streak: 0, alerted: false });
});

test('#198 updateStreak: Schwelle erreicht ⇒ shouldAlert genau EINMAL (alerted verhindert Spam)', () => {
  const first = cm.updateStreak({ streak: 6, alerted: false }, { equal: true, hadActivity: true }, 7);
  assert.equal(first.state.streak, 7);
  assert.equal(first.shouldAlert, true);
  assert.equal(first.state.alerted, true);
  const second = cm.updateStreak(first.state, { equal: true, hadActivity: true }, 7);
  assert.equal(second.state.streak, 8);
  assert.equal(second.shouldAlert, false, 'kein erneuter Alarm');
});

test('#198 buildReadinessMail: Subject + Text nennen Label, Streak, nächsten Schritt', () => {
  const m = cm.buildReadinessMail('WF3 Nayax-Verkäufe', 7, 7);
  assert.match(m.subject, /WF3 Nayax-Verkäufe/);
  assert.match(m.text, /WF3_CUTOVER/);
});

// ── Ebene 2: Job-Orchestrierung mit In-Memory-Fakes (Mail nach 7 Läufen) ──────
function inMemoryDb() {
  const store = new Map(); // key: `${tenant}#${workflow_key}` → state_json
  const door = (tenant) => ({
    read: async ({ params }) => {
      const v = store.get(`${tenant}#${params[0]}`);
      return { rows: v ? [{ state_json: v }] : [] };
    },
    write: async ({ params }) => { store.set(`${tenant}#${params[0]}`, JSON.parse(params[1])); return { rowCount: 1 }; },
  });
  return {
    forTenant: (t) => door(t),
    tx: async (t, fn) => fn(door(t)),
    _store: store,
  };
}

test('#198 createCutoverMonitorJob: 7 deckungsgleiche aktive Läufe ⇒ genau eine Mail', async () => {
  const db = inMemoryDb();
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const job = { run: async () => ({ mode: 'shadow', equal: true, fetched: 3 }) }; // immer gleich + Aktivität
  const monitor = cm.createCutoverMonitorJob({
    db, env: { CUTOVER_STREAK_THRESHOLD: '7', DASHBOARD_ALERT_EMAIL: 'x@y.z' }, mailer,
    checks: [{ streakKey: 'CUTOVER_STREAK_WF3', label: 'WF3', tenant: 'acme', job }],
  });
  for (let i = 0; i < 8; i++) await monitor.run();
  assert.equal(sent.length, 1, 'genau eine Mail beim Erreichen der Schwelle');
});

test('#198 createCutoverMonitorJob: Diff ⇒ feldgenaue Diff-Mail genau einmal (dedupe), Serie resettet', async () => {
  const db = inMemoryDb();
  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const sample = { sales: { counts: { onlyIntended: 1, onlyActual: 0, mismatched: 0 }, onlyIntended: ['T9'], onlyActual: [], mismatched: [] } };
  const job = { run: async () => ({ mode: 'shadow', equal: false, fetched: 2, diffSample: sample }) };
  const monitor = cm.createCutoverMonitorJob({ db, env: { DASHBOARD_ALERT_EMAIL: 'x@y.z' }, mailer, checks: [{ streakKey: 'K', label: 'WF3', tenant: 'acme', job }] });
  await monitor.run();
  await monitor.run(); // identischer Diff ⇒ keine zweite Mail
  assert.equal(sent.length, 1, 'Diff-Mail nur bei neuem/geändertem Diff');
  assert.match(sent[0].subject, /Schatten-Diff/);
  assert.equal((db._store.get('acme#K') || {}).streak, 0, 'Serie bei Diff zurückgesetzt');
});

test('#198 createCutoverMonitorJob: Cutover-/skip-Ergebnis wird nicht als Streak gewertet', async () => {
  const db = inMemoryDb();
  const mailer = { send: async () => {} };
  const job = { run: async () => ({ mode: 'cutover', salesWritten: 2 }) };
  const monitor = cm.createCutoverMonitorJob({ db, env: {}, mailer, checks: [{ streakKey: 'K', label: 'WF3', tenant: 'acme', job }] });
  const r = await monitor.run();
  assert.equal(r.results[0].skipped, 'not_shadow');
});

// ── Ebene 2: Live Streak-Roundtrip durch die Tür ─────────────────────────────
test('#198 readStreak/writeStreak LIVE: Roundtrip durch die Tür (workflow_state.state_json)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    assert.deepEqual(await cm.readStreak(db, 'acme', 'CUTOVER_STREAK_TEST'), { streak: 0, alerted: false }, 'Default ohne Zeile');
    await cm.writeStreak(db, 'acme', 'CUTOVER_STREAK_TEST', { streak: 4, alerted: false });
    assert.deepEqual(await cm.readStreak(db, 'acme', 'CUTOVER_STREAK_TEST'), { streak: 4, alerted: false });
  });
});
