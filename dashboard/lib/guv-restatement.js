'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GuV-Restatement-Run 0030 (Issue #180): hebt die gebuchte Historie BELEG-TREU
// IN-PLACE auf brutto — vollständig auditiert und rollbackfähig.
// SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
//       §"Restatement: Formel, Umfang & Mandanten-Tor" + §"Audit & Rollback"
//
// DURCH DIE MANDANTEN-TÜR (lib/tenant-db.js, tx): per Mandant, RLS-/$1-gefiltert,
// alles in EINER Transaktion (Audit-Log + UPDATE atomar).
//
//   * UMFANG über cost_basis, NICHT über source: restated wird, was
//     cost_basis='netto' UND dessen Mandant effektiv Kleinunternehmer ist.
//     historic_backfill UND wf8_guv_aggregator werden so beide erfasst.
//   * SCHUTZBEDINGUNG: läuft nur, wenn im Mandanten-Scope KEINE cost_basis IS NULL
//     existiert (sonst sähe das Panel „korrigiert" aus, obwohl nur teilweise).
//   * FORMEL (pro Zeile, kein FIFO-Neulauf; revenue_gross unverändert):
//       new_cost_of_goods = old_cost_of_goods × (1 + Kategorie_MwSt/100)
//       new_gross_profit  = revenue_gross − new_cost_of_goods
//       new_revenue_net   = revenue_gross
//       cost_basis        = 'brutto'
//     Kategorie-MwSt + Faktor aus DERSELBEN costBasisMultiplier-/resolveCategory-
//     Logik wie der korrigierte Nacht-Job (#176) → Historie == go-forward.
//   * IDEMPOTENT: nur cost_basis='netto' im Scope; zweiter Lauf ist No-op.
//   * ROLLBACK: Alt-Werte je guv_key aus audit.guv_restatement_log zurückschreiben,
//     cost_basis zurück auf 'netto', rollback_at/by stempeln (Teil-Rollback je run_id).
// ─────────────────────────────────────────────────────────────────────────────

const { costBasisMultiplier } = require('./guv-ek.js');
const { resolveCategory } = require('./category-config.js');

function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Beleg-treue In-place-Werte einer Zeile (Kleinunternehmer-Pfad).
function computeRestatedRow(row, effConfig) {
  const cat = resolveCategory(effConfig, row.category);
  const vatRate = cat.mwstPct;
  const factor = costBasisMultiplier(vatRate, { kleinunternehmer: true }); // 1 + vatRate/100 (vatRate>0), sonst 1
  const oldCogs = round2(toNum(row.cost_of_goods));
  const revGross = round2(toNum(row.revenue_gross));
  const newCogs = round2(oldCogs * factor);
  return {
    vatRate,
    factor,
    newCogs,
    newGrossProfit: round2(revGross - newCogs),
    newRevenueNet: revGross, // KU: keine USt auf den Umsatz
  };
}

const RESTATE_SCOPE_SQL =
  `SELECT gd.guv_key, gd.source, gd.cost_of_goods, gd.gross_profit,
          gd.revenue_gross, gd.revenue_net, p.category AS category
     FROM automatenlager.guv_daily gd
     LEFT JOIN automatenlager.products p
       ON p.product_id = gd.product_id AND p.tenant_id = gd.tenant_id
    WHERE gd.tenant_id = $1 AND gd.cost_basis = 'netto'`;

/**
 * Restated EINEN Mandanten durch die Tür (tx). Nur wenn effektiv Kleinunternehmer.
 * @param {object} db  createTenantDb(...)-Instanz (mit tx)
 * @param {string} tenant
 * @param {object} opts
 * @param {string}  opts.runId  bündelt den Lauf (Audit + Teil-Rollback)
 * @param {boolean} opts.kleinunternehmer  effektives KU-Flag (Mandanten-Tor)
 * @param {object}  opts.effConfig  buildEffectiveConfig(...)
 * @param {string}  [opts.executedBy='restatement-0030']
 * @param {object}  [opts.executedContext]  operator/host/git_commit/migration/started_at
 * @returns {Promise<{tenant, restated, logged, skipped?}>}
 */
async function restateTenant(db, tenant, { runId, kleinunternehmer, effConfig, executedBy = 'restatement-0030', executedContext = null } = {}) {
  if (!runId) throw new Error('restateTenant: runId erforderlich');
  // MANDANTEN-TOR: regelbesteuerte Mandanten bleiben netto und werden nie restated.
  if (!kleinunternehmer) return { tenant, restated: 0, logged: 0, skipped: 'not_kleinunternehmer' };

  return db.tx(tenant, async (door) => {
    // SCHUTZBEDINGUNG: keine NULL-Zeile im Scope (sonst nur teilweise korrigiert).
    const nullRes = await door.read({
      tables: ['guv_daily'],
      text: `SELECT count(*)::int AS n FROM automatenlager.guv_daily WHERE tenant_id = $1 AND cost_basis IS NULL`,
    });
    const nullCount = nullRes.rows[0] ? nullRes.rows[0].n : 0;
    if (nullCount > 0) {
      throw new Error(`Restatement abgebrochen (Mandant ${tenant}): ${nullCount} cost_basis IS NULL-Zeile(n) im Scope — erst Klassifizierung 0029 (#179) abschließen.`);
    }

    const rows = (await door.read({ tables: ['guv_daily', 'products'], text: RESTATE_SCOPE_SQL })).rows;
    let restated = 0;
    let logged = 0;
    for (const row of rows) {
      const { vatRate, factor, newCogs, newGrossProfit, newRevenueNet } = computeRestatedRow(row, effConfig);

      const upd = await door.write({
        tables: ['guv_daily'],
        text:
          `UPDATE automatenlager.guv_daily
              SET cost_of_goods = $2::numeric, gross_profit = $3::numeric,
                  revenue_net = $4::numeric, cost_basis = 'brutto'
            WHERE tenant_id = $1 AND guv_key = $5 AND cost_basis = 'netto'`,
        params: [newCogs, newGrossProfit, newRevenueNet, row.guv_key],
      });
      if (!upd.rowCount) continue; // bereits brutto (Idempotenz) ⇒ kein Logbuch-Eintrag
      restated += upd.rowCount;

      await door.write({
        tables: ['guv_restatement_log'],
        text:
          `INSERT INTO audit.guv_restatement_log
             (restatement_run_id, tenant_id, guv_key, source,
              old_cost_of_goods, new_cost_of_goods, old_revenue_net, new_revenue_net,
              old_gross_profit, new_gross_profit, vat_rate, factor, executed_by, executed_context)
           VALUES ($2, $1, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric,
                   $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13, $14::jsonb)`,
        params: [runId, row.guv_key, row.source,
          round2(toNum(row.cost_of_goods)), newCogs, round2(toNum(row.revenue_net)), newRevenueNet,
          round2(toNum(row.gross_profit)), newGrossProfit, vatRate, factor, executedBy,
          executedContext ? JSON.stringify(executedContext) : null],
      });
      logged += 1;
    }
    return { tenant, restated, logged };
  });
}

/**
 * Rollback eines Laufs (oder Teil-Laufs) je run_id durch die Tür: Alt-Werte aus dem
 * Logbuch zurückschreiben, cost_basis zurück auf 'netto', rollback_at/by stempeln.
 * Idempotent: nur noch nicht zurückgerollte Logbuch-Zeilen (rollback_at IS NULL).
 */
async function rollbackRun(db, tenant, { runId, rolledBackBy = 'rollback-0030' } = {}) {
  if (!runId) throw new Error('rollbackRun: runId erforderlich');
  return db.tx(tenant, async (door) => {
    const logs = (await door.read({
      tables: ['guv_restatement_log'],
      text:
        `SELECT guv_key, old_cost_of_goods, old_gross_profit, old_revenue_net
           FROM audit.guv_restatement_log
          WHERE tenant_id = $1 AND restatement_run_id = $2 AND rollback_at IS NULL`,
      params: [runId],
    })).rows;

    let rolledBack = 0;
    for (const l of logs) {
      const upd = await door.write({
        tables: ['guv_daily'],
        text:
          `UPDATE automatenlager.guv_daily
              SET cost_of_goods = $3::numeric, gross_profit = $4::numeric,
                  revenue_net = $5::numeric, cost_basis = 'netto'
            WHERE tenant_id = $1 AND guv_key = $2`,
        params: [l.guv_key, l.old_cost_of_goods, l.old_gross_profit, l.old_revenue_net],
      });
      await door.write({
        tables: ['guv_restatement_log'],
        text:
          `UPDATE audit.guv_restatement_log
              SET rollback_at = now(), rollback_by = $4
            WHERE tenant_id = $1 AND restatement_run_id = $2 AND guv_key = $3 AND rollback_at IS NULL`,
        params: [runId, l.guv_key, rolledBackBy],
      });
      rolledBack += upd.rowCount || 0;
    }
    return { tenant, rolledBack };
  });
}

module.exports = { computeRestatedRow, restateTenant, rollbackRun, round2, RESTATE_SCOPE_SQL };
