'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: Nayax-Devices-Sync — Issue #161 (Stufe 6, Slice 1). Ersetzt WF-Nayax-Devices-Sync.
//
// FAITHFUL PORT (gegen die echte WF-JSON `EaVcB3REMttuKZPa` + DB-Schema-Dump):
//   1) HTTP GET https://lynx.nayax.com/operational/v1/machines?ResultsLimit=500
//      mit httpHeaderAuth (Header `Authorization: <token>` — aus dem n8n-Credential
//      extrahiert; Header-Name/Token kommen zur LAUFZEIT aus der Env, nie aus Code).
//   2) Map je Maschine → {nayax_machine_id, machine_number, machine_name} mit den
//      gleichen Feld-Fallbacks wie der n8n-Code; leere IDs verworfen.
//   3) Upsert `nayax_devices` ON CONFLICT (nayax_machine_id) DO UPDATE — aber PER
//      MANDANT DURCH DIE TÜR mit EXPLIZITEM tenant_id (das n8n schrieb via DEFAULT
//      't_faltrix' unter BYPASSRLS; wir setzen den Mandanten explizit unter RLS).
//
// MANDANT: ein Nayax-Token gehört EINEM Nayax-Account = EINEM Mandanten. Der
// Ziel-Mandant kommt aus `NAYAX_TENANT_ID`, ersatzweise — wenn die Registry GENAU
// EINEN Mandanten führt — aus dieser. Mehrdeutig/leer ⇒ KEIN Sync (fail-closed,
// kein Falsch-Mandant). Per-Mandant-Token (mehrere Accounts) = Credential-Vault,
// Stufe 7.
//
// HTTP-Client injizierbar (Tests laufen ohne Netz). KEIN rohes pg (#107-rein).
// ─────────────────────────────────────────────────────────────────────────────

const { withTimeout } = require('../fetch-timeout.js');

const WORKFLOW_KEY = 'wf-nayax-devices-sync';
const NAYAX_MACHINES_URL = 'https://lynx.nayax.com/operational/v1/machines';
const DEFAULT_RESULTS_LIMIT = 500;

// n8n-httpHeaderAuth-Werte können n8n-EXPRESSIONS sein (führendes '='): n8n wertet
// sie zur Laufzeit aus und sendet NUR den Teil DANACH (z. B. `=Bearer <token>` →
// Header `Bearer <token>`). `export:credentials` liefert die rohe Expression INKL.
// '=' — würde man sie 1:1 senden, lehnt die API ab (403 „please use API Token").
// Daher ein einzelnes führendes '=' defensiv entfernen (verifiziert live: mit '=' →
// 403, ohne → 200).
function normalizeAuthValue(v) {
  const s = String(v == null ? '' : v).trim();
  return s.startsWith('=') ? s.slice(1) : s;
}

function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

/** Faithful zum n8n „Map Devices"-Code: Feld-Fallbacks + leere IDs verwerfen. */
function mapDevices(machines) {
  return (Array.isArray(machines) ? machines : [])
    .map((it) => ({
      nayax_machine_id: firstNonEmpty(it, ['MachineID', 'MachineId', 'machineId', 'machine_id']),
      machine_number: firstNonEmpty(it, ['MachineNumber', 'MachineNo', 'machine_number']),
      machine_name: firstNonEmpty(it, ['MachineName', 'Description', 'machine_name']),
    }))
    .filter((r) => r.nayax_machine_id !== '');
}

/** Ziel-Mandant: explizit (NAYAX_TENANT_ID) ODER der einzige Registry-Mandant. */
function resolveNayaxTenant(env, directory) {
  const explicit = env && env.NAYAX_TENANT_ID && String(env.NAYAX_TENANT_ID).trim();
  if (explicit) return explicit;
  const ids = directory && typeof directory.listTenantIds === 'function' ? directory.listTenantIds() : [];
  if (Array.isArray(ids) && ids.length === 1 && String(ids[0]).trim()) return String(ids[0]).trim();
  return null; // mehrdeutig/leer ⇒ fail-closed
}

/** Nayax-Maschinen holen (robust gegen Array- ODER {Data:[…]}-Antwortform). */
async function fetchNayaxMachines({ token, headerName = 'Authorization', baseUrl = NAYAX_MACHINES_URL, resultsLimit = DEFAULT_RESULTS_LIMIT, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new TypeError('nayax-devices-sync: kein fetch verfügbar — fetchImpl injizieren');
  const url = `${baseUrl}?ResultsLimit=${encodeURIComponent(resultsLimit)}`;
  const res = await doFetch(url, withTimeout({ method: 'GET', headers: { [headerName]: token, accept: 'application/json' } }));
  if (!res.ok) throw new Error(`nayax-devices-sync: Nayax HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  for (const k of ['Data', 'data', 'Machines', 'machines', 'Items', 'items', 'result', 'Result']) {
    if (data && Array.isArray(data[k])) return data[k];
  }
  return [];
}

/**
 * Nayax machineProducts je Automat (n8n-Ablösung 2026-06-11, ersetzt den
 * WF-Nayax-Abgleich-Preview-Fetch). Ergänzt je Item den Produktnamen über
 * GET /operational/v1/products/{NayaxProductID} — tolerant gegen Fehler
 * (faithful zum n8n-Knoten mit onError: continueRegularOutput), Details je
 * Produkt-ID nur EINMAL geholt (Cache).
 */
async function fetchNayaxMachineProducts({ token, headerName = 'Authorization', baseUrl = 'https://lynx.nayax.com', machineId, fetchImpl, withDetails = true } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new TypeError('nayax-machine-products: kein fetch verfügbar — fetchImpl injizieren');
  if (!machineId) throw new TypeError('nayax-machine-products: machineId erforderlich');
  const headers = { [headerName]: token, accept: 'application/json' };
  const res = await doFetch(`${baseUrl}/operational/v1/machines/${encodeURIComponent(machineId)}/machineProducts`, withTimeout({ method: 'GET', headers }));
  if (!res.ok) throw new Error(`nayax machineProducts HTTP ${res.status}`);
  const data = await res.json();
  let items = [];
  if (Array.isArray(data)) items = data;
  else for (const k of ['Data', 'data', 'Items', 'items']) { if (data && Array.isArray(data[k])) { items = data[k]; break; } }
  if (!withDetails) return items;
  const nameCache = new Map();
  for (const it of items) {
    const pid = it && (it.NayaxProductID ?? it.ProductId);
    if (pid == null || String(pid).trim() === '') {
      // Ohne Produkt-ID kein detail-Call — aber der DEX-Name bleibt als Fallback
      // (faithful zur n8n-Map-Node: name = detail || it.DEXProductName).
      if (it && !it.ProductName && it.DEXProductName) it.ProductName = it.DEXProductName;
      continue;
    }
    const key = String(pid).trim();
    if (!nameCache.has(key)) {
      try {
        const dRes = await doFetch(`${baseUrl}/operational/v1/products/${encodeURIComponent(key)}`, withTimeout({ method: 'GET', headers }));
        const dJson = dRes.ok ? await dRes.json() : null;
        nameCache.set(key, (dJson && (dJson.ProductName || dJson.DEXProductName)) || '');
      } catch { nameCache.set(key, ''); }
    }
    const detName = nameCache.get(key);
    if (detName) it.ProductName = detName;
    else if (!it.ProductName && it.DEXProductName) it.ProductName = it.DEXProductName;
  }
  return items;
}

/** Upsert der Geräte für EINEN Mandanten durch die Tür (db.tx, explizites tenant_id). */
async function upsertDevices(db, tenant, rows) {
  if (!rows.length) return { upserted: 0 };
  return db.tx(tenant, async (door) => {
    let n = 0;
    for (const r of rows) {
      // SEQUENZIELL (ein tx-Client). ON CONFLICT (nayax_machine_id) = der globale PK
      // (faithful zu WF/pgw); tenant_id NUR beim Insert gesetzt, im UPDATE unberührt
      // (bleibt = GUC ⇒ RLS-WITH-CHECK ok). provider 'nayax' (Default der Tabelle).
      await door.write({
        tables: ['nayax_devices'],
        text:
          `INSERT INTO automatenlager.nayax_devices
             (tenant_id, provider, nayax_machine_id, machine_number, machine_name, last_seen_at, synced_at)
           VALUES ($1, 'nayax', $2, $3, $4, now(), now())
           ON CONFLICT (nayax_machine_id) DO UPDATE SET
             machine_number = EXCLUDED.machine_number,
             machine_name   = EXCLUDED.machine_name,
             last_seen_at   = now(),
             synced_at      = now()`,
        params: [r.nayax_machine_id, r.machine_number || null, r.machine_name || null],
      });
      n++;
    }
    return { upserted: n };
  });
}

/**
 * @param {object} deps
 * @param {object} deps.db          Mandanten-Tür (forTenant/tx).
 * @param {{listTenantIds:Function}} [deps.directory]  Registry (für Einzel-Mandant-Ableitung).
 * @param {object} [deps.env]       Laufzeit-Env (Token/Header/Mandant).
 * @param {Function} [deps.fetchImpl]  injizierbares fetch (Tests).
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createNayaxDevicesSyncJob({ db, directory, env = process.env, fetchImpl } = {}) {
  if (!db) throw new TypeError('nayax-devices-sync: db (Mandanten-Tür) erforderlich');
  return {
    key: WORKFLOW_KEY,
    run: async () => {
      const token = normalizeAuthValue(env.NAYAX_API_TOKEN);
      if (!token) return { skipped: 'kein NAYAX_API_TOKEN in der Env' };
      const tenant = resolveNayaxTenant(env, directory);
      if (!tenant) return { skipped: 'kein eindeutiger Nayax-Mandant (NAYAX_TENANT_ID setzen)' };

      const machines = await fetchNayaxMachines({
        token,
        headerName: (env.NAYAX_HEADER_NAME && String(env.NAYAX_HEADER_NAME).trim()) || 'Authorization',
        resultsLimit: Number(env.NAYAX_RESULTS_LIMIT) || DEFAULT_RESULTS_LIMIT,
        fetchImpl,
      });
      const rows = mapDevices(machines);
      const res = await upsertDevices(db, tenant, rows);
      return { tenant, fetched: Array.isArray(machines) ? machines.length : 0, mapped: rows.length, ...res };
    },
  };
}

module.exports = {
  createNayaxDevicesSyncJob,
  mapDevices,
  normalizeAuthValue,
  resolveNayaxTenant,
  fetchNayaxMachines,
  fetchNayaxMachineProducts,
  upsertDevices,
  WORKFLOW_KEY,
  NAYAX_MACHINES_URL,
};
