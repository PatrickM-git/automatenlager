'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY Pre-Flight (Issue #160, Stufe 6 Slice 0).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Pre-Flight-Pflicht"
//
// Zieht aus der ECHTEN Mini-DB (Verbindung via tests/helpers resolvePgUrl):
//   1. die Definition von automatenlager.pgw_write()  (pg_get_functiondef)
//   2. das reale Schema von audit.workflow_runs        (information_schema)
//   3. die Indizes auf audit.workflow_runs
//
// AUSSCHLIESSLICH SELECT/Katalog-Lesezugriffe — keine Mutation. Ergebnis wird in
// docs/data-model/pgw-write-und-workflow-runs-preflight.md dokumentiert, BEVOR in
// Slice 1–3 gegen pgw_write() portiert wird (realer Stand statt Doku-Annahme).
//
// Nutzung:  node tools/preflight-pgw-write.js
// (liegt bewusst NICHT unter lib/ — kein Mandanten-Datenpfad, nicht im Web-/Worker-Lauf)
// ─────────────────────────────────────────────────────────────────────────────

const { resolvePgUrl } = require('../tests/helpers/migration-sandbox.js');

async function main() {
  const url = resolvePgUrl();
  if (!url) { console.error('PREFLIGHT: kein DASHBOARD_V2_PG_URL — abgebrochen.'); process.exit(2); }
  let Client;
  try { ({ Client } = require('pg')); } catch { console.error('PREFLIGHT: pg nicht installiert.'); process.exit(2); }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 6000 });
  await client.connect();
  try {
    const who = await client.query('SELECT current_user, current_database()');
    console.log('PREFLIGHT current_user/db:', JSON.stringify(who.rows[0]));

    console.log('\n=== 1) automatenlager.pgw_write() DEFINITION ===');
    const fn = await client.query(
      `SELECT pg_get_functiondef(p.oid) AS def,
              pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'automatenlager' AND p.proname = 'pgw_write'`);
    if (!fn.rows.length) console.log('(keine Funktion automatenlager.pgw_write gefunden)');
    for (const r of fn.rows) { console.log('-- args:', r.args); console.log(r.def); }

    console.log('\n=== 2) audit.workflow_runs COLUMNS ===');
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'audit' AND table_name = 'workflow_runs'
        ORDER BY ordinal_position`);
    console.log(cols.rows.length ? JSON.stringify(cols.rows, null, 2) : '(audit.workflow_runs existiert NICHT)');

    console.log('\n=== 3) audit.workflow_runs INDEXES ===');
    const idx = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'audit' AND tablename = 'workflow_runs'`);
    console.log(JSON.stringify(idx.rows, null, 2));

    console.log('\n=== 4) distinct event_type-Werte (letzte 90 Tage, falls Spalte vorhanden) ===');
    try {
      const ev = await client.query(
        `SELECT DISTINCT workflow_key FROM audit.workflow_runs ORDER BY 1 LIMIT 50`);
      console.log('workflow_key-Werte:', JSON.stringify(ev.rows.map((r) => r.workflow_key)));
    } catch (e) { console.log('(workflow_key-Distinct nicht lesbar:', e.message, ')'); }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('PREFLIGHT Fehler:', e.message); process.exit(1); });
