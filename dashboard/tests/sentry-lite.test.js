'use strict';

/**
 * Issue #217 — Sentry-lite (zentrales Error-Tracking ohne npm-Dependency).
 * Eigener minimaler Store-API-Client (wie der Resend-Mailer: HTTPS via fetch,
 * injizierbar). Geprüft: DSN-Parsing, Event-Versand, No-op ohne DSN,
 * wirft NIE (Error-Tracking darf nie selbst zum Fehler werden).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseDsn, createSentry } = require('../lib/sentry-lite.js');

const DSN = 'https://abc123key@o4501234.ingest.de.sentry.io/4509999';

test('#217 parseDsn: Host/Projekt/Key extrahiert; Müll ⇒ null', () => {
  const d = parseDsn(DSN);
  assert.equal(d.publicKey, 'abc123key');
  assert.equal(d.projectId, '4509999');
  assert.equal(d.storeUrl, 'https://o4501234.ingest.de.sentry.io/api/4509999/store/');
  assert.equal(parseDsn(''), null);
  assert.equal(parseDsn('kein-dsn'), null);
  assert.equal(parseDsn(null), null);
});

test('#217 captureException sendet Event mit Auth-Header, Message und Stack', async () => {
  const sent = [];
  const sentry = createSentry({
    dsn: DSN,
    environment: 'test',
    fetchImpl: async (url, opts) => { sent.push({ url, opts }); return { ok: true, status: 200 }; },
  });
  assert.equal(sentry.enabled, true);
  const err = new Error('kaputt: Beispielfehler');
  await sentry.captureException(err, { job: 'wf3-nayax-fifo' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://o4501234.ingest.de.sentry.io/api/4509999/store/');
  assert.match(sent[0].opts.headers['X-Sentry-Auth'], /sentry_key=abc123key/);
  const event = JSON.parse(sent[0].opts.body);
  assert.equal(event.environment, 'test');
  assert.equal(event.exception.values[0].type, 'Error');
  assert.match(event.exception.values[0].value, /Beispielfehler/);
  assert.ok(Array.isArray(event.exception.values[0].stacktrace.frames), 'Stack-Frames vorhanden');
  assert.equal(event.extra.job, 'wf3-nayax-fifo');
});

test('#217 ohne DSN: enabled=false, captureException ist No-op und wirft nicht', async () => {
  const sentry = createSentry({ dsn: '', fetchImpl: async () => { throw new Error('darf nie aufgerufen werden'); } });
  assert.equal(sentry.enabled, false);
  await sentry.captureException(new Error('x')); // darf nicht werfen
});

test('#217 Versandfehler wird verschluckt (Error-Tracking wirft nie)', async () => {
  const sentry = createSentry({ dsn: DSN, fetchImpl: async () => { throw new Error('netz weg'); } });
  await sentry.captureException(new Error('original')); // darf nicht werfen
});

test('#217 nicht-Error-Werte werden sauber serialisiert', async () => {
  const sent = [];
  const sentry = createSentry({ dsn: DSN, fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; } });
  await sentry.captureException('nur ein String');
  assert.match(sent[0].exception.values[0].value, /nur ein String/);
});
