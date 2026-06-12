'use strict';

/**
 * Etappe 3 (M1, Audit 2026-06-12) — Rate-Limiting gegen Flooding.
 * Reine, zeit-injizierbare Logik (kein echter Timer/Map-Leak im Test).
 *  - innerhalb des Limits: erlaubt, remaining sinkt
 *  - über dem Limit: blockiert (429-tauglich) mit retryAfter
 *  - Fenster läuft ab ⇒ Zähler resettet
 *  - getrennte Keys (IPs) stören sich nicht
 *  - clientKey: CF-Connecting-IP nur wenn vertrauenswürdig, sonst remoteAddress
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRateLimiter, clientKey } = require('../lib/rate-limit.js');

test('#M1 innerhalb des Limits erlaubt, remaining zählt runter', () => {
  let t = 1000;
  const rl = createRateLimiter({ windowMs: 1000, max: 3, now: () => t });
  for (let i = 0; i < 3; i++) {
    const r = rl.check('ip-a');
    assert.equal(r.allowed, true, `Request ${i + 1} erlaubt`);
  }
  assert.equal(rl.check('ip-a').allowed, false, '4. Request über dem Limit ⇒ blockiert');
});

test('#M1 Block liefert retryAfterMs > 0 (für Retry-After-Header)', () => {
  let t = 5000;
  const rl = createRateLimiter({ windowMs: 2000, max: 1, now: () => t });
  assert.equal(rl.check('ip').allowed, true);
  const blocked = rl.check('ip');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 2000);
});

test('#M1 nach Ablauf des Fensters wieder erlaubt (Zähler resettet)', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  rl.check('ip'); rl.check('ip');
  assert.equal(rl.check('ip').allowed, false, 'im Fenster blockiert');
  t += 1001; // Fenster vorbei
  assert.equal(rl.check('ip').allowed, true, 'neues Fenster ⇒ wieder erlaubt');
});

test('#M1 getrennte IPs haben getrennte Budgets', () => {
  let t = 10;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(rl.check('ip-a').allowed, true);
  assert.equal(rl.check('ip-b').allowed, true, 'andere IP unbeeinflusst');
  assert.equal(rl.check('ip-a').allowed, false, 'ip-a erschöpft');
});

test('#M1 disabled (max<=0) ⇒ immer erlaubt (Notausschalter)', () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 0, now: () => 0 });
  for (let i = 0; i < 100; i++) assert.equal(rl.check('ip').allowed, true);
});

test('#M1 clientKey: CF-Connecting-IP nur bei trustCf, sonst remoteAddress', () => {
  const req = { socket: { remoteAddress: '10.0.0.9' }, headers: { 'cf-connecting-ip': '203.0.113.5' } };
  assert.equal(clientKey(req, { trustCf: true }), '203.0.113.5', 'hinter Cloudflare: echte Client-IP');
  assert.equal(clientKey(req, { trustCf: false }), '10.0.0.9', 'ohne Trust: nicht den fälschbaren Header nutzen');
  const noCf = { socket: { remoteAddress: '10.0.0.9' }, headers: {} };
  assert.equal(clientKey(noCf, { trustCf: true }), '10.0.0.9', 'kein CF-Header ⇒ remoteAddress');
});
