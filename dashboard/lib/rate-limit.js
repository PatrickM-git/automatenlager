'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Rate-Limiting — Etappe 3 (M1, Audit 2026-06-12).
//
// Defense-in-depth gegen Flooding (Login/API/Anfragen). Die SCHWERE Last-Abwehr
// (DDoS, L7-Flooding) macht Cloudflare vor der API; dieses In-Memory-Limit ist
// die zusätzliche Bremse direkt im Backend — wirksam AUCH ohne/vor Cloudflare.
//
// Fixed-Window-Zähler pro Client-Key (IP). Reine, zeit-injizierbare Logik
// (now()) ⇒ ohne echten Timer testbar. Auf der Render-Free-Stufe läuft EINE
// Instanz ⇒ In-Memory genügt; bei mehreren Instanzen wäre ein geteilter Store
// (Redis) nötig (dann ist aber ohnehin Cloudflare die primäre Grenze).
//
// Notausschalter: max<=0 ⇒ immer erlaubt (env RATE_LIMIT_MAX=0).
// ─────────────────────────────────────────────────────────────────────────────

function createRateLimiter({ windowMs = 60_000, max = 300, now = Date.now } = {}) {
  const buckets = new Map(); // key -> { count, windowStart }
  let lastSweep = now();

  function sweep(t) {
    // Selten aufräumen (alte Buckets entfernen), damit die Map nicht wächst.
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [k, b] of buckets) {
      if (t - b.windowStart >= windowMs) buckets.delete(k);
    }
  }

  function check(key) {
    if (!(max > 0)) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    const t = now();
    sweep(t);
    let b = buckets.get(key);
    if (!b || (t - b.windowStart) >= windowMs) {
      b = { count: 0, windowStart: t };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      return { allowed: false, remaining: 0, retryAfterMs: windowMs - (t - b.windowStart) };
    }
    return { allowed: true, remaining: max - b.count, retryAfterMs: 0 };
  }

  return { check, _size: () => buckets.size };
}

// Client-Key für das Limit. Hinter Cloudflare ist die echte Besucher-IP im
// `CF-Connecting-IP`-Header — der ist aber NUR vertrauenswürdig, wenn wir
// sicher hinter Cloudflare stehen (trustCf). Sonst die nicht-fälschbare
// Socket-Adresse (sonst könnte ein Angreifer durch gefälschte Header das Limit
// pro „IP" umgehen).
function clientKey(req, { trustCf = false } = {}) {
  if (trustCf) {
    const cf = req && req.headers && String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { createRateLimiter, clientKey };
