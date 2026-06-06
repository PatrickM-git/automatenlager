'use strict';

// Issue #27: Identitäts-Auflösung + Default-Deny + F1 (pfad-basiertes Vertrauen).
// Reine, DB-freie Funktion, damit alle Fälle (inkl. Quelladresse) unit-testbar
// sind. `getViewer(req)` in server.js ruft `resolveViewer` mit extrahierten
// Request-Feldern auf. Das volle RBAC-Modell (3 Rollen, Endpunkt-Guards, Frontend)
// folgt in #28/#29; hier liegt das Fundament: Default-Deny, exakte Allowlist,
// Fähigkeiten + can(), tenantId, abwärtskompatibles canTriggerActions.

// Issue #117 (Stufe 2): Die hartcodierte Konstante TENANT_OWNER='eigentuemer' als
// Default-Mandant ist ENTFERNT. Der reale Mandant kommt jetzt aus der Mandanten-
// Registry (lib/tenant-directory.js) via `directory.loginTenant(login)` — kein
// Default mehr (fehlt der Mandant ⇒ null ⇒ deny).

// Issue #28: kanonisches Fähigkeiten-Vokabular (6 Verben, SPEC Säule 3).
const ALL_CAPABILITIES = [
  'betrieb.lesen',
  'finanzen.lesen',
  'bestand.schreiben',
  'workflows.starten',
  'nayax.schreiben',
  'system.verwalten',
];

// Vier Voreinstellungs-Rollen → Fähigkeits-Bündel.
//  - eigentuemer: alle (voller Admin)
//  - partner:     Betrieb + Finanzen lesen (alles sehen, nichts schreiben);
//                 via DASHBOARD_PARTNER_LOGIN konfiguriert
//  - auffueller:  Betrieb lesen + Bestand/Slots schreiben + Workflows auslösen;
//                 NICHT finanzen.lesen / nayax.schreiben / system.verwalten
//  - gast:        nur betrieb.lesen
const ROLE_CAPABILITIES = {
  eigentuemer: [...ALL_CAPABILITIES],
  partner: ['betrieb.lesen', 'finanzen.lesen'],
  auffueller: ['betrieb.lesen', 'bestand.schreiben', 'workflows.starten'],
  gast: ['betrieb.lesen'],
};
const GUEST_CAPABILITIES = ROLE_CAPABILITIES.gast;

function clean(value) {
  return String(value == null ? '' : value).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function isLoopback(remoteAddress) {
  const a = clean(remoteAddress).toLowerCase();
  // Leere Quelladresse (z. B. Unit-Test ohne Socket) wie Loopback behandeln.
  return a === '' || a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function ipv4ToInt(ip) {
  const parts = clean(ip).replace(/^::ffff:/i, '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const o = Number(part);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

// IPv4-CIDR-Match (eine oder mehrere, komma-getrennt). IPv6-Nicht-Loopback wird
// nicht gematcht (gibt false → gilt als vertrauenswürdig, da keine bekannte
// interne IPv6-Peer-Konvention; konservativ).
function ipInCidr(ip, cidrList) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt == null) return false;
  for (const cidr of String(cidrList).split(',').map((c) => c.trim()).filter(Boolean)) {
    const [base, bitsRaw] = cidr.split('/');
    const baseInt = ipv4ToInt(base);
    const bits = Number(bitsRaw);
    if (baseInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipInt & mask) === (baseInt & mask)) return true;
  }
  return false;
}

// F1 (pfad-basiertes Vertrauen): Darf der `Tailscale-*`-Header dieser Quelladresse
// vertraut werden? KONSERVATIVER Default: ja (kein Serve-Aussperr-Risiko). Erst
// wenn `DASHBOARD_INTERNAL_PEER_CIDR` gesetzt ist, gelten Quelladressen aus diesem
// Bereich als interner Docker-Peer (z. B. WF-Monitor → homelab-dashboard:8787) →
// Header werden verworfen, der Aufruf gilt als Gast/read-only. Loopback und
// DASHBOARD_TRUSTED_SERVE_IP (Docker-Bridge-Gateway des Tailscale-Serve-Pfads)
// werden immer vertraut, auch wenn sie im CIDR liegen.
function isTrustedIdentityPath(remoteAddress, env = {}) {
  const cidr = clean(env.DASHBOARD_INTERNAL_PEER_CIDR);
  if (!cidr) return true;
  if (isLoopback(remoteAddress)) return true;
  const serveIp = clean(env.DASHBOARD_TRUSTED_SERVE_IP || '');
  if (serveIp) {
    const bare = clean(remoteAddress).replace(/^::ffff:/i, '');
    if (bare === serveIp || remoteAddress === serveIp) return true;
  }
  return !ipInCidr(remoteAddress, cidr);
}

function parseLoginList(value) {
  return clean(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

// Issue #28: Rolle (eigentuemer/partner/auffueller/gast) aus der konfigurativen
// Login-Zuordnung ableiten. Neue Logins werden ohne Code-Änderung über Env-Vars
// zugewiesen. Reihenfolge: eigentuemer > partner > auffueller > gast.
//  DASHBOARD_ADMIN_LOGIN   — Eigentümer (alle Rechte)
//  DASHBOARD_PARTNER_LOGIN — Partner (betrieb.lesen + finanzen.lesen, kein Schreiben)
//  DASHBOARD_OPERATOR_LOGIN — Auffüller (betrieb.lesen + bestand.schreiben + workflows)
// Default-Deny bleibt: alles andere ist Gast.
function resolveRole({ normalizedLogin, remoteAddress, env }) {
  if (normalizedLogin) {
    if (parseLoginList(env.DASHBOARD_ADMIN_LOGIN).includes(normalizedLogin)) return 'eigentuemer';
    if (parseLoginList(env.DASHBOARD_PARTNER_LOGIN).includes(normalizedLogin)) return 'partner';
    if (parseLoginList(env.DASHBOARD_OPERATOR_LOGIN).includes(normalizedLogin)) return 'auffueller';
    return 'gast';
  }
  // Kein (vertrauenswürdiger) Header: Default-Deny. Einziger Admin-Pfad ohne
  // Header ist der Dev-Notausgang (Loopback + explizites Flag, Prod: aus).
  const devLocalAdmin = clean(env.DASHBOARD_DEV_LOCAL_ADMIN) !== '';
  if (devLocalAdmin && isLoopback(remoteAddress)) return 'eigentuemer';
  return 'gast';
}

// Liefert {login, role, roleKey, capabilities:Set, homeTenantId, tenantId,
// isPlatformAdmin, requestId, can(cap), canTriggerActions}.
// `role` bleibt binär ('admin'|'guest') für Abwärtskompatibilität (is_admin, UI);
// `roleKey` trägt die 3 Rollen; `capabilities`/`can` sind die eigentliche Autorität.
//
// Issue #117 (Stufe 2): `directory` (Mandanten-Registry, optional injiziert) liefert
// den realen Heimat-Mandanten synchron aus dem Cache. resolveViewer BLEIBT synchron.
// Ohne directory oder ohne Mapping ⇒ tenantId=null (KEIN TENANT_OWNER-Default mehr).
function resolveViewer({ login, remoteAddress, host, env = {}, directory = null, requestId = null } = {}) {
  void host; // Rolle hängt an der nicht-fälschbaren Quelladresse, nicht am Host-Header.
  const headerTrusted = isTrustedIdentityPath(remoteAddress, env);
  // F1: über einen nicht vertrauenswürdigen Pfad wird der Header verworfen.
  const effectiveLogin = headerTrusted ? clean(login) : '';
  const normalizedLogin = effectiveLogin.toLowerCase();

  const roleKey = resolveRole({ normalizedLogin, remoteAddress, env });
  const capabilities = new Set(ROLE_CAPABILITIES[roleKey] || ROLE_CAPABILITIES.gast);
  const can = (capability) => capabilities.has(capability);
  const isAdmin = roleKey === 'eigentuemer';

  const dirLoginTenant = directory && typeof directory.loginTenant === 'function'
    ? (l) => directory.loginTenant(l) : null;
  const dirIsPlatformAdmin = directory && typeof directory.isPlatformAdmin === 'function'
    ? (l) => directory.isPlatformAdmin(l) : null;

  // Login für die Mandanten-Auflösung. Beim Dev-Notausgang (Loopback + Flag, kein
  // Header-Login, aber roleKey=eigentuemer) den ersten konfigurierten Admin-Login
  // nehmen, damit der Eigentümer-Mandant (t_faltrix) aufgelöst wird — die
  // Lockout-Recovery auf dem Mini bleibt erhalten (User Story 16).
  let lookupLogin = normalizedLogin;
  if (!lookupLogin && isAdmin) {
    lookupLogin = parseLoginList(env.DASHBOARD_ADMIN_LOGIN)[0] || '';
  }

  const homeTenantId = (dirLoginTenant && lookupLogin) ? dirLoginTenant(lookupLogin) : null;
  const isPlatformAdmin = !!(dirIsPlatformAdmin && lookupLogin && dirIsPlatformAdmin(lookupLogin));
  const tenantId = homeTenantId; // effektiver Mandant; Break-Glass-Override erst in #118

  return {
    login: effectiveLogin || (isAdmin ? 'local-admin' : 'guest'),
    role: isAdmin ? 'admin' : 'guest',
    roleKey,
    capabilities,
    homeTenantId,
    tenantId,
    isPlatformAdmin,
    requestId: requestId || null,
    can,
    canTriggerActions: can('workflows.starten'),
  };
}

// Issue #28: zentrale Fähigkeits-Prüfung (rein). Der HTTP-403-Guard in server.js
// (requireCapability mit res) baut darauf auf.
function viewerCan(viewer, capability) {
  return !!(viewer && typeof viewer.can === 'function' && viewer.can(capability));
}

// Issue #33/#117 (IDOR / Objekt-Ebene): Darf dieser Viewer auf ein Objekt zugreifen,
// das dem Mandanten `objectTenantId` gehört? Zweite Hälfte der Zugriffskontrolle
// neben RBAC (requireCapability prüft die VERB-Ebene, das hier die OBJEKT-Ebene).
//
// Gehärtet in Stufe 2 (#117): liefert NUR dann true, wenn `viewer.tenantId`
// nicht-null ist UND exakt `objectTenantId` entspricht. Ein fehlender/leerer/null
// Objekt-Mandant ⇒ false (deny). Die frühere „null ⇒ Eigentümer"-Annahme entfällt
// — sonst würde der null-Rückgabewert von machineTenant (unbekannte Maschine)
// zurück in „gehört dem Eigentümer" gerettet (IDOR-Leck).
function objectAccessAllowed(viewer, objectTenantId) {
  if (!viewer || !viewer.tenantId) return false;
  if (objectTenantId == null || objectTenantId === '') return false; // kein Default mehr
  return viewer.tenantId === objectTenantId;
}

module.exports = {
  resolveViewer,
  viewerCan,
  objectAccessAllowed,
  isTrustedIdentityPath,
  isLoopback,
  ipInCidr,
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  GUEST_CAPABILITIES,
};
