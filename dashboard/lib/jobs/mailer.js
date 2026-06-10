'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mailer (Alert-Versand) — Issue #161 (Stufe 6, Slice 1).
// Gemeinsames Modul für WF-Val + WF-Monitor (ersetzt die n8n-Gmail-Nodes).
//
// ARCHITEKTUR-LEITSATZ (für die Multi-Mandanten-Cloud, bewusst so gebaut):
//   * ABSENDER = die PLATTFORM — EINE Credential fürs ganze System (kein
//     Per-Mandant-Postfach). Heute: Resend-API-Key + MAIL_FROM.
//   * EMPFÄNGER = PRO MANDANT — jeder Mandant bekommt Alerts an SEINE Adresse
//     (im Onboarding hinterlegt). Hier über `ALERT_EMAIL_<tenant>` / Fallback
//     `ALERT_EMAIL_DEFAULT`; später aus einer Mandanten-Config-Tabelle (Stufe 8).
//   * PROVIDER-AGNOSTISCH — `transport` ist injizierbar. Heute Resend (HTTPS-API
//     über das globale `fetch`, KEIN npm-Dep ⇒ deploybar ohne `npm install`).
//     Ein SMTP-Transport (nodemailer) oder Postmark/SES ist nur ein weiterer
//     Transport — der Wechsel ist Config, kein Rewrite.
//
// #107-rein: dieses Modul trägt KEIN pg. Die Empfänger-Auflösung ist hier rein
// env-basiert; ein DB-gestützter Resolver (durch die Tür) kommt mit der Mandanten-
// Admin-UI (Stufe 8). Der #107-Wächter scannt lib/jobs/* — kein rohes pg hier.
// ─────────────────────────────────────────────────────────────────────────────

const { withTimeout } = require('../fetch-timeout.js');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
// Resend erlaubt OHNE verifizierte Domain nur diesen Absender (Test-Modus: Versand
// an die eigene Account-Mail). Für echten Versand an beliebige Empfänger eine eigene
// Domain bei Resend verifizieren und MAIL_FROM darauf setzen.
const RESEND_TEST_FROM = 'onboarding@resend.dev';

/**
 * Resend-Transport über das globale fetch (kein npm-Dep).
 * @param {object} opts
 * @param {string} opts.apiKey   RESEND_API_KEY
 * @param {string} opts.from     Default-Absender (MAIL_FROM)
 * @param {Function} [opts.fetchImpl]  injizierbares fetch (Tests)
 */
function createResendTransport({ apiKey, from, fetchImpl } = {}) {
  if (!apiKey) throw new TypeError('mailer: createResendTransport verlangt apiKey');
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new TypeError('mailer: kein fetch verfügbar (Node < 18?) — fetchImpl injizieren');
  return async function resendSend({ to, subject, text, html, from: fromOverride } = {}) {
    const payload = {
      from: fromOverride || from || RESEND_TEST_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
    };
    if (text != null) payload.text = text;
    if (html != null) payload.html = html;
    const res = await doFetch(RESEND_ENDPOINT, withTimeout({
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    if (!res.ok) {
      let detail = ''; try { detail = await res.text(); } catch { /* */ }
      throw new Error(`mailer: Resend HTTP ${res.status} — ${String(detail).slice(0, 300)}`);
    }
    let body = {}; try { body = await res.json(); } catch { /* */ }
    return { id: (body && body.id) || null, provider: 'resend' };
  };
}

/** Test-/Trockentransport: sammelt Mails statt zu senden. */
function createFakeTransport() {
  const sent = [];
  const t = async (msg) => { sent.push(msg); return { id: `fake-${sent.length}`, provider: 'fake' }; };
  t.sent = sent;
  return t;
}

/**
 * Mailer-Fassade. `send()` validiert, wählt den Empfänger (to | defaultTo) und
 * delegiert an den Transport. Wirft bei fehlendem Empfänger/Betreff (fail-closed).
 */
function createMailer({ transport, from, defaultTo, logger } = {}) {
  if (typeof transport !== 'function') throw new TypeError('mailer: transport-Funktion erforderlich');
  const log = typeof logger === 'function' ? logger : () => {};
  async function send({ to, subject, text, html } = {}) {
    const recipient = to || defaultTo;
    if (!recipient) throw new Error('mailer: kein Empfänger (to/defaultTo)');
    if (!subject || !String(subject).trim()) throw new Error('mailer: subject erforderlich');
    const res = await transport({ from, to: recipient, subject, text, html });
    log('mailer: gesendet', { to: recipient, subject, id: res && res.id, provider: res && res.provider });
    return res;
  }
  return { send };
}

/** Empfänger-Adresse für EINEN Mandanten (per-Mandant-Env, sonst Default). */
function resolveTenantAlertEmail(env, tenant) {
  const e = env || {};
  const perTenant = tenant ? e[`ALERT_EMAIL_${String(tenant).trim()}`] : null;
  return (perTenant && String(perTenant).trim()) || (e.ALERT_EMAIL_DEFAULT && String(e.ALERT_EMAIL_DEFAULT).trim()) || null;
}

/**
 * Produktions-Mailer aus der Env. Wählt den Transport nach vorhandenem Secret:
 *   * RESEND_API_KEY gesetzt  ⇒ Resend-Transport (scharf).
 *   * sonst                   ⇒ „disabled"-Transport: Jobs LAUFEN, mailen aber
 *     nicht (Log statt Versand). So bricht ein fehlender Key NICHTS — er stummt
 *     nur die Mail (wichtig: Val/Monitor sollen ihre DB-Arbeit auch ohne Mailer tun).
 */
function buildMailerFromEnv(env = process.env, { fetchImpl } = {}) {
  const from = (env.MAIL_FROM && String(env.MAIL_FROM).trim()) || RESEND_TEST_FROM;
  if (env.RESEND_API_KEY && String(env.RESEND_API_KEY).trim()) {
    return {
      kind: 'resend',
      from,
      mailer: createMailer({ transport: createResendTransport({ apiKey: String(env.RESEND_API_KEY).trim(), from, fetchImpl }), from }),
    };
  }
  const disabled = async (m) => { console.warn('[mailer] kein RESEND_API_KEY — Mail unterdrückt:', m && m.subject); return { id: null, provider: 'disabled' }; };
  return { kind: 'disabled', from, mailer: createMailer({ transport: disabled, from }) };
}

module.exports = {
  createMailer,
  createResendTransport,
  createFakeTransport,
  resolveTenantAlertEmail,
  buildMailerFromEnv,
  RESEND_ENDPOINT,
  RESEND_TEST_FROM,
};
