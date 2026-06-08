'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: MatView-Refresh — Issue #161 (Stufe 6, Slice 1). Ersetzt WF-MatView-Refresh.
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Pro-Workflow-Disposition"
//
// WF-MatView-Refresh (n8n) lief nächtlich (04:45, „after WF-Val") und führte
// `REFRESH MATERIALIZED VIEW CONCURRENTLY` für die drei App-MatViews aus. Das ist
// **mandantenübergreifende Pflege** ⇒ läuft über die **Infra-/BYPASSRLS-Verbindung**
// (kein Mandant zu setzen) — über den Infra-Runner (#160), der genau das kapselt
// und die View-Namen gegen eine Allowlist validiert (kein Identifier-Injection).
//
// Idempotent/ableitbar ⇒ „direkter Wechsel" ohne Schattenbetrieb (Slice 1).
// Dünnes Job-Modul (delegiert an den getesteten Infra-Runner) — kein rohes pg.
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_KEY = 'wf-matview-refresh';

/**
 * @param {object} deps
 * @param {{refreshMatViews:Function}} deps.infraRunner  Infra-Runner (#160).
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createMatViewRefreshJob({ infraRunner } = {}) {
  if (!infraRunner || typeof infraRunner.refreshMatViews !== 'function') {
    throw new TypeError('matview-refresh: infraRunner mit refreshMatViews() erforderlich');
  }
  return {
    key: WORKFLOW_KEY,
    // Refresht ALLE bekannten MatViews (Default des Infra-Runners) — CONCURRENTLY,
    // schema-qualifiziert, allowlist-validiert. Gibt die pg-Ergebnisse zurück.
    run: async () => {
      const results = await infraRunner.refreshMatViews();
      return { refreshed: Array.isArray(results) ? results.length : 0 };
    },
  };
}

module.exports = { createMatViewRefreshJob, WORKFLOW_KEY };
