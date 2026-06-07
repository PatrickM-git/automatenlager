'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mandanten-Tür (Deep Module) — Issue #122, Stufe 3.
// SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md
//
// Die EINZIGE legitime Stelle für mandanten-bezogene DB-Reads. Statt 40-mal
// kopierter `WHERE tenant_id = …`-Filter gibt es EINE Stelle, an der die
// Mandanten-Bindung erzwungen wird. Direkte DB-Reads an der Tür vorbei sind
// verboten (No-Bypass) — der #107-Wächter (lib/query-filter-guard.js) markiert sie.
//
// VERTRAG (bewusst ehrlich, keine SQL-Magie — vgl. SPEC §"Vertrag"):
//   (a) Die Tür ERZWINGT, dass ein Mandant deklariert ist (fail-closed).
//   (b) Sie stellt den Mandanten-Wert jeder Abfrage EINHEITLICH als ERSTEN
//       Positions-Parameter ($1) bereit; die Query trägt ihren tenant_id-Filter
//       selbst (`WHERE x.tenant_id = $1`), eigene Parameter folgen ab $2.
//   (c) Jeder Tür-Aufruf übergibt EXPLIZIT den/die Zieltabelle(n) — der eine
//       Kontrollpunkt, gegen den der #107-Wächter prüft.
//
// FEHLER-/LEERFALL-TAXONOMIE (konsistent zu Stufe 2):
//   * kein/leerer/null Mandant  ⇒ LEERES Resultat, KEINE Abfrage (kein Default,
//     kein „catch ⇒ alles zeigen"). Es wird für einen tenant-losen Aufrufer
//     KEINE mandanten-bezogene Query ausgeführt.
//   * technischer DB-/Pool-Fehler ⇒ Fehler PROPAGIEREN (await wirft) — NIE als
//     „legitim leer" maskiert. Ein Aussetzer ist von „0 Zeilen" unterscheidbar.
//
// DB-ZUGRIFF ZENTRALISIERT: Die Tür nimmt — wie die Stufe-2-Registry
// (lib/tenant-directory.js) — eine injizierte `query`-Funktion entgegen (aus
// EINEM geteilten Pool in server.js); sie kann alternativ einen Pool annehmen.
// Die Tür ist die EINE erlaubte DB-Zugriffsschicht: der #107-Wächter klassifiziert
// `lib/tenant-db.js` als Tür (DOOR_FILES) — „kein DB-Zugriff AUSSERHALB der Tür".
//
// STUFE-5-HAKEN (gebaut, NICHT gezündet): Die Tür ist der eine Ort, an dem in
// Stufe 5 zusätzlich die RLS-Sitzungsvariable `SET LOCAL automatenlager.current_tenant`
// gesetzt wird (eigener Client + Transaktion), sodass die DB fremde Zeilen selbst
// dann abweist, wenn ein tenant_id-Prädikat fehlte. In Stufe 3 bewusst inert:
// die Filterung leisten die tenant_id-Prädikate; der Haken ist nur vorbereitet.
// ─────────────────────────────────────────────────────────────────────────────

function isValidTenant(tenant) {
  return typeof tenant === 'string' && tenant.trim() !== '';
}

/**
 * @param {object} opts
 * @param {(sql:string, params:any[]) => Promise<{rows:any[], rowCount?:number}>} [opts.query]
 *        Injizierte DB-Query (aus dem geteilten Pool). Vorzugsweise diese Form.
 * @param {{query:Function}} [opts.pool]  Alternativ ein pg-Pool (es wird pool.query genutzt).
 * @param {(...a:any[]) => void} [opts.log]  optionaler Fehler-Logger
 */
function createTenantDb({ query, pool, log } = {}) {
  let runQuery = typeof query === 'function' ? query : null;
  if (!runQuery && pool && typeof pool.query === 'function') {
    runQuery = (sql, params) => pool.query(sql, params);
  }
  if (!runQuery) {
    throw new TypeError('tenant-db: query-Funktion oder pool erforderlich');
  }
  const logfn = typeof log === 'function' ? log : () => {};

  /**
   * Mandanten-gebundener Read. Siehe VERTRAG oben.
   * @param {object} req
   * @param {string} req.tenant            effektiver Mandant (viewer.tenantId)
   * @param {string[]} req.tables          explizite Zieltabelle(n) — Pflicht
   * @param {string} req.text              SQL; $1 = Mandant, $2.. = eigene Parameter
   * @param {any[]} [req.params]           eigene Parameter (landen ab $2)
   * @returns {Promise<{rows:any[], rowCount:number, tenantless?:boolean}>}
   */
  async function read({ tenant, tables, text, params = [] } = {}) {
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new TypeError('tenant-db: read() verlangt explizite Zieltabelle(n) (tables: [...])');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('tenant-db: read() verlangt SQL-Text (text)');
    }
    if (!isValidTenant(tenant)) {
      // fail-closed: kein Mandant ⇒ leer, KEINE Abfrage, kein Default.
      logfn('tenant-db: read ohne Mandant ⇒ leeres Resultat (fail-closed)', { tables });
      return { rows: [], rowCount: 0, tenantless: true };
    }

    // Mandant einheitlich als $1 voranstellen; eigene Parameter folgen ab $2.
    const allParams = [tenant, ...(Array.isArray(params) ? params : [params])];

    // ── Stufe-5-Haken (NICHT aktiv in Stufe 3) ───────────────────────────────
    // Hier setzt Stufe 5 zusätzlich `SET LOCAL automatenlager.current_tenant = $1`
    // auf demselben Client innerhalb einer Transaktion (RLS-Backstop). Bewusst
    // inert: in Stufe 3 leistet das tenant_id-Prädikat der Query die Filterung.
    // (Der Mandant steht für diesen späteren Schritt bereits in allParams[0].)

    // Technische Fehler propagieren — NIE als leer maskieren.
    return runQuery(text, allParams);
  }

  /**
   * Mandanten-gebundener WRITE (Upsert/Insert/Update/Delete). Mechanisch wie read
   * (Mandant als $1, eigene Parameter ab $2), aber als Schreibpfad benannt. Die
   * volle Schreib-ISOLATION (verhindern, dass fremde Daten verändert werden) ist
   * Stufe 4; hier nur Mandanten-Bindung + fail-closed, damit Module ohne eigenen
   * pg.Client auskommen (No-Bypass). Kein/leerer Mandant ⇒ KEIN Schreibzugriff.
   * @returns {Promise<{rows:any[], rowCount:number, tenantless?:boolean}>}
   */
  async function write({ tenant, tables, text, params = [] } = {}) {
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new TypeError('tenant-db: write() verlangt explizite Zieltabelle(n) (tables: [...])');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('tenant-db: write() verlangt SQL-Text (text)');
    }
    if (!isValidTenant(tenant)) {
      logfn('tenant-db: write ohne Mandant ⇒ kein Schreibzugriff (fail-closed)', { tables });
      return { rows: [], rowCount: 0, tenantless: true };
    }
    const allParams = [tenant, ...(Array.isArray(params) ? params : [params])];
    return runQuery(text, allParams);
  }

  /**
   * Ergonomische, an EINEN Mandanten gebundene Tür (für die Slice-Module).
   * `forTenant('').read(...)` ist identisch fail-closed.
   */
  function forTenant(tenant) {
    return {
      tenant: isValidTenant(tenant) ? tenant : null,
      read: ({ tables, text, params } = {}) => read({ tenant, tables, text, params }),
      write: ({ tables, text, params } = {}) => write({ tenant, tables, text, params }),
    };
  }

  /** Konsumiert den Stufe-2-Viewer: bindet auf dessen effektiven Mandanten. */
  function forViewer(viewer) {
    return forTenant(viewer && viewer.tenantId);
  }

  return { read, write, forTenant, forViewer, isValidTenant };
}

// Migrations-Brücke: nimmt entweder eine fertige Tür (hat .read) ODER einen rohen
// pg-Client (hat .query) und liefert immer eine Tür. So können geteilte Module
// (category-config, settings-thresholds) tür-basiert lesen, während noch nicht
// migrierte Aufrufer (z. B. inventory-mhd #126, Settings-Schreibendpunkte) weiter
// ihren Client übergeben — der wird transparent in eine Tür gewrappt. Dadurch
// trägt KEIN geteiltes Modul mehr ein rohes `client.query` (No-Bypass erfüllt).
function asDoor(runner) {
  if (runner && typeof runner.read === 'function') return runner; // bereits eine Tür
  if (runner && typeof runner.query === 'function') {
    return createTenantDb({ query: (sql, params) => runner.query(sql, params) });
  }
  throw new TypeError('asDoor: Tür (.read) oder pg-Client (.query) erforderlich');
}

module.exports = { createTenantDb, isValidTenant, asDoor };
