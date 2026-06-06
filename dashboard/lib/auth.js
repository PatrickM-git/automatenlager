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

// Issue #118: Lese-Teilmenge der Fähigkeiten (alle `*.lesen`). Bei aktiver Break-
// Glass-Support-Sitzung werden die Fähigkeiten des Viewers hierauf reduziert
// (Capability-Stripping) ⇒ Schreib-Endpunkte hinter requireCapability liefern 403.
const READ_CAPABILITIES = ALL_CAPABILITIES.filter((c) => c.endsWith('.lesen'));

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
function resolveViewer({ login, remoteAddress, host, env = {}, directory = null, requestId = null, supportTenant = null } = {}) {
  void host; // Rolle hängt an der nicht-fälschbaren Quelladresse, nicht am Host-Header.
  const headerTrusted = isTrustedIdentityPath(remoteAddress, env);
  // F1: über einen nicht vertrauenswürdigen Pfad wird der Header verworfen.
  const effectiveLogin = headerTrusted ? clean(login) : '';
  const normalizedLogin = effectiveLogin.toLowerCase();

  const roleKey = resolveRole({ normalizedLogin, remoteAddress, env });
  const capabilities = new Set(ROLE_CAPABILITIES[roleKey] || ROLE_CAPABILITIES.gast);
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
  const dirTenantExists = directory && typeof directory.tenantExists === 'function'
    ? (tid) => directory.tenantExists(tid) : null;

  // #118: Break-Glass-Support-Sitzung aus dem (client-kontrollierten) Header
  // X-Support-Tenant. Per-Request, NICHT klebrig. Wirksam nur wenn ALLE gelten:
  // (a) vertrauenswürdiger Identity-Pfad, (b) Plattform-Admin, (c) Ziel-Mandant
  // existiert. Sonst ignoriert; `denyReason` trägt den Grund fürs Audit/Statuscode.
  const requestedTarget = clean(supportTenant);
  const supportSession = { requested: false, active: false, targetTenant: null, denyReason: null };
  if (requestedTarget) {
    supportSession.requested = true;
    supportSession.targetTenant = requestedTarget;
    if (!headerTrusted) supportSession.denyReason = 'untrusted_path';
    else if (!isPlatformAdmin) supportSession.denyReason = 'not_admin';
    else if (!(dirTenantExists && dirTenantExists(requestedTarget))) supportSession.denyReason = 'tenant_not_found';
    else supportSession.active = true;
  }

  // Effektiver Mandant + Fähigkeiten. Bei aktiver Support-Sitzung: Ziel-Mandant und
  // Lese-Teilmenge (Capability-Stripping) — ausnahmslos read-only, auch auf dem
  // eigenen Heimat-Mandanten.
  const effectiveCapabilities = supportSession.active
    ? new Set([...capabilities].filter((c) => READ_CAPABILITIES.includes(c)))
    : capabilities;
  const tenantId = supportSession.active ? supportSession.targetTenant : homeTenantId;
  const can = (capability) => effectiveCapabilities.has(capability);

  return {
    login: effectiveLogin || (isAdmin ? 'local-admin' : 'guest'),
    role: isAdmin ? 'admin' : 'guest',
    roleKey,
    capabilities: effectiveCapabilities,
    homeTenantId,
    tenantId,
    isPlatformAdmin,
    supportSession,
    requestId: requestId || null,
    can,
    canTriggerActions: can('workflows.starten'),
  };
}

// Issue #118: Reine Entscheidungsfunktion für die Break-Glass-Durchsetzung. Der
// Server (server.js) bildet sie auf HTTP-Status + Audit ab — kein IO hier.
//   kind:
//     'none'   — kein Support-Header ⇒ nichts tun
//     'allow'  — aktive Support-Sitzung, lesende Methode ⇒ Audit(allow), weiter
//     'block'  — Antwort senden (status/code), Audit(denied), Request stoppen
//                (404 nicht-existenter Ziel-Mandant; 403 Schreibversuch unter Override)
//     'ignore' — ungültiger Header (kein Admin / untrauter Pfad) ⇒ Audit(denied),
//                weiter auf dem Heimat-Mandanten (bewusst kein hartes 403)
function breakGlassDecision(viewer, method) {
  const ss = viewer && viewer.supportSession;
  if (!ss || !ss.requested) return { kind: 'none' };
  if (ss.active) {
    const writing = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
    if (writing) {
      // Methoden-Riegel (Defense-in-Depth) zusätzlich zum Capability-Stripping.
      return { kind: 'block', status: 403, code: 'SUPPORT_SESSION_READ_ONLY', auditEvent: 'break_glass_write_blocked', outcome: 'denied' };
    }
    return { kind: 'allow', auditEvent: 'break_glass_active', outcome: 'allow' };
  }
  if (ss.denyReason === 'tenant_not_found') {
    return { kind: 'block', status: 404, code: 'NOT_FOUND', auditEvent: 'break_glass_tenant_not_found', outcome: 'denied' };
  }
  return { kind: 'ignore', auditEvent: 'break_glass_ignored', outcome: 'denied' };
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
  breakGlassDecision,
  viewerCan,
  objectAccessAllowed,
  isTrustedIdentityPath,
  isLoopback,
  ipInCidr,
  ALL_CAPABILITIES,
  READ_CAPABILITIES,
  ROLE_CAPABILITIES,
  GUEST_CAPABILITIES,
};
