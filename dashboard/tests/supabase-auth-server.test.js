'use strict';

/**
 * Issue #215 (Cloud-Slice 2 — Auth-Naht): Spawned-Server-Beweis des Doppelpfads.
 * --------------------------------------------------------------------------------
 * Startet den echten server.js mit DASHBOARD_AUTH_MODE=supabase und einem lokalen
 * JWKS-Stub-Server (Systemgrenze Supabase wird simuliert — gleiches Muster wie
 * die n8n-Stubs in den v2-Tests). Beweist:
 *  1. Gültiges Bearer-JWT ⇒ Identität verifiziert ⇒ Rolle aus der Allowlist.
 *  2. Spoofbarer Tailscale-Header wird im supabase-Mode IGNORIERT (Default-Deny).
 *  3. Ungültiges/abgelaufenes JWT ⇒ Gast (kein impliziter Eigentümer-Zugang).
 *  4. /api/v2/auth/config liefert mode/supabaseUrl/anonKey fürs Login-Frontend.
 *  5. Tailscale-Mode (Default) bleibt unverändert (Regression).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ADMIN = 'cloud-admin@example.test';

// ── ES256-Schlüssel + Token-Fabrik (wie Supabase) ─────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'spawned-kid';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken(issuer, payloadOverride = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'ES256', typ: 'JWT', kid: KID };
  const p = {
    iss: issuer, aud: 'authenticated', sub: 'u-1', email: ADMIN,
    iat: now, exp: now + 3600, ...payloadOverride,
  };
  const input = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function startJwksServer(port) {
  const jwk = publicKey.export({ format: 'jwk' });
  const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] });
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.includes('jwks')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); return; }
      res.writeHead(404); res.end('{}');
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject);
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'test-key',
      DASHBOARD_V2_PG_URL: '', DASHBOARD_V2_APP_PG_URL: '',
      DASHBOARD_ADMIN_LOGIN: ADMIN,
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); } });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

test('#215 Spawned-Server: Doppelpfad supabase — JWT zählt, Tailscale-Header nie', async () => {
  const jwksPort = await getFreePort();
  const appPort = await getFreePort();
  const supabaseUrl = `http://127.0.0.1:${jwksPort}`;
  const issuer = `${supabaseUrl}/auth/v1`;
  const jwks = await startJwksServer(jwksPort);
  const child = await startDashboard(appPort, {
    DASHBOARD_AUTH_MODE: 'supabase',
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: 'anon-test-key',
  });
  try {
    // 1) Gültiges JWT ⇒ Admin (Allowlist DASHBOARD_ADMIN_LOGIN, Identität aus JWT).
    const ok = await request(appPort, '/api/v2/viewer', { authorization: `Bearer ${signToken(issuer)}` });
    assert.equal(ok.status, 200);
    const okViewer = JSON.parse(ok.body).viewer;
    assert.equal(okViewer.role, 'admin', 'verifiziertes JWT ⇒ Admin-Rolle');
    assert.equal(okViewer.login, ADMIN, 'Identität = JWT-E-Mail');

    // 2) NUR Spoof-Header, kein JWT ⇒ Gast (Header wird im supabase-Mode ignoriert).
    const spoof = await request(appPort, '/api/v2/viewer', { 'tailscale-user-login': ADMIN });
    assert.equal(JSON.parse(spoof.body).viewer.role, 'guest', 'Spoof-Header ergibt KEINE Identität');

    // 3) Abgelaufenes JWT ⇒ Gast (Default-Deny).
    const expired = await request(appPort, '/api/v2/viewer', {
      authorization: `Bearer ${signToken(issuer, { exp: Math.floor(Date.now() / 1000) - 5 })}`,
    });
    assert.equal(JSON.parse(expired.body).viewer.role, 'guest', 'abgelaufenes JWT ⇒ Gast');

    // 4) Manipuliertes JWT (fremder Schlüssel über Payload-Tausch) ⇒ Gast.
    const token = signToken(issuer);
    const [h, , s] = token.split('.');
    const forgedPayload = b64url(JSON.stringify({ iss: issuer, aud: 'authenticated', email: ADMIN, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const forged = await request(appPort, '/api/v2/viewer', { authorization: `Bearer ${h}.${forgedPayload}.${s}` });
    assert.equal(JSON.parse(forged.body).viewer.role, 'guest', 'manipuliertes JWT ⇒ Gast');

    // 5) Login-Frontend-Konfiguration.
    const cfg = await request(appPort, '/api/v2/auth/config');
    assert.equal(cfg.status, 200);
    const cfgBody = JSON.parse(cfg.body);
    assert.equal(cfgBody.mode, 'supabase');
    assert.equal(cfgBody.supabaseUrl, supabaseUrl);
    assert.equal(cfgBody.anonKey, 'anon-test-key');

    // 6) Login-Wand: /login liefert die minimale v3-Login-Seite (Reset inklusive).
    const login = await request(appPort, '/login');
    assert.equal(login.status, 200);
    assert.match(login.body, /form-login/, 'Login-Formular vorhanden');
    assert.match(login.body, /form-reset/, 'Passwort-Reset-Formular vorhanden');
    assert.match(login.body, /form-recover/, 'Recovery-Formular (neues Passwort) vorhanden');
  } finally {
    child.kill();
    jwks.close();
  }
});

test('#215 Spawned-Server: Default-Mode tailscale unverändert (Regression + config)', async () => {
  const appPort = await getFreePort();
  const child = await startDashboard(appPort, {}); // kein DASHBOARD_AUTH_MODE
  try {
    const ok = await request(appPort, '/api/v2/viewer', { 'tailscale-user-login': ADMIN });
    assert.equal(JSON.parse(ok.body).viewer.role, 'admin', 'Tailscale-Pfad funktioniert wie bisher');
    const cfg = await request(appPort, '/api/v2/auth/config');
    assert.equal(JSON.parse(cfg.body).mode, 'tailscale');
  } finally {
    child.kill();
  }
});
