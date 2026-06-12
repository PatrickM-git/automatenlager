'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Origin-Schutz — Etappe 3 (H2-Backend-Hälfte, Audit 2026-06-12).
//
// Problem (Audit H2): Die API liegt auf der öffentlichen *.onrender.com-URL.
// Selbst wenn das Frontend über Cloudflare läuft, könnte ein Angreifer die
// Render-URL direkt ansprechen und damit Cloudflares WAF/Rate-Limiting/DDoS-
// Schutz UMGEHEN (Cloudflare-Bypass).
//
// Fix (zweiteilig): Cloudflare injiziert per Transform-Rule einen geheimen
// Header `X-CF-Origin-Secret` auf jedem Request, der durch Cloudflare läuft;
// dieses Backend akzeptiert API-Requests NUR mit korrektem Header — direkter
// Zugriff auf die Render-URL ⇒ 403. (Die Cloudflare-Regel ist der Browser-Teil;
// hier ist die Backend-Hälfte.)
//
// Sicherheitseigenschaften:
//  - FAIL-SAFE inert: ohne konfiguriertes Secret (CF_ORIGIN_SECRET leer) erlaubt
//    er alles ⇒ kein Selbst-Aussperren vor der Cloudflare-Aktivierung, Mini
//    unberührt. Scharf wird er erst, wenn das Secret in Render UND in der
//    Cloudflare-Transform-Rule gesetzt ist.
//  - /health ausgenommen: Renders interner Healthcheck kommt nicht über
//    Cloudflare und darf NIE blocken (sonst Neustart-Schleife).
//  - /internal/ ausgenommen: die Job-Trigger kommen von Supabase pg_cron (nicht
//    Cloudflare) und haben ihr eigenes starkes WORKER_TRIGGER_SECRET.
//  - timing-safe Vergleich (kein Längen-/Inhalts-Orakel).
// ─────────────────────────────────────────────────────────────────────────────

const { timingSafeSecretEqual } = require('./job-triggers.js');

function isExemptPath(pathname) {
  const p = String(pathname || '');
  return p === '/health' || p.startsWith('/internal/');
}

// { allowed, reason } — reine Entscheidung, kein IO.
function originGuardDecision({ secret, headerValue, pathname } = {}) {
  const configured = String(secret == null ? '' : secret).trim();
  if (!configured) return { allowed: true, reason: 'inactive' };          // inert ohne Secret
  if (isExemptPath(pathname)) return { allowed: true, reason: 'exempt' };  // /health, /internal/
  if (timingSafeSecretEqual(headerValue, configured)) return { allowed: true, reason: 'ok' };
  return { allowed: false, reason: 'origin_secret_missing_or_wrong' };
}

module.exports = { originGuardDecision, isExemptPath };
