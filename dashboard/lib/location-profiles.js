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

async function queryLocationsPg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT location_id, name, status, notes, start_date, target_group, machine_ids
       FROM automatenlager.locations
       ORDER BY name`
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

async function upsertLocationPg(pgUrl, profileData) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    const { name, status, notes, start_date, target_group, machine_ids } = profileData;
    const res = await client.query(
      `INSERT INTO automatenlager.locations (name, status, notes, start_date, target_group, machine_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET
         status       = EXCLUDED.status,
         notes        = EXCLUDED.notes,
         start_date   = EXCLUDED.start_date,
         target_group = EXCLUDED.target_group,
         machine_ids  = EXCLUDED.machine_ids,
         updated_at   = NOW()
       RETURNING *`,
      [name, status, notes ?? null, start_date ?? null, target_group ?? null, machine_ids]
    );
    return res.rows[0];
  } finally {
    await client.end();
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

module.exports = { buildLocationProfile, buildLocationComparison, queryLocationsPg, upsertLocationPg };
