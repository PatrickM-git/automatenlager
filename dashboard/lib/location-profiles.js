'use strict';

const VALID_STATUSES = ['aktiv', 'inaktiv', 'geplant'];

function buildLocationProfile(raw) {
  if (!raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error('name ist erforderlich');
  }
  if (!VALID_STATUSES.includes(raw.status)) {
    throw new Error(`status muss einer von ${VALID_STATUSES.join(', ')} sein`);
  }
  const machine_ids = Array.isArray(raw.machine_ids)
    ? raw.machine_ids
    : raw.machine_ids != null ? [raw.machine_ids] : [];

  return {
    name: raw.name.trim(),
    status: raw.status,
    notes: raw.notes ?? null,
    start_date: raw.start_date ?? null,
    target_group: raw.target_group ?? null,
    location_type: (raw.location_type != null && String(raw.location_type).trim()) ? String(raw.location_type).trim() : null,
    machine_ids,
  };
}

function buildLocationComparison(profiles, kpiRows) {
  const kpiByMachine = new Map();
  for (const row of kpiRows) {
    kpiByMachine.set(row.machine_id, row);
  }

  return profiles.map((profile) => {
    const machineIds = profile.machine_ids || [];
    const matchingRows = machineIds.map((id) => kpiByMachine.get(id)).filter(Boolean);

    if (matchingRows.length === 0) {
      return { ...profile, kpis: null };
    }

    const kpis = {
      revenue_net: round2(matchingRows.reduce((s, r) => s + Number(r.revenue_net), 0)),
      db_net:      round2(matchingRows.reduce((s, r) => s + Number(r.db_net), 0)),
      qty:         matchingRows.reduce((s, r) => s + Number(r.qty), 0),
      slot_turnover:   round2(avg(matchingRows.map((r) => Number(r.slot_turnover)))),
      inventory_value: round2(matchingRows.reduce((s, r) => s + Number(r.inventory_value), 0)),
    };
    const margin_pct = kpis.revenue_net > 0
      ? round1(kpis.db_net / kpis.revenue_net * 100)
      : 0;
    kpis.margin_pct = margin_pct;

    return { ...profile, kpis };
  });
}

/**
 * Reales Schema von `automatenlager.locations` (Produktiv-DB homelab):
 *   location_id, location_key, name, location_type, address,
 *   customer_group, opening_hours, notes, created_at, updated_at
 *
 * Das Dashboard-Domänenmodell (status / start_date / target_group / machine_ids)
 * existiert dort NICHT als eigene Spalten. Wir bilden es darum lesend ab:
 *   - target_group  ← vorhandene Spalte customer_group
 *   - machine_ids   ← abgeleitet aus automatenlager.machines (FK location_id)
 *   - status        ← abgeleitet aus der Maschinen-Aktivität
 *   - start_date    ← kein Äquivalent im Schema → null
 * So scheitert die Query nicht mehr an fehlenden Spalten (vorher: PG_ERROR
 * "column \"status\" does not exist").
 *
 * Wichtig für die Tests/Regression: Spalten der locations-Tabelle werden
 * konsequent mit dem Alias `l.` qualifiziert, sodass automatisch geprüft
 * werden kann, dass nur real existierende Spalten selektiert werden.
 */
const LOCATIONS_SELECT_SQL = `
  SELECT
    l.location_id,
    l.location_key,
    l.name,
    l.notes,
    l.customer_group AS target_group,
    NULL::date AS start_date,
    COALESCE(
      array_agg(m.machine_key ORDER BY m.machine_key)
        FILTER (WHERE m.machine_key IS NOT NULL),
      ARRAY[]::text[]
    ) AS machine_ids,
    CASE
      WHEN count(*) FILTER (WHERE m.active IS TRUE) > 0 THEN 'aktiv'
      WHEN count(m.machine_id) > 0                     THEN 'inaktiv'
      ELSE 'geplant'
    END AS status
  FROM automatenlager.locations l
  LEFT JOIN automatenlager.machines m ON m.location_id = l.location_id AND m.tenant_id = l.tenant_id
  WHERE l.tenant_id = $1
  GROUP BY l.location_id, l.name, l.notes, l.customer_group
  ORDER BY l.name
`;

// Wandelt eine DB-Zeile (aus SELECT oder INSERT ... RETURNING *) in das
// Domänen-Profil, das buildLocationComparison und das Frontend erwarten.
function mapLocationRow(row) {
  const machineIds = Array.isArray(row.machine_ids)
    ? row.machine_ids
    : row.machine_ids != null ? [row.machine_ids] : [];
  return {
    location_id:  row.location_id ?? null,
    location_key: row.location_key ?? null,
    name:         row.name,
    status:       row.status ?? null,
    notes:        row.notes ?? null,
    start_date:   row.start_date ?? null,
    target_group: row.target_group ?? row.customer_group ?? null,
    machine_ids:  machineIds,
  };
}

// Erzeugt einen deterministischen location_key aus dem Namen (NOT NULL/UNIQUE
// in der Produktiv-Tabelle), z. B. "DPFA Weiterbildung Chemnitz" → "LOC_DPFA_WEITERBILDUNG_CHEMNITZ".
// #1: Ein Standort darf nur gelöscht werden, wenn KEIN Automat mehr dran hängt
// (machines.location_id ist NOT NULL -> sonst stünden Automaten ohne Standort da).
function buildLocationDeleteGuard(machineCount) {
  if (machineCount == null) {
    return { allowed: false, reason: 'Automatenzahl unbekannt – Löschen vorsichtshalber blockiert.' };
  }
  const n = Number(machineCount);
  if (!Number.isFinite(n)) {
    return { allowed: false, reason: 'Automatenzahl unbekannt – Löschen vorsichtshalber blockiert.' };
  }
  if (n > 0) {
    return {
      allowed: false,
      reason: `Standort hat noch ${n} Automat${n === 1 ? '' : 'en'} – bitte zuerst umziehen oder aussondern.`,
    };
  }
  return { allowed: true, reason: '' };
}

// #135 (Stufe 4): durch die Mandanten-Tür, in EINER Transaktion (db.tx). Die
// Belegungs-Prüfung (Automaten am Standort) und das DELETE laufen atomar auf einem
// Client — kein TOCTOU-Fenster, in dem zwischen Prüfung und Löschung ein Automat
// hinzukäme. Beides mandantengebunden (tenant_id = $1): es werden nur eigene
// Maschinen gezählt und nur eigene Standorte gelöscht.
async function deleteLocationPg(db, tenant, locationKey) {
  const key = String(locationKey || '').trim();
  if (!key) throw new Error('location_key ist erforderlich.');
  return db.tx(tenant, async (door) => {
    const cnt = await door.read({
      tables: ['machines', 'locations'],
      text:
        `SELECT count(*)::int AS n
           FROM automatenlager.machines m
           JOIN automatenlager.locations l
             ON l.location_id = m.location_id AND l.tenant_id = m.tenant_id
          WHERE l.tenant_id = $1 AND l.location_key = $2`,
      params: [key],
    });
    const guard = buildLocationDeleteGuard(cnt.rows[0] ? cnt.rows[0].n : 0);
    if (!guard.allowed) {
      const err = new Error(guard.reason);
      err.code = 'LOCATION_NOT_EMPTY';
      throw err;
    }
    const res = await door.write({
      tables: ['locations'],
      text: `DELETE FROM automatenlager.locations WHERE tenant_id = $1 AND location_key = $2 RETURNING location_id`,
      params: [key],
    });
    if (res.rowCount === 0) {
      const err = new Error(`Standort "${key}" nicht gefunden.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return { deleted: key };
  });
}

function slugifyLocationKey(name) {
  const slug = String(name ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `LOC_${slug || 'STANDORT'}`;
}

// #127 (Stufe 3): mandantengetrennt durch die Mandanten-Tür (Lesepfad). Mandant = $1.
// Schreibpfade upsertLocationPg/deleteLocationPg bleiben unverändert = Stufe 4.
async function queryLocationsPg(db, tenant) {
  const res = await db.read({
    tenant,
    tables: ['locations', 'machines'],
    text: LOCATIONS_SELECT_SQL,
    params: [],
  });
  return res.rows.map(mapLocationRow);
}

// #135 (Stufe 4): durch die Mandanten-Tür (Mandant als $1, fail-closed-werfend).
// ON CONFLICT-Ziel ist jetzt (tenant_id, location_key) — Constraint aus #132 —, sodass
// gleicher location_key bei zwei Mandanten zwei getrennte Zeilen ergibt und ein Upsert
// nie die Zeile eines fremden Mandanten überschreibt.
async function upsertLocationPg(db, tenant, profileData) {
  const { name, notes } = profileData;
  const targetGroup = profileData.target_group ?? null;
  const locationKey = profileData.location_key && String(profileData.location_key).trim()
    ? String(profileData.location_key).trim()
    : slugifyLocationKey(name);
  const locationType = profileData.location_type && String(profileData.location_type).trim()
    ? String(profileData.location_type).trim()
    : 'sonstige';
  const res = await db.write({
    tenant,
    tables: ['locations'],
    text:
      `INSERT INTO automatenlager.locations (tenant_id, location_key, name, location_type, customer_group, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, location_key) DO UPDATE SET
         name           = EXCLUDED.name,
         location_type  = EXCLUDED.location_type,
         customer_group = EXCLUDED.customer_group,
         notes          = EXCLUDED.notes,
         updated_at     = NOW()
       RETURNING *`,
    params: [locationKey, name, locationType, targetGroup, notes ?? null],
  });
  return mapLocationRow(res.rows[0]);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

module.exports = {
  buildLocationProfile,
  buildLocationComparison,
  buildLocationDeleteGuard,
  queryLocationsPg,
  upsertLocationPg,
  deleteLocationPg,
  mapLocationRow,
  slugifyLocationKey,
  LOCATIONS_SELECT_SQL,
};
