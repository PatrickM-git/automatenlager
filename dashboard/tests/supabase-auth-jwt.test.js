'use strict';

/**
 * Issue #215 (Cloud-Slice 2 — Auth-Naht): Supabase-JWT-Verifikation.
 * -------------------------------------------------------------------
 * DB-freie Unit-Tests gegen lib/supabase-auth.js:
 *  - verifySupabaseJwt: ES256-Signaturprüfung gegen (injizierte) JWKS,
 *    iss/aud/exp-Checks, Default-Deny bei jedem Fehler.
 *  - resolveAuthMode: Env-Schalter Doppelpfad (tailscale|supabase).
 *  - identityLogin: in supabase-Mode wird der spoofbare Tailscale-Header
 *    NIEMALS als Identität verwendet (Kern-Sicherheitsregel der Naht).
 *
 * Systemgrenze (JWKS-Fetch) wird injiziert — kein Netz in Unit-Tests.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const {
  verifySupabaseJwt,
  resolveAuthMode,
  extractBearerToken,
  identityLogin,
} = require('../lib/supabase-auth.js');

// ── Test-Schlüsselpaar + Token-Fabrik (ES256, wie Supabase) ───────────────────

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'test-kid-1';
const ISSUER = 'https://bimftbjpvljjnvorqbtn.supabase.co/auth/v1';

function jwks() {
  const jwk = publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signToken({ header = {}, payload = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'ES256', typ: 'JWT', kid: KID, ...header };
  const p = {
    iss: ISSUER,
    aud: 'authenticated',
    sub: 'user-uuid-1',
    email: 'patrickmatthes2609@gmail.com',
    role: 'authenticated',
    iat: now,
    exp: now + 3600,
    ...payload,
  };
  const signingInput = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363', // JWT-ES256 = rohes r||s
  });
  return `${signingInput}.${b64url(signature)}`;
}

const OPTS = { issuer: ISSUER, fetchJwks: async () => jwks() };

// ── verifySupabaseJwt ─────────────────────────────────────────────────────────

test('#215 gültiges ES256-JWT ⇒ valid, E-Mail-Identität extrahiert', async () => {
  const r = await verifySupabaseJwt(signToken(), OPTS);
  assert.equal(r.valid, true);
  assert.equal(r.email, 'patrickmatthes2609@gmail.com');
  assert.equal(r.sub, 'user-uuid-1');
});

test('#215 abgelaufenes JWT ⇒ invalid (Default-Deny)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await verifySupabaseJwt(signToken({ payload: { exp: now - 10 } }), OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /exp/i);
});

test('#215 falscher Issuer ⇒ invalid', async () => {
  const r = await verifySupabaseJwt(signToken({ payload: { iss: 'https://boese.example.com/auth/v1' } }), OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /iss/i);
});

test('#215 falsche Audience ⇒ invalid', async () => {
  const r = await verifySupabaseJwt(signToken({ payload: { aud: 'anon' } }), OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /aud/i);
});

test('#215 Signatur mit fremdem Schlüssel ⇒ invalid', async () => {
  const evil = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'ES256', typ: 'JWT', kid: KID };
  const p = { iss: ISSUER, aud: 'authenticated', email: 'x@y.z', iat: now, exp: now + 3600 };
  const input = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: evil.privateKey, dsaEncoding: 'ieee-p1363' });
  const r = await verifySupabaseJwt(`${input}.${b64url(sig)}`, OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /signat/i);
});

test('#215 manipulierte Payload ⇒ invalid (Signatur deckt Payload)', async () => {
  const token = signToken();
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64url(JSON.stringify({ iss: ISSUER, aud: 'authenticated', email: 'admin@attacker.com', exp: Math.floor(Date.now() / 1000) + 3600 }))}.${s}`;
  const r = await verifySupabaseJwt(forged, OPTS);
  assert.equal(r.valid, false);
});

test('#215 unbekannte kid ⇒ invalid (kein Schlüssel-Raten)', async () => {
  const r = await verifySupabaseJwt(signToken({ header: { kid: 'unbekannt' } }), OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /kid|key/i);
});

test('#215 Algorithmus-Downgrade (alg:none / HS256) ⇒ invalid', async () => {
  for (const alg of ['none', 'HS256']) {
    const h = { alg, typ: 'JWT', kid: KID };
    const p = { iss: ISSUER, aud: 'authenticated', email: 'x@y.z', exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}.`;
    const r = await verifySupabaseJwt(token, OPTS);
    assert.equal(r.valid, false, `alg=${alg} muss abgelehnt werden`);
  }
});

test('#215 Müll/leer/fehlendes Token ⇒ invalid, wirft nie', async () => {
  for (const garbage of ['', null, undefined, 'kein.jwt', 'a.b.c', 'x'.repeat(5000)]) {
    const r = await verifySupabaseJwt(garbage, OPTS);
    assert.equal(r.valid, false);
  }
});

test('#215 JWKS-Fetch-Fehler ⇒ invalid (fail-closed, wirft nicht)', async () => {
  const { clearJwksCache } = require('../lib/supabase-auth.js');
  clearJwksCache(); // sonst bedient der Modul-Cache die Anfrage aus früheren Tests
  const r = await verifySupabaseJwt(signToken(), { issuer: ISSUER, fetchJwks: async () => { throw new Error('netz weg'); } });
  assert.equal(r.valid, false);
});

// ── resolveAuthMode (Doppelpfad-Schalter) ─────────────────────────────────────

test('#215 resolveAuthMode: Default tailscale; supabase nur explizit', () => {
  assert.equal(resolveAuthMode({}), 'tailscale');
  assert.equal(resolveAuthMode({ DASHBOARD_AUTH_MODE: '' }), 'tailscale');
  assert.equal(resolveAuthMode({ DASHBOARD_AUTH_MODE: 'tailscale' }), 'tailscale');
  assert.equal(resolveAuthMode({ DASHBOARD_AUTH_MODE: 'supabase' }), 'supabase');
  assert.equal(resolveAuthMode({ DASHBOARD_AUTH_MODE: ' SUPABASE ' }), 'supabase');
  assert.equal(resolveAuthMode({ DASHBOARD_AUTH_MODE: 'unsinn' }), 'tailscale');
});

test('#C1 (Audit) resolveAuthMode FAIL-CLOSED: SUPABASE_URL erzwingt supabase — Header-Auth-Riegel', () => {
  // Cloud-Kontext (SUPABASE_URL gesetzt) ⇒ IMMER supabase, egal was AUTH_MODE sagt.
  assert.equal(resolveAuthMode({ SUPABASE_URL: 'https://x.supabase.co' }), 'supabase',
    'vergessenes AUTH_MODE in der Cloud ⇒ trotzdem supabase (kein Header-Spoofing)');
  assert.equal(resolveAuthMode({ SUPABASE_URL: 'https://x.supabase.co', DASHBOARD_AUTH_MODE: 'tailscale' }), 'supabase',
    'selbst explizit tailscale wird in der Cloud zu supabase überstimmt');
  assert.equal(resolveAuthMode({ SUPABASE_URL: 'https://x.supabase.co', DASHBOARD_AUTH_MODE: 'unsinn' }), 'supabase');
  // Mini/Heimnetz (kein SUPABASE_URL) bleibt unverändert tailscale.
  assert.equal(resolveAuthMode({ SUPABASE_URL: '' }), 'tailscale', 'leeres SUPABASE_URL ⇒ Mini-Pfad');
  assert.equal(resolveAuthMode({ DASHBOARD_AUTH_MODE: 'tailscale' }), 'tailscale', 'Mini ohne SUPABASE_URL unverändert');
});

// ── extractBearerToken ────────────────────────────────────────────────────────

test('#215 extractBearerToken: Bearer-Schema, sonst leer', () => {
  assert.equal(extractBearerToken({ authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(extractBearerToken({ authorization: 'bearer abc' }), 'abc');
  assert.equal(extractBearerToken({ authorization: 'Basic dXNlcg==' }), '');
  assert.equal(extractBearerToken({}), '');
  assert.equal(extractBearerToken(null), '');
});

// ── identityLogin (Kern-Sicherheitsregel der Naht) ────────────────────────────

test('#215 identityLogin: supabase-Mode nutzt NUR das verifizierte JWT, nie den Tailscale-Header', () => {
  // JWT vorhanden ⇒ JWT-Identität.
  assert.equal(
    identityLogin({ authMode: 'supabase', jwtEmail: 'echt@kunde.de', tailscaleLogin: 'gefaelscht@attacker.com' }),
    'echt@kunde.de');
  // Kein/ungültiges JWT ⇒ KEINE Identität (Default-Deny) — Header wird ignoriert.
  assert.equal(
    identityLogin({ authMode: 'supabase', jwtEmail: null, tailscaleLogin: 'patrickmatthes2609@gmail.com' }),
    '');
});

test('#215 identityLogin: tailscale-Mode unverändert (Header zählt, JWT nicht)', () => {
  assert.equal(
    identityLogin({ authMode: 'tailscale', jwtEmail: 'wer@auch.immer', tailscaleLogin: 'patrickmatthes2609@gmail.com' }),
    'patrickmatthes2609@gmail.com');
});

// ── Integration: verifizierte JWT-Identität fließt in resolveViewer ───────────

test('#215 Ende-zu-Ende (DB-frei): JWT-E-Mail ⇒ resolveViewer ⇒ Rolle + Mandant aus Registry', async () => {
  const { resolveViewer } = require('../lib/auth.js');
  const r = await verifySupabaseJwt(signToken(), OPTS);
  assert.equal(r.valid, true);
  const dir = {
    loginTenant: (l) => (l === 'patrickmatthes2609@gmail.com' ? 't_faltrix' : null),
    isPlatformAdmin: (l) => l === 'patrickmatthes2609@gmail.com',
    tenantExists: (tid) => tid === 't_faltrix',
  };
  const v = resolveViewer({
    login: identityLogin({ authMode: 'supabase', jwtEmail: r.email, tailscaleLogin: 'spoof@evil.com' }),
    remoteAddress: '34.159.1.1',
    env: { DASHBOARD_ADMIN_LOGIN: 'patrickmatthes2609@gmail.com' },
    directory: dir,
  });
  assert.equal(v.role, 'admin');
  assert.equal(v.tenantId, 't_faltrix');
  // Ohne JWT (jwtEmail null): Default-Deny trotz Spoof-Header.
  const g = resolveViewer({
    login: identityLogin({ authMode: 'supabase', jwtEmail: null, tailscaleLogin: 'patrickmatthes2609@gmail.com' }),
    remoteAddress: '34.159.1.1',
    env: { DASHBOARD_ADMIN_LOGIN: 'patrickmatthes2609@gmail.com' },
    directory: dir,
  });
  assert.equal(g.role, 'guest');
  assert.equal(g.tenantId, null);
});
