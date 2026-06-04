'use strict';

// Issue #27: Identitäts-Auflösung + Default-Deny + F1 (pfad-basiertes Vertrauen).
// Reine, DB-freie Funktion, damit alle Fälle (inkl. Quelladresse) unit-testbar
// sind. `getViewer(req)` in server.js ruft `resolveViewer` mit extrahierten
// Request-Feldern auf. Das volle RBAC-Modell (3 Rollen, Endpunkt-Guards, Frontend)
// folgt in #28/#29; hier liegt das Fundament: Default-Deny, exakte Allowlist,
// Fähigkeiten + can(), tenantId, abwärtskompatibles canTriggerActions.

const TENANT_OWNER = 'eigentuemer';

// Issue #28: kanonisches Fähigkeiten-Vokabular (6 Verben, SPEC Säule 3).
const ALL_CAPABILITIES = [
  'betrieb.lesen',
  'finanzen.lesen',
  'bestand.schreiben',
  'workflows.starten',
  'nayax.schreiben',
  'system.verwalten',
];

// Drei Voreinstellungs-Rollen → Fähigkeits-Bündel.
//  - eigentuemer: alle (voller Admin)
//  - auffueller:  Betrieb lesen + Bestand/Slots schreiben + Workflows auslösen;
//                 NICHT finanzen.lesen / nayax.schreiben / system.verwalten
//  - gast:        nur betrieb.lesen
const ROLE_CAPABILITIES = {
  eigentuemer: [...ALL_CAPABILITIES],
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
// Header werden verworfen, der Aufruf gilt als Gast/read-only. Loopback (Serve-/
// Host-Pfad) wird immer vertraut.
function isTrustedIdentityPath(remoteAddress, env = {}) {
  const cidr = clean(env.DASHBOARD_INTERNAL_PEER_CIDR);
  if (!cidr) return true;
  if (isLoopback(remoteAddress)) return true;
  return !ipInCidr(remoteAddress, cidr);
}

function parseLoginList(value) {
  return clean(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

// Issue #28: Rolle (eigentuemer/auffueller/gast) aus der konfigurativen Login-
// Zuordnung ableiten. Neue Logins werden ohne Code-Änderung über die Env
// DASHBOARD_ADMIN_LOGIN (Eigentümer) bzw. DASHBOARD_OPERATOR_LOGIN (Auffüller)
// zugewiesen. Default-Deny bleibt: alles andere ist Gast.
function resolveRole({ normalizedLogin, remoteAddress, env }) {
  if (normalizedLogin) {
    if (parseLoginList(env.DASHBOARD_ADMIN_LOGIN).includes(normalizedLogin)) return 'eigentuemer';
    if (parseLoginList(env.DASHBOARD_OPERATOR_LOGIN).includes(normalizedLogin)) return 'auffueller';
    return 'gast';
  }
  // Kein (vertrauenswürdiger) Header: Default-Deny. Einziger Admin-Pfad ohne
  // Header ist der Dev-Notausgang (Loopback + explizites Flag, Prod: aus).
  const devLocalAdmin = clean(env.DASHBOARD_DEV_LOCAL_ADMIN) !== '';
  if (devLocalAdmin && isLoopback(remoteAddress)) return 'eigentuemer';
  return 'gast';
}

// Liefert {login, role, roleKey, capabilities:Set, tenantId, can(cap), canTriggerActions}.
// `role` bleibt binär ('admin'|'guest') für Abwärtskompatibilität (is_admin, UI);
// `roleKey` trägt die 3 Rollen; `capabilities`/`can` sind die eigentliche Autorität.
function resolveViewer({ login, remoteAddress, host, env = {} } = {}) {
  void host; // Rolle hängt an der nicht-fälschbaren Quelladresse, nicht am Host-Header.
  const headerTrusted = isTrustedIdentityPath(remoteAddress, env);
  // F1: über einen nicht vertrauenswürdigen Pfad wird der Header verworfen.
  const effectiveLogin = headerTrusted ? clean(login) : '';
  const normalizedLogin = effectiveLogin.toLowerCase();

  const roleKey = resolveRole({ normalizedLogin, remoteAddress, env });
  const capabilities = new Set(ROLE_CAPABILITIES[roleKey] || ROLE_CAPABILITIES.gast);
  const can = (capability) => capabilities.has(capability);
  const isAdmin = roleKey === 'eigentuemer';

  return {
    login: effectiveLogin || (isAdmin ? 'local-admin' : 'guest'),
    role: isAdmin ? 'admin' : 'guest',
    roleKey,
    capabilities,
    tenantId: TENANT_OWNER,
    can,
    canTriggerActions: can('workflows.starten'),
  };
}

// Issue #28: zentrale Fähigkeits-Prüfung (rein). Der HTTP-403-Guard in server.js
// (requireCapability mit res) baut darauf auf.
function viewerCan(viewer, capability) {
  return !!(viewer && typeof viewer.can === 'function' && viewer.can(capability));
}

// Issue #33 (IDOR / Objekt-Ebene): Darf dieser Viewer auf ein Objekt zugreifen,
// das dem Mandanten `objectTenantId` gehört? Zweite Hälfte der Zugriffskontrolle
// neben RBAC (requireCapability prüft die VERB-Ebene, das hier die OBJEKT-Ebene).
// Single-Tenant: alle Objekte gehören dem Eigentümer; fehlt der Objekt-Mandant,
// wird TENANT_OWNER angenommen → der Eigentümer kommt durch, Fremd-Mandanten nicht.
// Sobald echte Tenancy existiert, wird objectTenantId aus der DB-Zeile gelesen
// (z. B. machines.tenant_id) — das bildet später Supabase-RLS ab.
function objectAccessAllowed(viewer, objectTenantId) {
  if (!viewer || !viewer.tenantId) return false;
  const owner = objectTenantId == null || objectTenantId === '' ? TENANT_OWNER : objectTenantId;
  return viewer.tenantId === owner;
}

module.exports = {
  resolveViewer,
  viewerCan,
  objectAccessAllowed,
  isTrustedIdentityPath,
  isLoopback,
  ipInCidr,
  TENANT_OWNER,
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  GUEST_CAPABILITIES,
};
