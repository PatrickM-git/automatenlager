'use strict';
// Live-DB-Introspektion -> db_inventory.snapshot.json (Tabellen/Views, Spalten, Zeilen).
// Nutzung: set -a; source dashboard/.env.local; set +a; node dump-db-inventory.js
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
(async () => {
  const url = process.env.DASHBOARD_V2_PG_URL;
  if (!url) { console.error('DASHBOARD_V2_PG_URL fehlt'); process.exit(2); }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await c.connect();
  try {
    const cols = await c.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='automatenlager' ORDER BY table_name, ordinal_position`);
    const tables = {};
    for (const r of cols.rows) (tables[r.table_name] = tables[r.table_name] || []).push(r.column_name);
    const base = await c.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='automatenlager' AND table_type='BASE TABLE'`);
    const baseSet = new Set(base.rows.map((r) => r.table_name));
    const out = {};
    for (const [t, columns] of Object.entries(tables)) {
      let rows = null;
      if (baseSet.has(t)) { try { rows = (await c.query(`SELECT COUNT(*)::int n FROM automatenlager."${t}"`)).rows[0].n; } catch { rows = '?'; } }
      out[t] = { isTable: baseSet.has(t), rows, columns };
    }
    fs.writeFileSync(path.join(__dirname, 'db_inventory.snapshot.json'), JSON.stringify(out, null, 1));
    console.log('db_inventory.snapshot.json aktualisiert (', Object.keys(out).length, 'Relationen )');
  } finally { await c.end(); }
})();
