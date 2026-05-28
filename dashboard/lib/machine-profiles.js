'use strict';

const MACHINE_TYPES = ['Snack', 'Getränke', 'Kombi', 'Sonstiges'];
const MACHINE_POSITIONS = ['links', 'rechts', 'Sonstiges'];
const MACHINE_AREAS = ['EG', '1.OG', '2.OG', '3.OG', 'Sonstiges'];

function buildMachineLabel(profile) {
  const parts = [profile.area, profile.type, profile.position].filter(Boolean);
  if (parts.length === 0 && !profile.nickname) return profile.machine_id;
  if (parts.length === 0) return profile.nickname;
  const base = parts.join(' · ');
  return profile.nickname ? `${base} (${profile.nickname})` : base;
}

function buildMachineProfile(raw) {
  const machine_id = typeof raw.machine_id === 'string' ? raw.machine_id.trim() : '';
  if (!machine_id) throw new Error('machine_id ist erforderlich');
  return {
    machine_id,
    area:     raw.area     ?? null,
    type:     raw.type     ?? null,
    position: raw.position ?? null,
    nickname: raw.nickname ?? null,
  };
}

function getMachineOptions() {
  return {
    types:     MACHINE_TYPES,
    positions: MACHINE_POSITIONS,
    areas:     MACHINE_AREAS,
  };
}

async function queryMachineProfilesPg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT machine_profile_id, machine_id, area, type, position, nickname
       FROM automatenlager.machine_profiles
       ORDER BY area NULLS LAST, type NULLS LAST, machine_id`
    );
    return res.rows.map((row) => ({ ...row, label: buildMachineLabel(row) }));
  } finally {
    await client.end();
  }
}

async function upsertMachineProfilePg(pgUrl, profileData) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    const { machine_id, area, type, position, nickname } = profileData;
    const res = await client.query(
      `INSERT INTO automatenlager.machine_profiles (machine_id, area, type, position, nickname)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (machine_id) DO UPDATE SET
         area       = EXCLUDED.area,
         type       = EXCLUDED.type,
         position   = EXCLUDED.position,
         nickname   = EXCLUDED.nickname,
         updated_at = NOW()
       RETURNING *`,
      [machine_id, area ?? null, type ?? null, position ?? null, nickname ?? null]
    );
    return { ...res.rows[0], label: buildMachineLabel(res.rows[0]) };
  } finally {
    await client.end();
  }
}

module.exports = {
  buildMachineLabel,
  buildMachineProfile,
  getMachineOptions,
  queryMachineProfilesPg,
  upsertMachineProfilePg,
};
