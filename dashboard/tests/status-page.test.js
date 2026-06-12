'use strict';

/**
 * Issue #219 (Cloud-Slice 5) — Statusseite: Gesundheits-Aggregation.
 * ------------------------------------------------------------------
 * Reine Auswertung (DB-/HTTP-frei): aus /health-Flags + den letzten Job-Läufen
 * (audit.workflow_runs) einen Gesamtstatus + je-Job-Frische ableiten. Ein Job
 * gilt als „stale", wenn sein letzter Lauf älter als sein erwartetes Intervall
 * (+ Toleranz) ist; als „error", wenn der letzte Lauf fehlschlug.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildStatus, JOB_EXPECTATIONS } = require('../lib/status-page.js');

const NOW = new Date('2026-06-12T12:00:00Z');

function run(key, status, minutesAgo) {
  return { workflow_key: key, status, finished_at: new Date(NOW.getTime() - minutesAgo * 60000).toISOString() };
}

test('#219 alles frisch + DB/Backend ok ⇒ overall ok', () => {
  const s = buildStatus({
    health: { ok: true, tenantDirectoryReady: true, pgConfigured: true },
    jobRuns: [run('wf3-nayax-fifo', 'success', 3), run('anomaly-monitor', 'success', 10), run('backup-supabase', 'success', 120)],
    now: NOW,
  });
  assert.equal(s.overall, 'ok');
  assert.equal(s.components.backend.status, 'ok');
  assert.equal(s.components.database.status, 'ok');
  const wf3 = s.components.jobs.find((j) => j.key === 'wf3-nayax-fifo');
  assert.equal(wf3.status, 'ok');
});

test('#219 letzter Job-Lauf fehlgeschlagen ⇒ Job error ⇒ overall degraded', () => {
  const s = buildStatus({
    health: { ok: true, tenantDirectoryReady: true, pgConfigured: true },
    jobRuns: [run('wf3-nayax-fifo', 'error', 3)],
    now: NOW,
  });
  const wf3 = s.components.jobs.find((j) => j.key === 'wf3-nayax-fifo');
  assert.equal(wf3.status, 'error');
  assert.equal(s.overall, 'degraded');
});

test('#219 Job überfällig (älter als Intervall+Toleranz) ⇒ stale ⇒ degraded', () => {
  // wf3 erwartet alle 5 Min; 30 Min her ⇒ stale.
  const s = buildStatus({
    health: { ok: true, tenantDirectoryReady: true, pgConfigured: true },
    jobRuns: [run('wf3-nayax-fifo', 'success', 30)],
    now: NOW,
  });
  const wf3 = s.components.jobs.find((j) => j.key === 'wf3-nayax-fifo');
  assert.equal(wf3.status, 'stale');
  assert.equal(s.overall, 'degraded');
});

test('#219 Job ohne jeden Lauf ⇒ unknown (nicht hart error — frischer Start)', () => {
  const s = buildStatus({
    health: { ok: true, tenantDirectoryReady: true, pgConfigured: true },
    jobRuns: [],
    now: NOW,
  });
  const wf3 = s.components.jobs.find((j) => j.key === 'wf3-nayax-fifo');
  assert.equal(wf3.status, 'unknown');
  assert.equal(wf3.lastRun, null);
});

test('#219 Backend/DB nicht bereit ⇒ overall down (überschreibt Job-Status)', () => {
  const s = buildStatus({
    health: { ok: false, tenantDirectoryReady: false, pgConfigured: true },
    jobRuns: [run('wf3-nayax-fifo', 'success', 3)],
    now: NOW,
  });
  assert.equal(s.components.backend.status, 'down');
  assert.equal(s.overall, 'down');
});

test('#219 nur überwachte Jobs zählen für den Gesamtstatus (nicht jeder Worker-Tick)', () => {
  // Ein nicht-erwarteter Job (z. B. einmaliger Backfill) kippt den Status nicht.
  assert.ok(JOB_EXPECTATIONS['wf3-nayax-fifo'], 'wf3 ist erwartet');
  assert.equal(JOB_EXPECTATIONS['wf-guv-backfill'], undefined, 'Backfill ist NICHT statusrelevant');
  const s = buildStatus({
    health: { ok: true, tenantDirectoryReady: true, pgConfigured: true },
    jobRuns: [run('wf3-nayax-fifo', 'success', 3), run('wf-guv-backfill', 'error', 1)],
    now: NOW,
  });
  assert.equal(s.overall, 'ok', 'nicht-überwachter Job-Fehler kippt den Status nicht');
});
