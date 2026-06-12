// Cloudflare Pages — Advanced-Mode Worker (Etappe 3, H2-Fix). 2026-06-12
// ===========================================================================
// EIN Worker im Build-Output-Root übernimmt ALLE Requests (eindeutig erkannt,
// anders als ein functions/-Verzeichnis, das Cloudflare im Projekt-Root sucht).
// Aufgaben:
//   1. Backend-Pfade (/api, /health, /internal) → Proxy ans Render-Backend,
//      mit injiziertem geheimem Origin-Header (X-CF-Origin-Secret). Damit läuft
//      die API HINTER Cloudflare (WAF/DDoS/Rate-Limit) und der Origin-Guard im
//      Backend sperrt jeden direkten *.onrender.com-Zugriff ohne den Header.
//   2. Alles andere → statische Assets (env.ASSETS), mit SPA-Routing auf die
//      v3-Einstiegsdateien (im Advanced Mode werden _redirects ignoriert, daher
//      hier im Code).
// Same-origin (Frontend + API unter einer Domain) ⇒ KEIN CORS; das Secret
// bleibt serverseitig (Pages-Env), nie im Browser.
//
// Pages-Env (Settings → Variablen und Geheimnisse):
//   RENDER_API_BASE   = https://faltrix-dashboard.onrender.com
//   CF_ORIGIN_SECRET  = <derselbe Wert wie in der Render-Env>

const BACKEND_PREFIXES = ['/api', '/health', '/internal'];

function isBackend(pathname) {
  return BACKEND_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?'));
}

// SPA-Einstiegsdateien (spiegelt den server.js-Fallback + das alte _redirects).
function assetPathFor(pathname) {
  if (pathname === '/' || pathname === '/v3' || pathname.startsWith('/v3/')) return '/v3.html';
  if (pathname === '/login') return '/login.html';
  if (pathname === '/status') return '/status.html';
  return pathname;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) Backend-Proxy ans Render-Backend.
    if (isBackend(url.pathname)) {
      const base = String(env.RENDER_API_BASE || '').replace(/\/+$/, '');
      if (!base) return new Response('RENDER_API_BASE nicht konfiguriert', { status: 503 });
      const headers = new Headers(request.headers);
      if (env.CF_ORIGIN_SECRET) headers.set('X-CF-Origin-Secret', env.CF_ORIGIN_SECRET);
      headers.delete('host'); // Render setzt seinen eigenen Host-Header
      const init = { method: request.method, headers, redirect: 'manual' };
      if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
      return fetch(base + url.pathname + url.search, init);
    }

    // 2) Statische Assets mit SPA-Routing.
    const assetPath = assetPathFor(url.pathname);
    if (assetPath !== url.pathname) {
      const rewritten = new URL(url);
      rewritten.pathname = assetPath;
      return env.ASSETS.fetch(new Request(rewritten.toString(), request));
    }
    return env.ASSETS.fetch(request);
  },
};
