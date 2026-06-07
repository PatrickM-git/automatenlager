'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mandanten-Tür (Deep Module) — Issue #122 (Stufe 3) · Stufe 4 (Schreib-Tx) ·
// Stufe 5 (RLS-GUC, #144). SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md
//
// Die EINZIGE legitime Stelle für mandanten-bezogene DB-Zugriffe. Statt 40-mal
// kopierter `WHERE tenant_id = …`-Filter gibt es EINE Stelle, an der die
// Mandanten-Bindung erzwungen wird. Direkte DB-Zugriffe an der Tür vorbei sind
// verboten (No-Bypass) — der #107-Wächter (lib/query-filter-guard.js) markiert sie.
//
// VERTRAG (bewusst ehrlich, keine SQL-Magie):
//   (a) Die Tür ERZWINGT, dass ein Mandant deklariert ist (fail-closed).
//   (b) Sie stellt den Mandanten-Wert jeder Abfrage EINHEITLICH als ERSTEN
//       Positions-Parameter ($1) bereit; die Query trägt ihren tenant_id-Filter
//       selbst (`WHERE x.tenant_id = $1`), eigene Parameter folgen ab $2.
//   (c) Jeder Tür-Aufruf übergibt EXPLIZIT die Zieltabelle(n) — der eine
//       Kontrollpunkt, gegen den der #107-Wächter prüft.
//
// STUFE-5-RLS (#144 — GEZÜNDET): read()/write()/tx() setzen jetzt die
// transaktionslokale Sitzungsvariable `automatenlager.current_tenant` per
// parametrisiertem `set_config(..., $1, true)` (NIE string-interpoliertes SET →
// Injection-Korridor). So weist die DB fremde Zeilen selbst dann ab, wenn ein
// tenant_id-Prädikat fehlte (RLS-Backstop, scharf ab Slice 3). Inert, solange
// keine Policy existiert.
//
//   * MANAGED-Modus (Produktion): die Tür hat einen Pool. Jeder read()/write()
//     holt einen DEDIZIERTEN Client, öffnet eine Transaktion (read: BEGIN READ
//     ONLY), setzt den GUC, führt die Query aus, COMMIT (ROLLBACK bei Fehler),
//     gibt den Client frei. Pool-PFLICHT: read()/write() OHNE Pool werfen (kein
//     stiller nicht-transaktionaler Fallback, der RLS umginge).
//   * AMBIENT-Modus (Tür über EINEN bereits in einer Transaktion laufenden
//     Client — asDoor(client), #94-Sandbox): set_config(local) + Query auf
//     demselben Client, OHNE eigenes BEGIN/COMMIT (die umgebende Transaktion
//     verwaltet der Aufrufer). Explizit via `ambient:true`.
//
// FEHLER-/LEERFALL-TAXONOMIE:
//   * read() ohne Mandant ⇒ LEERES Resultat, KEINE Transaktion, KEINE Query.
//   * write()/tx() ohne Mandant ⇒ geworfener FEHLER (fail-closed-werfend).
//   * technischer DB-/Pool-Fehler ⇒ Fehler PROPAGIEREN (nie als „leer" maskiert).
// ─────────────────────────────────────────────────────────────────────────────

// Kanonischer, parametrisierter GUC-Setzer. $1 = Mandant, dritter Parameter true
// = transaktionslokal (kein Kleben an der gepoolten Verbindung). Namensraum
// `automatenlager.current_tenant` (konsistent zu Seed-Migration 0018; NICHT app.*).
const SET_TENANT_SQL = "SELECT set_config('automatenlager.current_tenant', $1, true)";

function isValidTenant(tenant) {
  return typeof tenant === 'string' && tenant.trim() !== '';
}

// Erkennt RLS-Kontextfehler (fehlender/leerer GUC) für distinkte Auditierung.
function isRlsContextError(err) {
  const msg = err && (err.message || '');
  const code = err && err.code;
  return code === '22023' || /current_tenant|current_setting|configuration parameter/i.test(String(msg));
}

/**
 * @param {object} opts
 * @param {(sql:string, params:any[]) => Promise<{rows:any[], rowCount?:number}>} [opts.query]
 *        Injizierte DB-Query. Im AMBIENT-Modus MUSS sie an EINEN Client gebunden sein.
 * @param {{query:Function, connect?:Function}} [opts.pool]  pg-Pool (MANAGED-Modus).
 * @param {boolean} [opts.ambient]  true ⇒ AMBIENT-Modus (siehe Kopf).
 * @param {(...a:any[]) => void} [opts.log]  optionaler Fehler-/Audit-Logger
 */
function createTenantDb({ query, pool, ambient = false, log } = {}) {
  let runQuery = typeof query === 'function' ? query : null;
  if (!runQuery && pool && typeof pool.query === 'function') {
    runQuery = (sql, params) => pool.query(sql, params);
  }
  if (!runQuery) {
    throw new TypeError('tenant-db: query-Funktion oder pool erforderlich');
  }
  const canManage = !!(pool && typeof pool.connect === 'function');
  const logfn = typeof log === 'function' ? log : () => {};

  function assertTablesAndText(tables, text, who) {
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new TypeError(`tenant-db: ${who}() verlangt explizite Zieltabelle(n) (tables: [...])`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(`tenant-db: ${who}() verlangt SQL-Text (text)`);
    }
  }
  function withTenantParams(tenant, params) {
    return [tenant, ...(Array.isArray(params) ? params : [params])];
  }

  // MANAGED: dedizierter Client + Transaktion + GUC. `beginSql` unterscheidet
  // read (BEGIN READ ONLY) von write (BEGIN). Fehler → ROLLBACK + propagieren.
  async function runManaged(beginSql, tenant, text, params) {
    const client = await pool.connect();
    try {
      await client.query(beginSql);
      await client.query(SET_TENANT_SQL, [tenant]);
      const res = await client.query(text, withTenantParams(tenant, params));
      await client.query('COMMIT');
      return res;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rbErr) {
        logfn('tenant-db: ROLLBACK fehlgeschlagen', rbErr && rbErr.message);
      }
      if (isRlsContextError(err)) logfn('tenant-db: RLS-Kontextfehler (GUC)', { tenant: !!tenant, msg: err && err.message });
      throw err;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  // AMBIENT: GUC + Query auf der vom Aufrufer geöffneten Transaktion (kein BEGIN/COMMIT).
  async function runAmbient(tenant, text, params) {
    await runQuery(SET_TENANT_SQL, [tenant]);
    return runQuery(text, withTenantParams(tenant, params));
  }

  /**
   * Mandanten-gebundener Read. fail-closed-LEER ohne Mandant (KEINE Transaktion).
   * @returns {Promise<{rows:any[], rowCount:number, tenantless?:boolean}>}
   */
  async function read({ tenant, tables, text, params = [] } = {}) {
    assertTablesAndText(tables, text, 'read');
    if (!isValidTenant(tenant)) {
      logfn('tenant-db: read ohne Mandant ⇒ leeres Resultat (fail-closed)', { tables });
      return { rows: [], rowCount: 0, tenantless: true };
    }
    if (ambient) return runAmbient(tenant, text, params);
    if (canManage) return runManaged('BEGIN READ ONLY', tenant, text, params);
    // Kein Pool, kein Ambient ⇒ ein RLS-Read ohne eigene Transaktion ist verboten
    // (würde den GUC nicht transaktionssicher setzen → stiller RLS-Bypass).
    throw new TypeError('tenant-db: read() braucht einen Pool (eigene Transaktion für den RLS-GUC) oder ambient:true');
  }

  /**
   * Mandanten-gebundener WRITE. fail-closed-WERFEND ohne Mandant.
   * @returns {Promise<{rows:any[], rowCount:number}>}
   */
  async function write({ tenant, tables, text, params = [] } = {}) {
    assertTablesAndText(tables, text, 'write');
    if (!isValidTenant(tenant)) {
      logfn('tenant-db: write ohne Mandant ⇒ FEHLER (fail-closed-werfend)', { tables });
      throw new Error('tenant-db: kein Mandant beim Schreiben — Schreibzugriff verweigert (fail-closed)');
    }
    if (ambient) return runAmbient(tenant, text, params);
    if (canManage) return runManaged('BEGIN', tenant, text, params);
    throw new TypeError('tenant-db: write() braucht einen Pool (eigene Transaktion für den RLS-GUC) oder ambient:true');
  }

  /**
   * Transaktionaler Schreib-Modus (Stufe 4). Dedizierter Client, EINE Transaktion,
   * Parent-Prüfung + Write atomar (TOCTOU-Schutz). Stufe 5: setzt den RLS-GUC
   * EINMAL nach BEGIN — gilt für alle read/write der gebundenen Tür in dieser Tx.
   */
  async function tx(tenant, fn) {
    if (!isValidTenant(tenant)) {
      logfn('tenant-db: tx ohne Mandant ⇒ FEHLER (fail-closed-werfend)');
      throw new Error('tenant-db: kein Mandant bei tx() — Schreibzugriff verweigert (fail-closed)');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('tenant-db: tx(tenant, fn) verlangt eine Transaktions-Funktion fn');
    }
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('tenant-db: tx() verlangt einen Pool mit connect() (dedizierter Client für die Transaktion)');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // ── Stufe-5-RLS-GUC (gezündet, #144) ── transaktionslokal, parametrisiert.
      await client.query(SET_TENANT_SQL, [tenant]);
      const result = await fn(makeBoundDoor(client, tenant));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rbErr) {
        logfn('tenant-db: ROLLBACK fehlgeschlagen', rbErr && rbErr.message);
      }
      if (isRlsContextError(err)) logfn('tenant-db: RLS-Kontextfehler (GUC) in tx', err && err.message);
      throw err; // Fehler propagieren — kein stiller No-Op
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  // Tür-gebundene Schnittstelle INNERHALB einer tx: liest & schreibt auf DEMSELBEN
  // Client (GUC bereits in tx() gesetzt), Mandant einheitlich als $1.
  function makeBoundDoor(client, tenant) {
    const runOn = (text, params) => client.query(text, withTenantParams(tenant, params));
    return {
      tenant,
      read: ({ tables, text, params = [] } = {}) => { assertTablesAndText(tables, text, 'read'); return runOn(text, params); },
      write: ({ tables, text, params = [] } = {}) => { assertTablesAndText(tables, text, 'write'); return runOn(text, params); },
    };
  }

  function forTenant(tenant) {
    return {
      tenant: isValidTenant(tenant) ? tenant : null,
      read: ({ tables, text, params } = {}) => read({ tenant, tables, text, params }),
      write: ({ tables, text, params } = {}) => write({ tenant, tables, text, params }),
      tx: (fn) => tx(tenant, fn),
    };
  }

  function forViewer(viewer) {
    return forTenant(viewer && viewer.tenantId);
  }

  return { read, write, tx, forTenant, forViewer, isValidTenant };
}

// Migrations-Brücke: nimmt eine fertige Tür (hat .read) ODER einen rohen pg-Client
// (hat .query, läuft in einer vom Aufrufer verwalteten Transaktion) und liefert
// immer eine Tür. Der Client-Fall baut eine AMBIENT-Tür (GUC + Query auf DEMSELBEN
// Client, kein eigenes BEGIN/COMMIT). So trägt KEIN geteiltes Modul ein rohes
// `client.query` (No-Bypass), und der RLS-GUC wird auch hier gesetzt.
function asDoor(runner) {
  if (runner && typeof runner.read === 'function') return runner; // bereits eine Tür
  if (runner && typeof runner.query === 'function') {
    return createTenantDb({ query: (sql, params) => runner.query(sql, params), ambient: true });
  }
  throw new TypeError('asDoor: Tür (.read) oder pg-Client (.query) erforderlich');
}

module.exports = { createTenantDb, isValidTenant, asDoor, SET_TENANT_SQL };
