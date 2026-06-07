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

  // Gemeinsame Vertrags-Prüfung: explizite Zieltabelle(n) + SQL-Text sind Pflicht
  // (Programmierfehler ⇒ wirft, unabhängig vom Mandanten — gilt für read/write/tx).
  function assertTablesAndText(tables, text, who) {
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new TypeError(`tenant-db: ${who}() verlangt explizite Zieltabelle(n) (tables: [...])`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError(`tenant-db: ${who}() verlangt SQL-Text (text)`);
    }
  }
  // Mandant einheitlich als $1 voranstellen; eigene Parameter folgen ab $2.
  function withTenantParams(tenant, params) {
    return [tenant, ...(Array.isArray(params) ? params : [params])];
  }

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
    assertTablesAndText(tables, text, 'read');
    if (!isValidTenant(tenant)) {
      // fail-closed-LEER: kein Mandant ⇒ leer, KEINE Abfrage, kein Default. „leer"
      // ist ein GÜLTIGES Lese-Ergebnis (vgl. write(): dort ist es ein FEHLER).
      logfn('tenant-db: read ohne Mandant ⇒ leeres Resultat (fail-closed)', { tables });
      return { rows: [], rowCount: 0, tenantless: true };
    }
    // ── Stufe-5-Haken (NICHT aktiv) ── Stufe 5 setzt hier zusätzlich
    // `SET LOCAL automatenlager.current_tenant` auf demselben Client/Trx (RLS).
    // Inert: in Stufe 3/4 leistet das tenant_id-Prädikat die Filterung.
    // Technische Fehler propagieren — NIE als leer maskieren.
    return runQuery(text, withTenantParams(tenant, params));
  }

  /**
   * Mandanten-gebundener WRITE (Upsert/Insert/Update/Delete). Mechanisch wie read
   * (Mandant als $1, eigene Parameter ab $2), aber als Schreibpfad.
   *
   * STUFE 4 — fail-closed-WERFEND: Kein/leerer Mandant ist beim Schreiben KEIN
   * stilles `{rowCount:0}` mehr, sondern ein geworfener FEHLER. Damit kann ein
   * Endpunkt nie „erfolgreich gespeichert" melden, während nichts geschrieben
   * wurde. (Der Lese-Pfad bleibt fail-closed-LEER — die Asymmetrie ist Absicht.)
   * @returns {Promise<{rows:any[], rowCount:number}>}
   */
  async function write({ tenant, tables, text, params = [] } = {}) {
    assertTablesAndText(tables, text, 'write');
    if (!isValidTenant(tenant)) {
      logfn('tenant-db: write ohne Mandant ⇒ FEHLER (fail-closed-werfend)', { tables });
      throw new Error('tenant-db: kein Mandant beim Schreiben — Schreibzugriff verweigert (fail-closed)');
    }
    return runQuery(text, withTenantParams(tenant, params));
  }

  /**
   * Transaktionaler Schreib-Modus (Stufe 4). Bindet einen Mandanten, nimmt einen
   * DEDIZIERTEN Client aus dem geteilten Pool, öffnet eine Transaktion und übergibt
   * `fn` eine tür-gebundene Schnittstelle, die LESEN und SCHREIBEN in DERSELBEN
   * Transaktion erlaubt (Mandant je Query als $1). So laufen „Parent-Eigentum
   * prüfen" und „schreiben" ATOMAR (TOCTOU-Schutz). COMMIT bei Erfolg, ROLLBACK
   * bei geworfenem Fehler (Fehler wird propagiert), Client immer freigegeben.
   *
   * Genau diese Transaktion ist der vorbereitete (in Stufe 4 INERTE) Steckplatz
   * für den Stufe-5-RLS-Haken (`SET LOCAL automatenlager.current_tenant`).
   * @param {string} tenant  effektiver Mandant (viewer.tenantId) — Pflicht, sonst wirft
   * @param {(door:{tenant:string, read:Function, write:Function}) => Promise<any>} fn
   * @returns {Promise<any>}  der Rückgabewert von fn
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
      // ── Stufe-5-RLS-Haken (GEBAUT, in Stufe 4 INERT) ─────────────────────────
      // Genau hier setzt Stufe 5 zusätzlich die RLS-Sitzungsvariable auf DEMSELBEN
      // Client innerhalb DIESER Transaktion:
      //   await client.query('SET LOCAL automatenlager.current_tenant = $1', [tenant]);
      // sodass die DB fremde Zeilen selbst dann abweist, wenn ein tenant_id-Prädikat
      // fehlte. Bewusst auskommentiert: in Stufe 4 leisten die tenant_id-Prädikate
      // (Mandant als $1) die Trennung; der Haken ist nur vorbereitet (RLS = Stufe 5).
      const result = await fn(makeBoundDoor(client, tenant));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rbErr) {
        logfn('tenant-db: ROLLBACK fehlgeschlagen', rbErr && rbErr.message);
      }
      throw err; // Fehler propagieren — kein stiller No-Op
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  // Tür-gebundene Schnittstelle INNERHALB einer tx: liest & schreibt auf DEMSELBEN
  // Client, Mandant einheitlich als $1. Der Mandant ist hier bereits validiert.
  function makeBoundDoor(client, tenant) {
    const runOn = (text, params) => client.query(text, withTenantParams(tenant, params));
    return {
      tenant,
      read: ({ tables, text, params = [] } = {}) => { assertTablesAndText(tables, text, 'read'); return runOn(text, params); },
      write: ({ tables, text, params = [] } = {}) => { assertTablesAndText(tables, text, 'write'); return runOn(text, params); },
    };
  }

  /**
   * Ergonomische, an EINEN Mandanten gebundene Tür (für die Slice-Module).
   * `forTenant('').read(...)` ist identisch fail-closed; `.write/.tx` werfen ohne Mandant.
   */
  function forTenant(tenant) {
    return {
      tenant: isValidTenant(tenant) ? tenant : null,
      read: ({ tables, text, params } = {}) => read({ tenant, tables, text, params }),
      write: ({ tables, text, params } = {}) => write({ tenant, tables, text, params }),
      tx: (fn) => tx(tenant, fn),
    };
  }

  /** Konsumiert den Stufe-2-Viewer: bindet auf dessen effektiven Mandanten. */
  function forViewer(viewer) {
    return forTenant(viewer && viewer.tenantId);
  }

  return { read, write, tx, forTenant, forViewer, isValidTenant };
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
