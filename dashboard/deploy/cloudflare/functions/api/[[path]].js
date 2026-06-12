// Cloudflare Pages Function — API-Proxy (Etappe 3, H2-Fix).
// ===========================================================================
// Leitet jeden /api/*-Request des Frontends durch Cloudflare an das Render-
// Backend weiter UND injiziert den geheimen Origin-Header. Wirkung:
//  - Die API läuft jetzt HINTER Cloudflare ⇒ WAF, DDoS-Schutz, Bot-Protection
//    und Rate-Limiting greifen auch für die API (nicht nur fürs Frontend).
//  - Der Origin-Guard im Backend (lib/origin-guard.js) blockt jeden direkten
//    Zugriff auf die *.onrender.com-URL, der diesen Header NICHT trägt ⇒
//    Cloudflare-Bypass ist dicht.
//  - Frontend und API teilen sich dieselbe Domain (same-origin) ⇒ KEIN CORS,
//    und das Secret bleibt serverseitig (Pages-Env), nie im Browser.
//
// Cloudflare-Pages-Env (Settings → Environment variables):
//   RENDER_API_BASE   = https://faltrix-dashboard.onrender.com
//   CF_ORIGIN_SECRET  = <derselbe Wert wie in der Render-Env>
//
// Die Datei greift dank `[[path]]` für ALLE Pfade unter /api/.
export async function onRequest(context) {
  const { request, env } = context;
  const base = String(env.RENDER_API_BASE || '').replace(/\/+$/, '');
  if (!base) return new Response('RENDER_API_BASE nicht konfiguriert', { status: 503 });

  const url = new URL(request.url);
  const target = base + url.pathname + url.search; // pathname enthält /api/...

  const headers = new Headers(request.headers);
  if (env.CF_ORIGIN_SECRET) headers.set('X-CF-Origin-Secret', env.CF_ORIGIN_SECRET);
  headers.delete('host'); // Render setzt seinen eigenen Host-Header

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  return fetch(target, init);
}
