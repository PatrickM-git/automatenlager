'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Infra-Runner — Issue #160 (Stufe 6, Slice 0).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Datenzugriff" + §"#107-Wächter"
//
// Mandantenübergreifende Pflege (MatView-REFRESH) ist der EINZIGE legitime Nicht-
// Tür-Pfad: es gibt keinen Mandanten zu setzen, also läuft sie über die Infra-/
// BYPASSRLS-Verbindung (dieselbe, die Stufe 5 für Bootstrap/Migrationen/Refresh
// eingeführt hat). Dieses Modul kapselt rohes pg an EINER Stelle.
//
// ⚠️ DOKUMENTIERTE #107-WÄCHTER-AUSNAHME (analog db-schema.js): infra-runner.js
// trägt absichtlich rohes `pool.query(...)` (kein Mandanten-Datenpfad). Es steht
// deshalb auf der Infra-Allowlist des Guards (tests/dashboard-jobs-guard.test.js /
// docs/security/query-filter-guard-allowlist.md). KEIN Mandanten-SELECT hier.
//
// Identifier-Sicherheit: View-Namen sind NICHT parametrisierbar; sie werden gegen
// eine feste Allowlist + ein striktes Identifier-Muster geprüft (fail-closed) —
// kein Injection-Korridor über zusammengebaute Bezeichner.
// ─────────────────────────────────────────────────────────────────────────────

// Die drei MatViews der App (SPEC §"Pro-Workflow-Disposition" → WF-MatView-Refresh).
const REFRESHABLE_MATVIEWS = Object.freeze([
  'mv_inventory_value_daily',
  'mv_db_per_product_monthly',
  'mv_db_per_slot_monthly',
]);

const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * @param {object} opts
 * @param {{query:(sql:string, params?:any[])=>Promise<any>}} opts.pool  Infra-/BYPASSRLS-Pool.
 * @param {(...a:any[])=>void} [opts.logger]
 */
function createInfraJobRunner({ pool, logger } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('infra-runner: pool (Infra-/BYPASSRLS-Verbindung) mit query() erforderlich');
  }
  const log = typeof logger === 'function' ? logger : () => {};
  const allow = new Set(REFRESHABLE_MATVIEWS);

  /** Beliebiges Infra-SQL über die BYPASSRLS-Verbindung (z. B. Telemetrie-Schreiber). */
  async function exec(sql, params) {
    return pool.query(sql, params);
  }

  /**
   * REFRESH MATERIALIZED VIEW [CONCURRENTLY] für die übergebenen (Default: alle
   * bekannten) MatViews. Validiert ALLE Namen vorab (fail-closed: ein ungültiger
   * Name ⇒ es läuft GAR NICHTS).
   * @param {string[]} [views]  Default: alle REFRESHABLE_MATVIEWS.
   * @param {{concurrently?:boolean}} [opts]  concurrently=false ⇒ ohne CONCURRENTLY.
   */
  async function refreshMatViews(views, opts = {}) {
    const list = Array.isArray(views) && views.length ? views : [...REFRESHABLE_MATVIEWS];
    const concurrently = opts.concurrently !== false;
    for (const v of list) {
      if (typeof v !== 'string' || !VALID_IDENTIFIER.test(v) || !allow.has(v)) {
        throw new Error(`infra-runner: unbekannte/ungültige MatView "${v}" — nicht auf der Allowlist (kein Identifier-Injection)`);
      }
    }
    const results = [];
    for (const v of list) {
      const sql = `REFRESH MATERIALIZED VIEW ${concurrently ? 'CONCURRENTLY ' : ''}automatenlager.${v}`;
      log('infra-runner: REFRESH', v, concurrently ? '(concurrently)' : '');
      results.push(await pool.query(sql));
    }
    return results;
  }

  /** Beliebige Infra-Pflege mit Zugriff auf exec (für künftige Slices). */
  async function run(fn) {
    if (typeof fn !== 'function') throw new TypeError('infra-runner: run(fn) verlangt fn(ctx)');
    return fn({ exec });
  }

  return { exec, refreshMatViews, run, REFRESHABLE_MATVIEWS };
}

module.exports = { createInfraJobRunner, REFRESHABLE_MATVIEWS };
