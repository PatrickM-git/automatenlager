'use strict';

/**
 * Issue #218 (Cloud-Slice 4) — CORS für das Cloudflare-Frontend → Render-Backend.
 * ------------------------------------------------------------------------------
 * Das Frontend liegt auf Cloudflare (eigene Origin), das Backend auf Render
 * (andere Origin). Die API-Calls sind cross-origin ⇒ kontrollierte CORS-Header.
 * Auth läuft über das Authorization-Bearer-JWT (NICHT Cookies) ⇒ KEIN
 * Access-Control-Allow-Credentials (keine Cookie-Exfiltration), aber Authorization
 * im Allow-Headers. Reine Entscheidungs-Funktion (DB-/HTTP-frei testbar).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseAllowedOrigins, corsHeadersFor, isPreflight } = require('../lib/cors.js');

const ALLOW = 'https://app.faltrix-solutions.de, https://faltrix.pages.dev';

test('#218 parseAllowedOrigins: Liste, getrimmt, leere/Müll-Einträge raus', () => {
  assert.deepEqual(parseAllowedOrigins(ALLOW), ['https://app.faltrix-solutions.de', 'https://faltrix.pages.dev']);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(null), []);
  assert.deepEqual(parseAllowedOrigins('  https://x.de ,, '), ['https://x.de']);
});

test('#218 erlaubte Origin ⇒ exakte Echo-Origin + Vary, KEINE Credentials', () => {
  const h = corsHeadersFor('https://app.faltrix-solutions.de', parseAllowedOrigins(ALLOW));
  assert.equal(h['Access-Control-Allow-Origin'], 'https://app.faltrix-solutions.de');
  assert.equal(h['Vary'], 'Origin');
  assert.match(h['Access-Control-Allow-Headers'], /Authorization/i);
  assert.match(h['Access-Control-Allow-Headers'], /Content-Type/i);
  assert.match(h['Access-Control-Allow-Methods'], /POST/);
  assert.equal(h['Access-Control-Allow-Credentials'], undefined, 'keine Cookie-Credentials (Bearer-JWT)');
});

test('#218 fremde Origin ⇒ KEINE CORS-Header (Default-Deny)', () => {
  const h = corsHeadersFor('https://boese.example.com', parseAllowedOrigins(ALLOW));
  assert.equal(h['Access-Control-Allow-Origin'], undefined);
});

test('#218 keine Origin (same-origin/Mini, kein Browser-CORS) ⇒ keine Header', () => {
  assert.deepEqual(corsHeadersFor(undefined, parseAllowedOrigins(ALLOW)), {});
  assert.deepEqual(corsHeadersFor('', parseAllowedOrigins(ALLOW)), {});
});

test('#218 leere Allowlist (Mini, CORS aus) ⇒ nie Header, auch bei Origin', () => {
  assert.deepEqual(corsHeadersFor('https://app.faltrix-solutions.de', []), {});
});

test('#218 isPreflight: OPTIONS + Access-Control-Request-Method', () => {
  assert.equal(isPreflight({ method: 'OPTIONS', headers: { 'access-control-request-method': 'POST' } }), true);
  assert.equal(isPreflight({ method: 'OPTIONS', headers: {} }), false);
  assert.equal(isPreflight({ method: 'GET', headers: { 'access-control-request-method': 'POST' } }), false);
});

// ── Frontend-API-Basis-Auflösung (reine Logik, gespiegelt in v3.js) ──────────

test('#218 resolveApiBase: window.__API_BASE__ gewinnt, sonst same-origin (leer)', () => {
  const { resolveApiBase } = require('../lib/cors.js');
  assert.equal(resolveApiBase({ __API_BASE__: 'https://faltrix-dashboard.onrender.com' }), 'https://faltrix-dashboard.onrender.com');
  assert.equal(resolveApiBase({ __API_BASE__: 'https://x.onrender.com/' }), 'https://x.onrender.com', 'trailing slash entfernt');
  assert.equal(resolveApiBase({}), '');
  assert.equal(resolveApiBase({ __API_BASE__: '' }), '');
});
