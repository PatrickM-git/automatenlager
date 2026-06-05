'use strict';

// Issue #27: Default-Deny + exakte Allowlist + Dev-Notausgang + F1-Pfadvertrauen.
// Reine Unit-Tests gegen resolveViewer (alle Fälle inkl. Quelladresse).

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveViewer, isTrustedIdentityPath, ipInCidr } = require('../lib/auth.js');

const ADMIN = 'patrickmatthes2609@gmail.com';
const adminEnv = { DASHBOARD_ADMIN_LOGIN: ADMIN };

test('Header mit exaktem Admin-Login (vertrauenswürdiger Pfad) -> Admin', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(v.role, 'admin');
  assert.equal(v.canTriggerActions, true);
  assert.equal(v.can('system.verwalten'), true);
  assert.equal(v.tenantId, 'eigentuemer');
});

test('Header mit fremdem/unbekanntem Login -> Gast', () => {
  const v = resolveViewer({ login: 'fremd@example.com', remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(v.role, 'guest');
  assert.equal(v.canTriggerActions, false);
  assert.equal(v.can('betrieb.lesen'), true);
  assert.equal(v.can('workflows.starten'), false);
});

test('Exakte Allowlist: patrick-evil@ (Präfix patrick, NICHT gelistet) -> Gast', () => {
  const v = resolveViewer({ login: 'patrick-evil@attacker.com', remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(v.role, 'guest');
});

test('Kern-Regression: kein Header + nicht-lokal -> Gast (nicht mehr Admin)', () => {
  const v = resolveViewer({ login: '', remoteAddress: '100.64.0.9', env: adminEnv });
  assert.equal(v.role, 'guest');
});

test('Kein Header + Loopback OHNE Dev-Flag -> Gast', () => {
  const v = resolveViewer({ login: '', remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(v.role, 'guest');
});

test('Kein Header + Loopback MIT Dev-Flag -> Admin (Notausgang)', () => {
  const v = resolveViewer({ login: '', remoteAddress: '127.0.0.1', env: { ...adminEnv, DASHBOARD_DEV_LOCAL_ADMIN: '1' } });
  assert.equal(v.role, 'admin');
});

test('Dev-Flag wirkt NICHT von nicht-lokaler Adresse', () => {
  const v = resolveViewer({ login: '', remoteAddress: '100.64.0.9', env: { ...adminEnv, DASHBOARD_DEV_LOCAL_ADMIN: '1' } });
  assert.equal(v.role, 'guest');
});

test('canTriggerActions ist aus Fähigkeiten abgeleitet (workflows.starten)', () => {
  const admin = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: adminEnv });
  const guest = resolveViewer({ login: 'x@y.de', remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(admin.canTriggerActions, admin.can('workflows.starten'));
  assert.equal(guest.canTriggerActions, guest.can('workflows.starten'));
  assert.equal(admin.canTriggerActions, true);
  assert.equal(guest.canTriggerActions, false);
});

// ── #28 RBAC: 3 Rollen + Fähigkeiten ───────────────────────────────────────

const OPERATOR = 'auffueller@example.com';
const rbacEnv = { DASHBOARD_ADMIN_LOGIN: ADMIN, DASHBOARD_OPERATOR_LOGIN: OPERATOR };

test('Eigentümer: alle 6 Fähigkeiten', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: rbacEnv });
  assert.equal(v.roleKey, 'eigentuemer');
  assert.equal(v.role, 'admin');
  for (const c of ['betrieb.lesen', 'finanzen.lesen', 'bestand.schreiben', 'workflows.starten', 'nayax.schreiben', 'system.verwalten']) {
    assert.equal(v.can(c), true, c);
  }
});

test('Auffüller: Bestand+Workflows, NICHT Finanzen/Nayax/System', () => {
  const v = resolveViewer({ login: OPERATOR, remoteAddress: '127.0.0.1', env: rbacEnv });
  assert.equal(v.roleKey, 'auffueller');
  assert.equal(v.role, 'guest', 'binär: Auffüller ist kein voller Admin');
  assert.equal(v.can('betrieb.lesen'), true);
  assert.equal(v.can('bestand.schreiben'), true);
  assert.equal(v.can('workflows.starten'), true);
  assert.equal(v.can('finanzen.lesen'), false);
  assert.equal(v.can('nayax.schreiben'), false);
  assert.equal(v.can('system.verwalten'), false);
});

test('Gast: nur betrieb.lesen', () => {
  const v = resolveViewer({ login: 'fremd@example.com', remoteAddress: '127.0.0.1', env: rbacEnv });
  assert.equal(v.roleKey, 'gast');
  assert.equal(v.can('betrieb.lesen'), true);
  assert.equal(v.can('bestand.schreiben'), false);
  assert.equal(v.can('workflows.starten'), false);
});

test('Rollen-Zuordnung ist konfigurativ (neuer Operator-Login ohne Code-Änderung)', () => {
  const v = resolveViewer({ login: 'neu@team.de', remoteAddress: '127.0.0.1', env: { ...rbacEnv, DASHBOARD_OPERATOR_LOGIN: `${OPERATOR},neu@team.de` } });
  assert.equal(v.roleKey, 'auffueller');
});

test('Dev-Notausgang gibt volle Eigentümer-Rolle', () => {
  const v = resolveViewer({ login: '', remoteAddress: '127.0.0.1', env: { ...rbacEnv, DASHBOARD_DEV_LOCAL_ADMIN: '1' } });
  assert.equal(v.roleKey, 'eigentuemer');
  assert.equal(v.can('system.verwalten'), true);
});

// ── F1: pfad-basiertes Vertrauen ───────────────────────────────────────────

test('F1 aus (Default, kein CIDR): Header wird überall vertraut -> kein Lockout', () => {
  const v = resolveViewer({ login: ADMIN, remoteAddress: '172.20.0.5', env: adminEnv });
  assert.equal(v.role, 'admin');
});

test('F1 an (CIDR gesetzt): gefälschter Admin-Header vom internen Peer -> Gast', () => {
  const env = { ...adminEnv, DASHBOARD_INTERNAL_PEER_CIDR: '172.20.0.0/16' };
  const v = resolveViewer({ login: ADMIN, remoteAddress: '172.20.0.5', env });
  assert.equal(v.role, 'guest', 'interner Peer darf nie Admin werden (Header verworfen)');
});

test('F1 an: derselbe Admin-Header über den Serve-/Loopback-Pfad -> Admin', () => {
  const env = { ...adminEnv, DASHBOARD_INTERNAL_PEER_CIDR: '172.20.0.0/16' };
  const v = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env });
  assert.equal(v.role, 'admin');
});

test('F1 an: Quelladresse außerhalb des Peer-CIDR bleibt vertrauenswürdig', () => {
  const env = { ...adminEnv, DASHBOARD_INTERNAL_PEER_CIDR: '172.20.0.0/16' };
  const v = resolveViewer({ login: ADMIN, remoteAddress: '100.64.0.9', env });
  assert.equal(v.role, 'admin');
});

test('isTrustedIdentityPath: Defaults + CIDR-Logik', () => {
  assert.equal(isTrustedIdentityPath('172.20.0.5', {}), true); // kein CIDR -> vertrauen
  assert.equal(isTrustedIdentityPath('172.20.0.5', { DASHBOARD_INTERNAL_PEER_CIDR: '172.20.0.0/16' }), false);
  assert.equal(isTrustedIdentityPath('127.0.0.1', { DASHBOARD_INTERNAL_PEER_CIDR: '172.20.0.0/16' }), true);
});

test('#78 TRUSTED_SERVE_IP: Gateway-IP im CIDR bleibt trusted (kein Lockout)', () => {
  const env = { DASHBOARD_INTERNAL_PEER_CIDR: '172.18.0.0/16', DASHBOARD_TRUSTED_SERVE_IP: '172.18.0.1' };
  assert.equal(isTrustedIdentityPath('172.18.0.1', env), true, 'Gateway plain IPv4 = trusted');
  assert.equal(isTrustedIdentityPath('::ffff:172.18.0.1', env), true, 'Gateway IPv6-mapped = trusted');
  assert.equal(isTrustedIdentityPath('172.18.0.3', env), false, 'interner Peer .3 = untrusted');
});

test('#78 F1 live-Szenario: Serve-Pfad via Gateway-IP behält Admin-Rolle', () => {
  const env = { ...adminEnv, DASHBOARD_INTERNAL_PEER_CIDR: '172.18.0.0/16', DASHBOARD_TRUSTED_SERVE_IP: '172.18.0.1' };
  const v = resolveViewer({ login: ADMIN, remoteAddress: '::ffff:172.18.0.1', env });
  assert.equal(v.role, 'admin', 'Serve-Pfad über Gateway behält Admin');
  const vPeer = resolveViewer({ login: ADMIN, remoteAddress: '172.18.0.3', env });
  assert.equal(vPeer.role, 'guest', 'interner Peer mit gefälschtem Header = Gast');
});

test('ipInCidr: Basisfälle inkl. ::ffff:-Präfix und Mehrfach-CIDR', () => {
  assert.equal(ipInCidr('172.20.0.5', '172.20.0.0/16'), true);
  assert.equal(ipInCidr('::ffff:172.20.0.5', '172.20.0.0/16'), true);
  assert.equal(ipInCidr('10.0.0.1', '172.20.0.0/16'), false);
  assert.equal(ipInCidr('10.0.0.1', '172.20.0.0/16, 10.0.0.0/8'), true);
});

// ── #33 IDOR / Objekt-Ebene ─────────────────────────────────────────────────

const { objectAccessAllowed } = require('../lib/auth.js');

test('#33 objectAccessAllowed: eigener Mandant darf, fremder nicht', () => {
  const owner = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(owner.tenantId, 'eigentuemer');
  assert.equal(objectAccessAllowed(owner, 'eigentuemer'), true);
  assert.equal(objectAccessAllowed(owner, 'fremder-mandant'), false, 'Fremd-Mandant-Objekt verweigert (IDOR)');
});

test('#33 objectAccessAllowed: fehlender Objekt-Mandant = Eigentümer (Single-Tenant durchlassen)', () => {
  const owner = resolveViewer({ login: ADMIN, remoteAddress: '127.0.0.1', env: adminEnv });
  assert.equal(objectAccessAllowed(owner, null), true);
  assert.equal(objectAccessAllowed(owner, ''), true);
});

test('#33 objectAccessAllowed: kein/ungültiger Viewer = verweigert', () => {
  assert.equal(objectAccessAllowed(null, 'eigentuemer'), false);
  assert.equal(objectAccessAllowed({}, 'eigentuemer'), false);
});
