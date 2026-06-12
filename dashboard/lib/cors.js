'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CORS für die Cloud-Trennung Frontend (Cloudflare) ↔ Backend (Render) — #218.
//
// Das Frontend liegt auf einer anderen Origin als die API ⇒ kontrollierte
// CORS-Header. Eigenschaften (bewusst restriktiv):
//  - EXAKTE Origin-Allowlist (DASHBOARD_CORS_ORIGINS, komma-getrennt). Eine
//    nicht gelistete Origin bekommt KEINE CORS-Header (Default-Deny).
//  - KEINE Credentials (Access-Control-Allow-Credentials wird NICHT gesetzt):
//    die Auth läuft über das Authorization-Bearer-JWT (#215), nicht über Cookies
//    — so kann eine fremde Seite keine Cookie-getragene Sitzung missbrauchen.
//  - Leere Allowlist (Mini/same-origin) ⇒ nie Header, CORS bleibt inert.
// Reine Funktionen (kein IO) — in server.js verdrahtet.
// ─────────────────────────────────────────────────────────────────────────────

function clean(v) { return String(v == null ? '' : v).trim(); }

function parseAllowedOrigins(value) {
  return clean(value).split(',').map((o) => o.trim()).filter(Boolean);
}

// CORS-Header für eine konkrete Request-Origin gegen die Allowlist.
// Liefert {} (keine Header), wenn keine Origin oder nicht erlaubt.
function corsHeadersFor(origin, allowedOrigins) {
  const o = clean(origin);
  if (!o || !Array.isArray(allowedOrigins) || !allowedOrigins.includes(o)) return {};
  return {
    'Access-Control-Allow-Origin': o,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Support-Tenant',
    'Access-Control-Max-Age': '600',
  };
}

function isPreflight(req) {
  return String(req && req.method).toUpperCase() === 'OPTIONS'
    && !!(req && req.headers && req.headers['access-control-request-method']);
}

// Spiegelt die Frontend-Logik (v3.js authFetchShim): window.__API_BASE__ (von
// Cloudflare via config.js gesetzt) gewinnt; sonst same-origin (leer = Mini).
function resolveApiBase(win) {
  return clean(win && win.__API_BASE__).replace(/\/+$/, '');
}

module.exports = { parseAllowedOrigins, corsHeadersFor, isPreflight, resolveApiBase };
