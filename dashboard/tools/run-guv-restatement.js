'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Operativer Runner für das GuV-Restatement 0030 (Issue #180).
// SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
// Runbook (Rollback): docs/security/guv-restatement-0030-rollback.md
//
// Hebt die gebuchte Historie je Mandant beleg-treu in-place auf brutto — DURCH DIE
// MANDANTEN-TÜR (lib/tenant-db.js, tx), vollständig auditiert (audit.guv_restatement_log).
// Mandanten-Tor: nur effektive Kleinunternehmer (heute global __default__).
//
// VORHER zwingend: Preflight (tools/preflight-guv-daily.js, #177) muss Exit 0 liefern
// und 0028/0029 müssen angewendet sein (keine cost_basis IS NULL im Scope).
//
// Nutzung:
//   node tools/run-guv-restatement.js                 # Vorwärts-Restatement (alle Mandanten)
//   node tools/run-guv-restatement.js --tenant t_x    # nur ein Mandant
//   node tools/run-guv-restatement.js --rollback <run_id>   # Rollback eines Laufs
// ─────────────────────────────────────────────────────────────────────────────

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolvePgUrl } = require('../tests/helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { restateTenant, rollbackRun } = require('../lib/guv-restatement.js');
const { buildEffectiveConfig, sanitizeOverride } = require('../lib/category-config.js');
const { readKleinunternehmer } = require('../lib/guv-ek.js');

function parseArgs(argv) {
  const args = { rollback: null, tenant: null, runId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rollback') args.rollback = argv[++i];
    else if (argv[i] === '--tenant') args.tenant = argv[++i];
    else if (argv[i] === '--run-id') args.runId = argv[++i];
  }
  return args;
}

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = resolvePgUrl();
  if (!url) { console.error('RESTATEMENT: kein DASHBOARD_V2_PG_URL — abgebrochen.'); process.exit(2); }
  let Pool;
  try { ({ Pool } = require('pg')); } catch { console.error('RESTATEMENT: pg nicht installiert.'); process.exit(2); }
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 8000, max: 4 });
  const db = createTenantDb({ pool });

  try {
    // Mandanten-Liste: alle mit cost_basis='netto' (Vorwärts) bzw. mit Logbuch (Rollback).
    const tenantsRes = args.rollback
      ? await pool.query(
        `SELECT DISTINCT tenant_id FROM audit.guv_restatement_log WHERE restatement_run_id = $1 ORDER BY tenant_id`, [args.rollback])
      : await pool.query(
        `SELECT DISTINCT tenant_id FROM automatenlager.guv_daily WHERE cost_basis = 'netto' ORDER BY tenant_id`);
    let tenants = tenantsRes.rows.map((r) => r.tenant_id);
    if (args.tenant) tenants = tenants.filter((t) => t === args.tenant);
    if (!tenants.length) { console.log('RESTATEMENT: keine passenden Mandanten gefunden.'); return; }

    if (args.rollback) {
      console.log(`ROLLBACK run_id=${args.rollback} über ${tenants.length} Mandant(en):`);
      for (const tenant of tenants) {
        const res = await rollbackRun(db, tenant, { runId: args.rollback, rolledBackBy: `${os.userInfo().username}@${os.hostname()}` });
        console.log(`  ${tenant}: ${res.rolledBack} Zeile(n) zurückgerollt`);
      }
      return;
    }

    const runId = args.runId || `restatement-0030-${new Date().toISOString()}`;
    const executedContext = {
      operator: os.userInfo().username,
      host: os.hostname(),
      git_commit: gitCommit(),
      migration: '0030',
      started_at: new Date().toISOString(),
    };
    console.log(`RESTATEMENT run_id=${runId} über ${tenants.length} Mandant(en):`);

    // Config je Mandant — heute global __default__ (per-Mandant = Stufe 6).
    const cfgRow = (await pool.query(
      `SELECT config FROM automatenlager.classification_settings WHERE mandant_id='__default__'`)).rows[0];
    const config = (cfgRow && cfgRow.config) || {};
    const kleinunternehmer = readKleinunternehmer(config);
    const effConfig = buildEffectiveConfig(sanitizeOverride(config));
    console.log(`Besteuerungsmodell (effektiv, __default__): kleinunternehmer=${kleinunternehmer}`);

    let total = 0;
    for (const tenant of tenants) {
      const res = await restateTenant(db, tenant, { runId, kleinunternehmer, effConfig, executedContext });
      total += res.restated;
      console.log(`  ${tenant}: restated=${res.restated} logged=${res.logged}${res.skipped ? ` (${res.skipped})` : ''}`);
    }
    console.log(`\nFERTIG: ${total} Zeile(n) restated. run_id=${runId}`);
    console.log('Rollback bei Bedarf: node tools/run-guv-restatement.js --rollback ' + runId);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('RESTATEMENT Fehler:', e.message); process.exit(1); });
