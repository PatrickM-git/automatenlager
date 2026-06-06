'use strict';

// Issue #116 — Mandanten-Registry (Deep Module), Stufe 2.
// SPEC: docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md
//
// Die EINZIGE Quelle fuer Mandanten-Aufloesung im Server. Kapselt die gesamte
// Cache-Komplexitaet hinter einer kleinen, stabilen Schnittstelle, damit
// resolveViewer SYNCHRON bleiben kann (loginTenant/isPlatformAdmin/tenantExists
// rein aus dem In-Memory-Cache). machineTenant ist async (Miss-Recheck), weil
// Maschinen zur Laufzeit von n8n (Zweitschreiber) angelegt werden.
//
// In diesem Schritt (#116) NUR das Modul + Tests — es wird noch NICHT verdrahtet
// (kein Aufrufer im Produktionspfad). Die Verkabelung erfolgt im atomaren Switch
// (#117), daher ist dieses Modul gefahrlos zuerst mergebar.
//
// Fail-closed (SPEC):
//   * Initialer Load schlaegt fehl  -> init() wirft, isReady()===false; Lookups
//     liefern null/false (NIE mit leerem Verzeichnis "durchwinken").
//   * TTL-Refresh schlaegt fehl     -> letzter gueltiger Snapshot bleibt aktiv
//     (kein Zurueckfallen auf leer); Fehler wird protokolliert.
//   * machineTenant-Recheck-Fehler  -> Fehler wird PROPAGIERT (Aufrufer -> 503),
//     NIE als null/"nicht gefunden" interpretiert.

const DEFAULT_TTL_MS = 60000;
const DEFAULT_NEGATIVE_TTL_MS = 30000; // Negative-Caching gegen Probe-Amplification

function clean(v) { return String(v == null ? '' : v).trim(); }
function lc(v) { return clean(v).toLowerCase(); }

/**
 * @param {object} opts
 * @param {(sql:string, params:any[]) => Promise<{rows:any[]}>} opts.query  DB-Query (injiziert)
 * @param {number} [opts.ttlMs]           TTL-Refresh-Intervall (Default 60000, via Env in #117)
 * @param {number} [opts.negativeTtlMs]   Negative-Cache-Dauer fuer machineTenant-Misses
 * @param {() => number} [opts.now]       Uhr (injizierbar fuer Tests)
 * @param {(...a:any[]) => void} [opts.logger]  Fehler-Logger fuer geschluckte Refresh-Fehler
 */
function createTenantDirectory({ query, ttlMs, negativeTtlMs, now, logger } = {}) {
  if (typeof query !== 'function') {
    throw new TypeError('tenant-directory: query-Funktion erforderlich');
  }
  const TTL = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  const NEG_TTL = Number.isFinite(negativeTtlMs) ? negativeTtlMs : DEFAULT_NEGATIVE_TTL_MS;
  const clock = typeof now === 'function' ? now : () => Date.now();
  const log = typeof logger === 'function' ? logger : () => {};

  // Snapshot bleibt null, bis EIN Load erfolgreich war -> fail-closed bis ready.
  let snapshot = null; // { loginToTenant:Map, platformAdmins:Set, knownTenants:Set, machineToTenant:Map }
  let ready = false;
  const negativeMachineCache = new Map(); // machine_key -> expiresAtMs
  let timer = null;

  async function loadSnapshot() {
    const [users, admins, tenants, machines] = await Promise.all([
      query('SELECT login, tenant_id FROM automatenlager.tenant_users WHERE active = TRUE', []),
      query('SELECT login FROM automatenlager.platform_admins WHERE active = TRUE', []),
      query('SELECT tenant_id FROM automatenlager.tenants', []),
      query('SELECT machine_key, tenant_id FROM automatenlager.machines', []),
    ]);
    const loginToTenant = new Map();
    for (const r of users.rows) loginToTenant.set(lc(r.login), r.tenant_id);
    const platformAdmins = new Set();
    for (const r of admins.rows) platformAdmins.add(lc(r.login));
    const knownTenants = new Set();
    for (const r of tenants.rows) knownTenants.add(r.tenant_id);
    const machineToTenant = new Map();
    for (const r of machines.rows) machineToTenant.set(clean(r.machine_key), r.tenant_id);
    return { loginToTenant, platformAdmins, knownTenants, machineToTenant };
  }

  // Vollstaendiges Neuladen. WIRFT bei Fehler -> der Aufrufer entscheidet, ob
  // fail-closed (init) oder Snapshot-behalten (Timer). Bei Erfolg: Snapshot
  // ersetzt, ready=true, Negative-Cache geleert.
  async function refresh() {
    const next = await loadSnapshot();
    snapshot = next;
    ready = true;
    negativeMachineCache.clear();
    return snapshot;
  }

  // Initialer Load. Wirft bei Fehler weiter -> Server startet fail-closed (#117).
  async function init() {
    await refresh();
    return api;
  }

  // TTL-Refresh-Variante: schluckt Fehler (letzter gueltiger Snapshot bleibt
  // aktiv) und liefert true/false. Genutzt vom Timer und in #117.
  async function refreshQuietly() {
    try {
      await refresh();
      return true;
    } catch (err) {
      log('tenant-directory: TTL-Refresh fehlgeschlagen, behalte letzten Snapshot:', err && err.message);
      return false;
    }
  }

  function startAutoRefresh() {
    if (timer || !(TTL > 0)) return;
    timer = setInterval(refreshQuietly, TTL);
    if (timer.unref) timer.unref(); // darf den Prozess nicht am Beenden hindern
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isReady() { return ready; }

  // ── Synchrone Lookups (rein aus dem Cache) ────────────────────────────────
  function loginTenant(login) {
    if (!ready || !snapshot) return null; // fail-closed: nie aus leerem Verzeichnis
    const t = snapshot.loginToTenant.get(lc(login));
    return t == null ? null : t;
  }
  function isPlatformAdmin(login) {
    if (!ready || !snapshot) return false;
    return snapshot.platformAdmins.has(lc(login));
  }
  function tenantExists(tenantId) {
    if (!ready || !snapshot) return false;
    return tenantId != null && tenantId !== '' && snapshot.knownTenants.has(tenantId);
  }

  // ── Asynchroner Maschinen-Lookup (Cache + autoritativer Miss-Recheck) ──────
  async function machineTenant(machineKey) {
    const key = clean(machineKey);
    if (!key) return null;
    // 1. Cache-Hit aus dem Snapshot.
    if (snapshot && snapshot.machineToTenant.has(key)) {
      return snapshot.machineToTenant.get(key);
    }
    // 2. Negative-Cache: kuerzlich als "nicht gefunden" markiert -> keine DB-Last.
    const negExp = negativeMachineCache.get(key);
    if (negExp != null && negExp > clock()) return null;
    // 3. Autoritativer Einzel-DB-Recheck. Ein TECHNISCHER Fehler propagiert hier
    //    (await wirft) -> NIE als null interpretiert (fail-closed, Aufrufer 503).
    const res = await query('SELECT tenant_id FROM automatenlager.machines WHERE machine_key = $1', [key]);
    if (res.rows.length > 0 && res.rows[0].tenant_id != null) {
      const tid = res.rows[0].tenant_id;
      if (snapshot) snapshot.machineToTenant.set(key, tid); // positiv cachen
      negativeMachineCache.delete(key);
      return tid;
    }
    // 4. Wirklich nicht gefunden -> kurz negativ cachen (Probe-Amplification stoppen).
    negativeMachineCache.set(key, clock() + NEG_TTL);
    return null;
  }

  const api = {
    init,
    refresh,
    refreshQuietly,
    startAutoRefresh,
    stop,
    isReady,
    loginTenant,
    isPlatformAdmin,
    tenantExists,
    machineTenant,
  };
  return api;
}

module.exports = { createTenantDirectory, DEFAULT_TTL_MS, DEFAULT_NEGATIVE_TTL_MS };
