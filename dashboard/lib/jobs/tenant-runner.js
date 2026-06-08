'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Per-Mandant-Job-Runner — Issue #160 (Stufe 6, Slice 0).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Datenzugriff"
//
// Iteriert die Mandanten-Registry (lib/tenant-directory.js) und führt einen Job
// JE MANDANT durch die Mandanten-Tür (lib/tenant-db.js) aus — der GUC wird von
// der Tür gesetzt (read/write/tx). Exakt das Muster von alert-digest:
// `jobFn(db, tenant, opts)` mit EXPLIZITEM Mandanten, NIE ein Default.
//
// Fail-closed:
//   * Verzeichnis fehlt/nicht bereit  ⇒ listTenantIds() leer ⇒ NICHTS läuft.
//   * leerer/whitespace-Mandant        ⇒ übersprungen (die Tür wird nie ohne
//                                        echten Mandanten angefasst).
//
// Dieses Modul trägt bewusst KEIN rohes pg (nur die injizierte Tür `db`) — der
// #107-Wächter scannt lib/jobs/* build-blocking und muss es sauber finden.
// ─────────────────────────────────────────────────────────────────────────────

function cleanTenant(raw) {
  if (typeof raw === 'string') return raw.trim();
  return raw == null ? '' : String(raw).trim();
}

/**
 * @param {object} opts
 * @param {object} opts.db          Mandanten-Tür (lib/tenant-db.js) — read/write/tx/forTenant.
 * @param {{listTenantIds:()=>string[]}} [opts.directory]  Mandanten-Registry.
 * @param {(...a:any[])=>void} [opts.logger]
 */
function createTenantJobRunner({ db, directory, logger } = {}) {
  if (!db) throw new TypeError('tenant-runner: db (Mandanten-Tür) erforderlich');
  const log = typeof logger === 'function' ? logger : () => {};

  // Die echten Mandanten (ohne '__default__'); leer bevor das Verzeichnis bereit
  // ist (fail-closed). Kein Verzeichnis ⇒ ebenfalls leer (kein Crash, kein Default).
  function listTenants() {
    if (!directory || typeof directory.listTenantIds !== 'function') return [];
    const list = directory.listTenantIds();
    return Array.isArray(list) ? list : [];
  }

  /**
   * Führt jobFn(db, tenant, opts) für JEDEN Mandanten der Registry aus.
   * @param {(db:object, tenant:string, opts:object)=>Promise<any>} jobFn
   * @param {object} [opts]
   * @param {boolean} [opts.continueOnError=false]  true ⇒ ein fehlschlagender
   *        Mandant stoppt die übrigen NICHT; Fehler werden je Mandant gesammelt.
   * @returns {Promise<{perTenant:object, tenants:string[], skipped:any[], errors:{tenant:string,error:string}[]}>}
   */
  async function runForAll(jobFn, opts = {}) {
    if (typeof jobFn !== 'function') {
      throw new TypeError('tenant-runner: runForAll(jobFn) verlangt jobFn(db, tenant, opts)');
    }
    const continueOnError = !!opts.continueOnError;
    const perTenant = {};
    const tenants = [];
    const skipped = [];
    const errors = [];
    for (const raw of listTenants()) {
      const tenant = cleanTenant(raw);
      if (!tenant) { skipped.push(raw); continue; }
      try {
        perTenant[tenant] = await jobFn(db, tenant, opts);
        tenants.push(tenant);
      } catch (err) {
        if (!continueOnError) throw err;
        const msg = String((err && err.message) || err);
        errors.push({ tenant, error: msg });
        log('tenant-runner: Mandanten-Lauf fehlgeschlagen:', tenant, msg);
      }
    }
    return { perTenant, tenants, skipped, errors };
  }

  /** Einen Job für EINEN expliziten Mandanten ausführen (fail-closed ohne Mandant). */
  async function runForTenant(tenant, jobFn, opts = {}) {
    const t = cleanTenant(tenant);
    if (!t) throw new Error('tenant-runner: runForTenant verlangt einen nicht-leeren Mandanten (fail-closed)');
    if (typeof jobFn !== 'function') throw new TypeError('tenant-runner: jobFn erforderlich');
    return jobFn(db, t, opts);
  }

  return { listTenants, runForAll, runForTenant };
}

module.exports = { createTenantJobRunner };
