'use strict';

// Issue #27: Identitäts-Auflösung + Default-Deny + F1 (pfad-basiertes Vertrauen).
// Reine, DB-freie Funktion, damit alle Fälle (inkl. Quelladresse) unit-testbar
// sind. `getViewer(req)` in server.js ruft `resolveViewer` mit extrahierten
// Request-Feldern auf. Das volle RBAC-Modell (3 Rollen, Endpunkt-Guards, Frontend)
// folgt in #28/#29; hier liegt das Fundament: Default-Deny, exakte Allowlist,
// Fähigkeiten + can(), tenantId, abwärtskompatibles canTriggerActions.

const TENANT_OWNER = 'eigentuemer';

// Fähigkeiten-Vokabular (Fundament). Admin = alle, Gast = nur Lesen.
const ALL_CAPABILITIES = [
  'betrieb.lesen',
  'workflows.starten',
  'inventar.schreiben',
  'einstellungen.schreiben',
  'system.verwalten',
  'mandant.verwalten',
];
const GUEST_CAPABILITIES = ['betrieb.lesen'];

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

// Liefert {login, role, capabilities:Set, tenantId, can(cap), canTriggerActions}.
function resolveViewer({ login, remoteAddress, host, env = {} } = {}) {
  void host; // Rolle hängt an der nicht-fälschbaren Quelladresse, nicht am Host-Header.
  const headerTrusted = isTrustedIdentityPath(remoteAddress, env);
  // F1: über einen nicht vertrauenswürdigen Pfad wird der Header verworfen.
  const effectiveLogin = headerTrusted ? clean(login) : '';
  const normalizedLogin = effectiveLogin.toLowerCase();

  const configuredAdmins = clean(env.DASHBOARD_ADMIN_LOGIN)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  let isAdmin;
  if (normalizedLogin) {
    // Header vorhanden (vertrauenswürdiger Pfad): EXAKTE Allowlist. Keine
    // Präfix-Regel mehr — `patrick-evil@…` ist Gast, sofern nicht exakt gelistet.
    isAdmin = configuredAdmins.includes(normalizedLogin);
  } else {
    // Default-Deny: ohne (vertrauenswürdigen) Header = Gast. Einziger Admin-Pfad
    // ohne Header ist der Dev-Notausgang: Loopback + explizites Flag (Prod: aus).
    const devLocalAdmin = clean(env.DASHBOARD_DEV_LOCAL_ADMIN) !== '';
    isAdmin = devLocalAdmin && isLoopback(remoteAddress);
  }

  const capabilities = new Set(isAdmin ? ALL_CAPABILITIES : GUEST_CAPABILITIES);
  const can = (capability) => capabilities.has(capability);

  return {
    login: effectiveLogin || (isAdmin ? 'local-admin' : 'guest'),
    role: isAdmin ? 'admin' : 'guest',
    capabilities,
    tenantId: TENANT_OWNER,
    can,
    canTriggerActions: can('workflows.starten'),
  };
}

module.exports = {
  resolveViewer,
  isTrustedIdentityPath,
  isLoopback,
  ipInCidr,
  TENANT_OWNER,
  ALL_CAPABILITIES,
  GUEST_CAPABILITIES,
};
