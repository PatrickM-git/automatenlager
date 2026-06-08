'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY Pre-Flight für den WF8-GuV-Port (Issue #161, Stufe 6 Slice 1).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Pre-Flight-Pflicht"
//
// Zieht aus der ECHTEN Mini-DB:
//   1. pgw_write()-Zweig für event_type='guv_daily' (aus pg_get_functiondef)
//   2. reales Schema von automatenlager.guv_daily (Spalten/Defaults)
//   3. Constraints/Indizes auf guv_daily (guv_key-Unique global + (tenant_id,guv_key))
//   4. BEFORE-INSERT-Trigger auf guv_daily (tenant-Vererbung)
//   5. classification_settings __default__ (GuV-Konfig der Realität)
//   6. Beispiel-Zeilenzahl/letzte posting_date je source (Sanity, kein PII-Dump)
//
// AUSSCHLIESSLICH SELECT/Katalog — keine Mutation. Nutzung: node tools/preflight-guv-daily.js
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

    console.log('\n=== 1) pgw_write() — voller Funktionskörper (guv_daily-Zweig extrahieren) ===');
    const fn = await client.query(
      `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'automatenlager' AND p.proname = 'pgw_write'`);
    if (!fn.rows.length) { console.log('(keine Funktion pgw_write gefunden)'); }
    else {
      const def = fn.rows[0].def;
      // Nur den guv_daily-Abschnitt ausgeben (Funktion ist lang); Kontext großzügig.
      const idx = def.indexOf("'guv_daily'");
      if (idx === -1) { console.log('(kein guv_daily-Zweig im Funktionskörper gefunden — voller Dump folgt)\n', def); }
      else {
        const start = Math.max(0, def.lastIndexOf('WHEN', idx) - 4);
        // bis zum nächsten "WHEN" nach dem guv_daily-INSERT
        const nextWhen = def.indexOf('WHEN ', idx + 20);
        const end = nextWhen === -1 ? Math.min(def.length, idx + 1600) : nextWhen;
        console.log(def.slice(start, end));
      }
    }

    console.log('\n=== 2) automatenlager.guv_daily COLUMNS ===');
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'automatenlager' AND table_name = 'guv_daily'
        ORDER BY ordinal_position`);
    console.log(cols.rows.length ? JSON.stringify(cols.rows, null, 2) : '(guv_daily existiert NICHT)');

    console.log('\n=== 3) guv_daily CONSTRAINTS + INDEXES ===');
    const cons = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname='automatenlager' AND t.relname='guv_daily'
        ORDER BY conname`);
    console.log('constraints:', JSON.stringify(cons.rows, null, 2));
    const idx = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='automatenlager' AND tablename='guv_daily' ORDER BY indexname`);
    console.log('indexes:', JSON.stringify(idx.rows, null, 2));

    console.log('\n=== 4) guv_daily TRIGGERS ===');
    const trg = await client.query(
      `SELECT tgname, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='automatenlager' AND c.relname='guv_daily' AND NOT t.tgisinternal
        ORDER BY tgname`);
    console.log(JSON.stringify(trg.rows, null, 2));

    console.log('\n=== 5) classification_settings __default__ (GuV-Konfig) ===');
    const cfg = await client.query(
      `SELECT mandant_id, config FROM automatenlager.classification_settings WHERE mandant_id='__default__'`);
    console.log(JSON.stringify(cfg.rows, null, 2));

    console.log('\n=== 6) guv_daily Bestand je source (Sanity, keine PII) ===');
    const stat = await client.query(
      `SELECT source, count(*) AS n, min(posting_date) AS min_d, max(posting_date) AS max_d
         FROM automatenlager.guv_daily GROUP BY source ORDER BY n DESC`);
    console.log(JSON.stringify(stat.rows, null, 2));

    console.log('\n=== 7) RLS-Policies auf guv_daily ===');
    const pol = await client.query(
      `SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
         FROM pg_policy WHERE polrelid = 'automatenlager.guv_daily'::regclass`);
    console.log(JSON.stringify(pol.rows, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('PREFLIGHT Fehler:', e.message); process.exit(1); });
