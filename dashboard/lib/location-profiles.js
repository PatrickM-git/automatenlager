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
    l.name,
    l.notes,
    l.customer_group AS target_group,
    NULL::date AS start_date,
    COALESCE(
      array_agg(m.machine_id::text ORDER BY m.machine_id)
        FILTER (WHERE m.machine_id IS NOT NULL),
      ARRAY[]::text[]
    ) AS machine_ids,
    CASE
      WHEN count(*) FILTER (WHERE m.active IS TRUE) > 0 THEN 'aktiv'
      WHEN count(m.machine_id) > 0                     THEN 'inaktiv'
      ELSE 'geplant'
    END AS status
  FROM automatenlager.locations l
  LEFT JOIN automatenlager.machines m ON m.location_id = l.location_id
  GROUP BY l.location_id, l.name, l.notes, l.customer_group
  ORDER BY l.name
`;

function defaultClientFactory(pgUrl) {
  const { Client } = require('pg');
  return new Client({ connectionString: pgUrl });
}

// Wandelt eine DB-Zeile (aus SELECT oder INSERT ... RETURNING *) in das
// Domänen-Profil, das buildLocationComparison und das Frontend erwarten.
function mapLocationRow(row) {
  const machineIds = Array.isArray(row.machine_ids)
    ? row.machine_ids
    : row.machine_ids != null ? [row.machine_ids] : [];
  return {
    location_id:  row.location_id ?? null,
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

async function queryLocationsPg(pgUrl, clientFactory) {
  const client = (clientFactory || defaultClientFactory)(pgUrl);
  await client.connect();
  try {
    const res = await client.query(LOCATIONS_SELECT_SQL);
    return res.rows.map(mapLocationRow);
  } finally {
    await client.end();
  }
}

async function upsertLocationPg(pgUrl, profileData, clientFactory) {
  const client = (clientFactory || defaultClientFactory)(pgUrl);
  await client.connect();
  try {
    const { name, notes } = profileData;
    const targetGroup = profileData.target_group ?? null;
    const locationKey = profileData.location_key && String(profileData.location_key).trim()
      ? String(profileData.location_key).trim()
      : slugifyLocationKey(name);
    const locationType = profileData.location_type && String(profileData.location_type).trim()
      ? String(profileData.location_type).trim()
      : 'sonstige';
    const res = await client.query(
      `INSERT INTO automatenlager.locations (location_key, name, location_type, customer_group, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (location_key) DO UPDATE SET
         name           = EXCLUDED.name,
         location_type  = EXCLUDED.location_type,
         customer_group = EXCLUDED.customer_group,
         notes          = EXCLUDED.notes,
         updated_at     = NOW()
       RETURNING *`,
      [locationKey, name, locationType, targetGroup, notes ?? null]
    );
    return mapLocationRow(res.rows[0]);
  } finally {
    await client.end();
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

module.exports = {
  buildLocationProfile,
  buildLocationComparison,
  queryLocationsPg,
  upsertLocationPg,
  mapLocationRow,
  slugifyLocationKey,
  LOCATIONS_SELECT_SQL,
};
