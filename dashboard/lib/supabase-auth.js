'use strict';

/**
 * Issue #215 (Cloud-Slice 2 — Auth-Naht): Supabase-JWT-Verifikation + Doppelpfad.
 * --------------------------------------------------------------------------------
 * Verifiziert Supabase-Access-Tokens (ES256/RS256) serverseitig gegen die
 * öffentlichen JWKS des Projekts (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
 * — KEIN Shared-Secret nötig, keine neuen Dependencies (node:crypto).
 *
 * Sicherheitsregeln (Default-Deny durchgängig):
 *  - Nur asymmetrische Algorithmen aus den JWKS (ES256/RS256). `alg:none`/HS256
 *    werden hart abgelehnt (kein Downgrade).
 *  - iss muss exakt dem Projekt-Issuer entsprechen, aud = 'authenticated',
 *    exp/nbf werden geprüft. Jeder Fehler ⇒ { valid:false } — diese Funktion
 *    WIRFT NIE (der Aufrufer behandelt invalid wie „kein Login").
 *  - Die Identität ist die verifizierte E-Mail (Mapping auf tenantId/roleKey
 *    läuft unverändert über lib/tenant-directory.js + DASHBOARD_ADMIN_LOGIN —
 *    Supabase ersetzt NUR den Identitäts-Eingang, nicht das RLS-Mandantenmodell).
 *
 * Doppelpfad (AC #215): `resolveAuthMode(env)` schaltet zwischen
 *  - 'tailscale' (Default, Mini): Identität aus dem Tailscale-Header wie bisher.
 *  - 'supabase'  (Cloud):        Identität NUR aus dem verifizierten JWT; der
 *                                 spoofbare Tailscale-Header wird NIE verwendet.
 */

const crypto = require('node:crypto');

// JWKS-Cache (Modul-Ebene): Supabase rotiert Schlüssel selten; 10 min TTL hält
// die Latenz aus dem Request-Pfad. fetchJwks ist injizierbar (Tests/Override).
const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map(); // url -> { fetchedAt, keys }

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// Env-Schalter des Doppelpfads — FAIL-CLOSED (Sicherheitsaudit 2026-06-12, C1).
//  - Explizit 'supabase' ⇒ supabase (JWT-Pfad).
//  - SICHERHEITSRIEGEL: Sobald `SUPABASE_URL` gesetzt ist, laufen wir im
//    Cloud-Kontext (offenes Internet). Dort darf der TRIVIAL FÄLSCHBARE
//    Tailscale-Header NIEMALS Identität sein. Deshalb erzwingen wir dann
//    'supabase' — selbst wenn DASHBOARD_AUTH_MODE fehlt ODER (versehentlich/
//    böswillig) auf 'tailscale' steht. Ein vergessenes/falsches Env-Flag kann
//    so keine Auth-Umgehung mehr auslösen (vorher: Default 'tailscale' ⇒
//    Header-Spoofing ⇒ Admin-Übernahme).
//  - Nur OHNE `SUPABASE_URL` (= Mini/Heimnetz hinter Tailscale) bleibt es beim
//    bewährten Tailscale-Pfad. Der Mini hat kein SUPABASE_URL ⇒ unverändert.
function resolveAuthMode(env = {}) {
  if (clean(env.DASHBOARD_AUTH_MODE).toLowerCase() === 'supabase') return 'supabase';
  if (clean(env.SUPABASE_URL)) return 'supabase'; // Cloud erkannt ⇒ nie Header-Auth
  return 'tailscale';
}

// Bearer-Token aus dem Authorization-Header (case-insensitives Schema).
function extractBearerToken(headers) {
  const raw = clean(headers && headers.authorization);
  const m = /^bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : '';
}

// Kern-Sicherheitsregel der Naht: Welcher Login gilt als Identität?
//  - supabase-Mode: ausschließlich die verifizierte JWT-E-Mail; ohne gültiges
//    JWT KEINE Identität (Default-Deny) — der Tailscale-Header wird ignoriert,
//    weil er aus dem offenen Internet trivial fälschbar wäre.
//  - tailscale-Mode: unverändert der Header (Vertrauen kommt aus dem Netzpfad).
function identityLogin({ authMode, jwtEmail, tailscaleLogin } = {}) {
  if (authMode === 'supabase') return clean(jwtEmail);
  return clean(tailscaleLogin);
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function defaultFetchJwks(jwksUrl) {
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  return res.json();
}

async function loadJwks(jwksUrl, fetchJwks, nowMs) {
  const cached = jwksCache.get(jwksUrl);
  if (cached && (nowMs - cached.fetchedAt) < JWKS_TTL_MS) return cached.keys;
  const body = await (fetchJwks || defaultFetchJwks)(jwksUrl);
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  jwksCache.set(jwksUrl, { fetchedAt: nowMs, keys });
  return keys;
}

// Verifiziert ein Supabase-Access-Token. Liefert IMMER ein Objekt:
//   { valid:true, email, sub, claims }  bzw.  { valid:false, reason }
// opts: { issuer, jwksUrl?, fetchJwks?, nowMs? } — issuer Pflicht
// (z. B. `https://<ref>.supabase.co/auth/v1`); jwksUrl default = issuer-basiert.
async function verifySupabaseJwt(token, opts = {}) {
  try {
    const raw = clean(token);
    if (!raw) return { valid: false, reason: 'kein Token' };
    const parts = raw.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'kein JWT-Format' };

    let header, payload;
    try {
      header = b64urlJson(parts[0]);
      payload = b64urlJson(parts[1]);
    } catch {
      return { valid: false, reason: 'Header/Payload nicht dekodierbar' };
    }

    // Nur asymmetrische JWKS-Algorithmen — alg:none/HS* sind Downgrade-Angriffe.
    const alg = clean(header.alg);
    if (alg !== 'ES256' && alg !== 'RS256') return { valid: false, reason: `alg ${alg || 'none'} nicht erlaubt` };

    const issuer = clean(opts.issuer);
    if (!issuer) return { valid: false, reason: 'kein issuer konfiguriert' };
    if (clean(payload.iss) !== issuer) return { valid: false, reason: 'iss-Mismatch' };

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.map(clean).includes('authenticated')) return { valid: false, reason: 'aud-Mismatch' };

    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSec) return { valid: false, reason: 'exp abgelaufen/fehlt' };
    if (Number.isFinite(payload.nbf) && payload.nbf > nowSec + 60) return { valid: false, reason: 'nbf in der Zukunft' };

    const jwksUrl = clean(opts.jwksUrl) || `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
    const keys = await loadJwks(jwksUrl, opts.fetchJwks, nowMs);
    const kid = clean(header.kid);
    const jwk = keys.find((k) => clean(k.kid) === kid && kid !== '');
    if (!jwk) return { valid: false, reason: 'kid unbekannt (kein passender JWKS-Key)' };

    let publicKey;
    try {
      publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      return { valid: false, reason: 'JWKS-Key nicht ladbar' };
    }

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const verified = alg === 'ES256'
      ? crypto.verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
      : crypto.verify('sha256', signingInput, publicKey, signature);
    if (!verified) return { valid: false, reason: 'Signatur ungültig' };

    return {
      valid: true,
      email: clean(payload.email).toLowerCase(),
      sub: clean(payload.sub),
      claims: payload,
    };
  } catch (err) {
    return { valid: false, reason: `Verifikationsfehler: ${err && err.message}` };
  }
}

// Testbarkeit: Cache leeren (z. B. zwischen Testfällen mit anderen Keys).
function clearJwksCache() {
  jwksCache.clear();
}

module.exports = {
  resolveAuthMode,
  extractBearerToken,
  identityLogin,
  verifySupabaseJwt,
  clearJwksCache,
};
