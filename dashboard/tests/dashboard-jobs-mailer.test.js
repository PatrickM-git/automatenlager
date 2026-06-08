'use strict';

/**
 * Mailer (Issue #161, Stufe 6 Slice 1) — provider-agnostischer Alert-Versand.
 * Absender = Plattform (1 Credential), Empfänger = pro Mandant. Resend-Transport
 * über injizierbares fetch (kein Netz im Test). #107-rein (kein pg).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMailer, createResendTransport, createFakeTransport,
  resolveTenantAlertEmail, buildMailerFromEnv, RESEND_ENDPOINT, RESEND_TEST_FROM,
} = require('../lib/jobs/mailer.js');

test('#161 mailer: ohne transport ⇒ TypeError (fail-closed)', () => {
  assert.throws(() => createMailer({}), /transport/);
});

test('#161 mailer: fehlender Empfänger/Betreff ⇒ wirft', async () => {
  const m = createMailer({ transport: createFakeTransport(), from: 'a@x' });
  await assert.rejects(() => m.send({ subject: 'x' }), /Empfänger/);
  await assert.rejects(() => m.send({ to: 'b@y' }), /subject/);
});

test('#161 mailer: send nutzt to bzw. defaultTo + reicht an Transport durch', async () => {
  const fake = createFakeTransport();
  const m = createMailer({ transport: fake, from: 'alerts@p', defaultTo: 'fallback@t' });
  await m.send({ subject: 'Hallo', text: 'Welt' });
  await m.send({ to: 'explizit@t', subject: 'Zwei', html: '<b>x</b>' });
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[0].to, 'fallback@t', 'defaultTo greift, wenn to fehlt');
  assert.equal(fake.sent[0].from, 'alerts@p');
  assert.equal(fake.sent[1].to, 'explizit@t');
  assert.equal(fake.sent[1].html, '<b>x</b>');
});

test('#161 resolveTenantAlertEmail: per-Mandant-Env vor Default, sonst null', () => {
  const env = { ALERT_EMAIL_DEFAULT: 'd@x', ALERT_EMAIL_t_faltrix: 'faltrix@x' };
  assert.equal(resolveTenantAlertEmail(env, 't_faltrix'), 'faltrix@x', 'per-Mandant gewinnt');
  assert.equal(resolveTenantAlertEmail(env, 'acme'), 'd@x', 'Fallback Default');
  assert.equal(resolveTenantAlertEmail({}, 'acme'), null, 'nichts konfiguriert ⇒ null');
});

test('#161 resend-Transport: korrekte URL/Header/Body, 200 ⇒ {id,provider}', async () => {
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ id: 're_123' }) };
  };
  const transport = createResendTransport({ apiKey: 'KEY', from: 'alerts@p', fetchImpl: fakeFetch });
  const res = await transport({ to: 'kunde@t', subject: 'Betreff', text: 'Inhalt' });
  assert.equal(seen.url, RESEND_ENDPOINT);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Bearer KEY', 'API-Key im Authorization-Header');
  const body = JSON.parse(seen.opts.body);
  assert.deepEqual(body.to, ['kunde@t'], 'to wird zu Array');
  assert.equal(body.from, 'alerts@p');
  assert.equal(body.subject, 'Betreff');
  assert.equal(body.text, 'Inhalt');
  assert.equal(res.id, 're_123');
  assert.equal(res.provider, 'resend');
});

test('#161 resend-Transport: non-ok ⇒ wirft mit Status + leerer to-Default-from', async () => {
  const fakeFetch = async () => ({ ok: false, status: 422, text: async () => 'domain not verified' });
  const transport = createResendTransport({ apiKey: 'KEY', fetchImpl: fakeFetch });
  await assert.rejects(() => transport({ to: 'x@y', subject: 's' }), /Resend HTTP 422.*domain not verified/);
  // ohne from ⇒ Resend-Test-Absender
  let seen = null;
  const okFetch = async (url, opts) => { seen = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: 'i' }) }; };
  await createResendTransport({ apiKey: 'K', fetchImpl: okFetch })({ to: 'x@y', subject: 's' });
  assert.equal(seen.from, RESEND_TEST_FROM, 'ohne MAIL_FROM ⇒ onboarding@resend.dev');
});

test('#161 buildMailerFromEnv: RESEND_API_KEY ⇒ resend; sonst disabled (Job läuft, Mail stumm)', async () => {
  const built = buildMailerFromEnv({ RESEND_API_KEY: 'K', MAIL_FROM: 'alerts@p' }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) }) });
  assert.equal(built.kind, 'resend');
  assert.equal(built.from, 'alerts@p');

  const off = buildMailerFromEnv({});
  assert.equal(off.kind, 'disabled');
  // disabled-Transport wirft NICHT — der Job darf trotzdem laufen.
  const res = await off.mailer.send({ to: 'x@y', subject: 's', text: 't' });
  assert.equal(res.provider, 'disabled');
});
