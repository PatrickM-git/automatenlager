'use strict';

/**
 * Etappe 3 (H2-Backend-Hälfte, Audit 2026-06-12) — Origin-Schutz.
 * Render soll API-Requests nur akzeptieren, wenn sie durch Cloudflare kamen
 * (Cloudflare injiziert per Transform-Rule einen geheimen Header). Direkter
 * Zugriff auf die *.onrender.com-URL (Cloudflare-Bypass) wird so 403.
 *
 * Reine Entscheidungslogik (DB-/HTTP-frei). Fail-SAFE: ohne konfiguriertes
 * Secret INERT (kein Selbst-Aussperren vor der Cloudflare-Aktivierung).
 * Ausnahmen: /health (Render-Healthcheck) und /internal/ (Supabase-pg_cron mit
 * eigenem WORKER_TRIGGER_SECRET — kommt NICHT über Cloudflare).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { originGuardDecision } = require('../lib/origin-guard.js');

const SECRET = 'cf-origin-secret-xyz-123';

test('#H2 ohne Secret konfiguriert ⇒ INERT (alles erlaubt, kein Aussperren)', () => {
  assert.equal(originGuardDecision({ secret: '', headerValue: '', pathname: '/api/v2/viewer' }).allowed, true);
  assert.equal(originGuardDecision({ secret: null, headerValue: 'x', pathname: '/api/v2/viewer' }).allowed, true);
});

test('#H2 aktiv: korrekter Header ⇒ erlaubt', () => {
  const d = originGuardDecision({ secret: SECRET, headerValue: SECRET, pathname: '/api/v2/viewer' });
  assert.equal(d.allowed, true);
});

test('#H2 aktiv: fehlender/falscher Header ⇒ blockiert (Cloudflare-Bypass dicht)', () => {
  assert.equal(originGuardDecision({ secret: SECRET, headerValue: '', pathname: '/api/v2/viewer' }).allowed, false);
  assert.equal(originGuardDecision({ secret: SECRET, headerValue: 'falsch', pathname: '/api/v2/viewer' }).allowed, false);
  assert.equal(originGuardDecision({ secret: SECRET, headerValue: SECRET + 'x', pathname: '/api/v2/viewer' }).allowed, false);
});

test('#H2 /health ist IMMER ausgenommen (Render-Healthcheck darf nie blocken)', () => {
  assert.equal(originGuardDecision({ secret: SECRET, headerValue: '', pathname: '/health' }).allowed, true);
});

test('#H2 /internal/ ist ausgenommen (pg_cron, eigenes Secret, nicht über Cloudflare)', () => {
  assert.equal(originGuardDecision({ secret: SECRET, headerValue: '', pathname: '/internal/jobs/wf3-nayax-fifo' }).allowed, true);
});

test('#H2 statische Assets + Login + API werden geschützt, wenn aktiv', () => {
  for (const p of ['/v3', '/login', '/api/v2/status', '/config.js', '/']) {
    assert.equal(originGuardDecision({ secret: SECRET, headerValue: 'falsch', pathname: p }).allowed, false, `${p} geschützt`);
    assert.equal(originGuardDecision({ secret: SECRET, headerValue: SECRET, pathname: p }).allowed, true, `${p} mit Header ok`);
  }
});
