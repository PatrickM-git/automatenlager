'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Operativer Runner für den GuV-Backfill (Issue #172).
// SPEC-Kontext: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
//
// Holt den Nayax-Roh-Export als CSV aus einem freigegebenen Google-Sheet (öffentlicher
// CSV-Export, kein Login) und füllt fehlende guv_daily-Posten je Mandant — idempotent,
// byte-genau wie der Nacht-Job (computeGuvRows), source='guv_backfill' (sichtbar).
//
// Nutzung:
//   node tools/run-guv-backfill.js --dry-run                 # nur Vorschau, kein Write
//   node tools/run-guv-backfill.js                           # schreibt fehlende Posten
//   node tools/run-guv-backfill.js --sheet <id> --tenant t_x # Quelle/Mandant überschreiben
//
// Voraussetzung für den WRITE: Migration 0028 (cost_basis) ist angewendet.
// ─────────────────────────────────────────────────────────────────────────────

const { resolvePgUrl } = require('../tests/helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
// Fetcher + Default-Sheet-/Maschinen-Auflösung sind GETEILT mit dem Worker-Job
// (eine Quelle der Wahrheit) — CLI und wiederkehrender Job laden identisch.
const { runGuvBackfillForTenant, fetchBackfillCsv, resolveSheetId, resolveMachineKey } = require('../lib/jobs/guv-backfill.js');

// Vom Betreiber freigegebenes Sheet mit den Roh-Umsätzen (überschreibbar via --sheet / Env).
const DEFAULT_SHEET_ID = resolveSheetId(process.env);

function parseArgs(argv) {
  const a = { dryRun: false, sheet: DEFAULT_SHEET_ID, tenant: null, machineKey: resolveMachineKey(process.env) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--sheet') a.sheet = argv[++i];
    else if (argv[i] === '--tenant') a.tenant = argv[++i];
    else if (argv[i] === '--machine') a.machineKey = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = resolvePgUrl();
  if (!url) { console.error('BACKFILL: kein DASHBOARD_V2_PG_URL — abgebrochen.'); process.exit(2); }
  let Pool; try { ({ Pool } = require('pg')); } catch { console.error('BACKFILL: pg nicht installiert.'); process.exit(2); }

  console.log(`Lade Roh-Export aus Sheet ${args.sheet} ...`);
  const csvText = await fetchBackfillCsv(args.sheet);
  console.log(`CSV geladen (${csvText.length} Bytes).`);

  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 8000, max: 4 });
  const db = createTenantDb({ pool });
  try {
    let tenants;
    if (args.tenant) tenants = [args.tenant];
    else tenants = (await pool.query(`SELECT DISTINCT tenant_id FROM automatenlager.products ORDER BY tenant_id`)).rows.map((r) => r.tenant_id);

    console.log(`Backfill ${args.dryRun ? '[DRY RUN]' : '[LIVE]'} über ${tenants.length} Mandant(en):`);
    for (const tenant of tenants) {
      const res = await runGuvBackfillForTenant(db, tenant, { csvText, dryRun: args.dryRun, machineKey: args.machineKey });
      console.log(`  ${tenant}: rohe=${res.rawSales} gemappt=${res.mapped} noMap=${res.noMap} noEK=${res.noEK} → ${args.dryRun ? 'NEU(Vorschau)=' + res.newRows : 'inserted=' + res.inserted + ' conflictSkipped=' + res.conflictSkipped}`);
      if (res.noMap || res.noEK) {
        const m = (res.unresolved.noMap || []).slice(0, 8).map((s) => `${s.name}/MDB${s.mdb} ${s.date}`);
        const e = (res.unresolved.noEK || []).slice(0, 8).map((s) => `${s.product_key} ${s.date}`);
        if (m.length) console.log('     noMap:', m.join(' | '));
        if (e.length) console.log('     noEK :', e.join(' | '));
      }
      if (args.dryRun && res.rows && res.rows.length) {
        console.log('     Vorschau (erste 40):');
        for (const r of res.rows.slice(0, 40)) {
          console.log(`       ${r.posting_date} ${r.product_key.padEnd(28)} umsatz=${r.revenue_gross} cogs=${r.cost_of_goods} guv=${r.gross_profit} ${r.cost_basis}`);
        }
        const sumU = res.rows.reduce((s, r) => s + Number(r.revenue_gross), 0);
        console.log(`     Σ Umsatz(neu)=${sumU.toFixed(2)} EUR über ${res.rows.length} Posten`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('BACKFILL Fehler:', e.message); process.exit(1); });
