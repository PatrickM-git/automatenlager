'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: Live-Füllstand-Sync — Issue #222. `slot_assignments.current_machine_qty`
// alle ~5 Min aus Nayax fortschreiben (statt nur beim manuellen Abgleich).
//
// HARTE SICHERHEITS-INVARIANTE (vom User bestätigt, Issue #222):
//   * NUR Mengen (`diff.qty_changes`) werden automatisch angewandt.
//   * NIEMALS Slot-Umbelegungen (`diff.assignment_changes`) — die bleiben
//     datenkritisch beim manuellen Abgleich (Admin-Vorschau→Freigabe,
//     /api/v2/nayax-abgleich/apply). Reassigns werden nur GEZÄHLT/GEMELDET.
//
// KRITISCHE DESIGNENTSCHEIDUNG (gegen lib/nayax-abgleich.js verifiziert):
//   Der bestehende Apply-Pfad (buildSlotAssignmentEvents) macht auch für reine
//   Mengen close(alt)+open(neu) — Alt-Workaround der pgw_write-Funktion, die
//   current_machine_qty nur beim INSERT setzte. Für einen 5-Min-Job würde das
//   slot_assignments mit einer neuen Zeile pro Slot pro Lauf zumüllen und die
//   valid_from/valid_to-History zerstören. Stattdessen: DIREKTES, leichtes
//   UPDATE der aktiven Zuordnung durch die Mandanten-Tür (db.tx, RLS-GUC).
//
// EFFIZIENZ: Nayax wird mit withDetails:false geholt (1 Call/Maschine/Lauf,
// keine Produkt-Detail-Calls) — Matching läuft primär über die NayaxProductID
// (nayax_id-Alias); als Namens-Fallback wird der DEXProductName auf ProductName
// gemappt (faithful zur n8n-Map-Node), damit Produkte ohne nayax_id-Alias über
// den normalisierten products.name matchen. Kein Match ⇒ nie schreiben (wie
// buildAbgleichDiff: onboarding/unmatched werden nur gemeldet).
//
// MANDANT: ein Nayax-Token = ein Mandant (wie nayax-sales/nayax-devices-sync) —
// NAYAX_TENANT_ID bzw. einziger Registry-Mandant, sonst fail-closed skip.
// HTTP-Client injizierbar (fetchImpl — Tests laufen ohne Netz). KEIN rohes pg
// (#107-rein, nur die Tür).
// ─────────────────────────────────────────────────────────────────────────────

const { normalizeAuthValue, resolveNayaxTenant, fetchNayaxMachineProducts } = require('./nayax-devices-sync.js');
const {
  normalizeNayaxItems,
  buildAliasIndex,
  buildNayaxIdIndex,
  buildNameIndex,
  buildAbgleichDiff,
  buildActiveSlotsQuery,
  buildNayaxAliasesQuery,
  buildNayaxIdAliasesQuery,
  buildProductsByIdQuery,
} = require('../nayax-abgleich.js');

const FILL_LEVEL_SYNC_JOB_KEY = 'nayax-filllevel-sync';
const NAYAX_DEFAULT_BASE_URL = 'https://lynx.nayax.com';

// Aktive Maschinen des Mandanten, die überhaupt aktive Slot-Zuordnungen tragen
// (kein hartkodierter Automat). machine_key = Nayax-Maschinennummer.
const ACTIVE_MACHINES_SQL = `
  SELECT DISTINCT m.machine_key
    FROM automatenlager.machines m
    JOIN automatenlager.slot_assignments sa
      ON sa.machine_id = m.machine_id AND sa.tenant_id = m.tenant_id
   WHERE m.tenant_id = $1 AND m.active = TRUE AND sa.active = TRUE
   ORDER BY m.machine_key`;

// Direktes Mengen-UPDATE der AKTIVEN Zuordnung — bewusst KEIN close/open
// (s. Kopf). $1 = Mandant (Tür), active = TRUE als zusätzlicher Guard gegen
// zwischenzeitliche Umbelegungen (die UPDATE-WHERE greift dann nicht mehr).
const QTY_UPDATE_SQL = `
  UPDATE automatenlager.slot_assignments
     SET current_machine_qty = $2
   WHERE slot_assignment_id = $3 AND tenant_id = $1 AND active = TRUE`;

async function listActiveMachineKeys(db, tenant) {
  const res = await db.read({ tenant, tables: ['machines', 'slot_assignments'], text: ACTIVE_MACHINES_SQL });
  return (res.rows || []).map((r) => String(r.machine_key));
}

// withDetails:false liefert die rohen machineProducts-Items OHNE Namens-
// Anreicherung — der DEX-Name bleibt aber als Fallback nutzbar (faithful zur
// n8n-Map-Node: name = detail || DEXProductName). normalizeNayaxItems kennt
// DEXProductName nicht, daher hier auf ProductName mappen.
function applyDexNameFallback(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : []).map((it) => {
    if (it && !it.ProductName && !it.Name && !it.product_name && it.DEXProductName) {
      return { ...it, ProductName: it.DEXProductName };
    }
    return it;
  });
}

/**
 * Füllstand EINER Maschine anwenden: Diff in DERSELBEN Transaktion lesen +
 * Mengen schreiben (TOCTOU-Schutz: eine zwischenzeitliche Umbelegung sähe die
 * Tx nicht veraltet — Slots werden im selben Snapshot gelesen, und das UPDATE
 * greift nur auf `active = TRUE` derselben slot_assignment_id).
 * assignment_changes werden NUR gezählt/gemeldet, NIE geschrieben.
 *
 * @param {object} db        Mandanten-Tür (lib/tenant-db.js)
 * @param {string} tenant    expliziter Mandant
 * @param {string} machineKey Nayax-Maschinennummer (machines.machine_key)
 * @param {Array}  nayaxItems normalisierte Items (normalizeNayaxItems)
 */
async function applyFillLevelForMachine(db, tenant, machineKey, nayaxItems) {
  return db.tx(tenant, async (door) => {
    // Sequenziell (eine Tx = ein Client — kein Promise.all).
    const slotsQ = buildActiveSlotsQuery({ machineKey });
    const sRes = await door.read({ tables: ['slot_assignments', 'products', 'machines'], text: slotsQ.text, params: slotsQ.values });
    const aRes = await door.read({ tables: ['product_aliases'], text: buildNayaxAliasesQuery().text });
    const idRes = await door.read({ tables: ['product_aliases'], text: buildNayaxIdAliasesQuery().text });
    const pRes = await door.read({ tables: ['products'], text: buildProductsByIdQuery().text });

    const productsById = {};
    for (const r of pRes.rows) productsById[Number(r.product_id)] = r.name;

    const diff = buildAbgleichDiff(sRes.rows, nayaxItems, buildAliasIndex(aRes.rows), {
      machineId: machineKey,
      productsById,
      idIndex: buildNayaxIdIndex(idRes.rows),
      nameIndex: buildNameIndex(pRes.rows),
    });

    // NUR qty_changes schreiben — direktes UPDATE, gleiche slot_assignment_id.
    let qtyApplied = 0;
    for (const q of diff.qty_changes) {
      const r = await door.write({
        tables: ['slot_assignments'],
        text: QTY_UPDATE_SQL,
        params: [q.new_qty, q.slot_assignment_id],
      });
      qtyApplied += r.rowCount || 0;
    }

    return {
      machine: String(machineKey),
      qtyApplied,
      qtyChanges: diff.qty_changes.length,
      // Arbeitsvorrat für den manuellen Abgleich — gemeldet, NIE geschrieben.
      reassignsSkipped: diff.assignment_changes.length,
      reassigns: diff.assignment_changes.map((c) => ({
        mdb_code: c.mdb_code,
        old_product: c.old_product_name,
        new_product: c.new_product_name,
      })),
      onboarding: diff.onboarding.length,
      pgOnly: diff.pg_only_slots.length,
      unchanged: diff.unchanged.length,
    };
  });
}

/**
 * Voller Lauf für EINEN Mandanten: aktive Maschinen enumerieren → je Maschine
 * 1 Nayax-Call (withDetails:false) → Mengen-UPDATEs in einer Tx. Eine kaputte
 * Maschine (Nayax-Fehler) stoppt die übrigen NICHT (Fehler je Maschine gesammelt).
 */
async function runFillLevelSync(db, tenant, { token, headerName = 'Authorization', baseUrl = NAYAX_DEFAULT_BASE_URL, fetchImpl } = {}) {
  const machines = await listActiveMachineKeys(db, tenant);
  const perMachine = [];
  const errors = [];
  let qtyApplied = 0;
  let reassignsSkipped = 0;
  for (const machineKey of machines) {
    try {
      const raw = await fetchNayaxMachineProducts({
        token, headerName, baseUrl, machineId: machineKey, fetchImpl, withDetails: false,
      });
      const items = normalizeNayaxItems(applyDexNameFallback(raw));
      const res = await applyFillLevelForMachine(db, tenant, machineKey, items);
      perMachine.push(res);
      qtyApplied += res.qtyApplied;
      reassignsSkipped += res.reassignsSkipped;
    } catch (err) {
      errors.push({ machine: String(machineKey), error: String((err && err.message) || err) });
    }
  }
  return { tenant, machines: machines.length, qtyApplied, reassignsSkipped, perMachine, errors };
}

/**
 * Worker-Factory (Vorbild nayax-sales.js): Token aus der Env, ein Token = ein
 * Mandant (NAYAX_TENANT_ID bzw. einziger Registry-Mandant), sonst skip.
 * @param {object} deps
 * @param {object} deps.db          Mandanten-Tür (read/tx).
 * @param {{listTenantIds:Function}} [deps.directory]  Registry (Einzel-Mandant-Ableitung).
 * @param {object} [deps.env]       Laufzeit-Env (NAYAX_API_TOKEN/HEADER_NAME/BASE_URL/TENANT_ID).
 * @param {Function} [deps.fetchImpl]  injizierbares fetch (Tests).
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createNayaxFillLevelSyncJob({ db, directory, env = process.env, fetchImpl } = {}) {
  if (!db) throw new TypeError('nayax-filllevel-sync: db (Mandanten-Tür) erforderlich');
  return {
    key: FILL_LEVEL_SYNC_JOB_KEY,
    run: async () => {
      const token = normalizeAuthValue(env.NAYAX_API_TOKEN);
      if (!token) return { skipped: 'kein NAYAX_API_TOKEN in der Env' };
      const tenant = resolveNayaxTenant(env, directory);
      if (!tenant) return { skipped: 'kein eindeutiger Nayax-Mandant (NAYAX_TENANT_ID setzen)' };
      return runFillLevelSync(db, tenant, {
        token,
        headerName: (env.NAYAX_HEADER_NAME && String(env.NAYAX_HEADER_NAME).trim()) || 'Authorization',
        baseUrl: (env.NAYAX_BASE_URL && String(env.NAYAX_BASE_URL).trim()) || NAYAX_DEFAULT_BASE_URL,
        fetchImpl,
      });
    },
  };
}

module.exports = {
  FILL_LEVEL_SYNC_JOB_KEY,
  createNayaxFillLevelSyncJob,
  runFillLevelSync,
  applyFillLevelForMachine,
  listActiveMachineKeys,
  // für gezielte Tests / Wiederverwendung
  applyDexNameFallback,
  ACTIVE_MACHINES_SQL,
  QTY_UPDATE_SQL,
};
