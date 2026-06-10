'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// EK-Preis-Korrektur pro Lagercharge (Issue #209).
//
// WARUM CHARGE, NICHT PRODUKT: Jede Lagercharge hat einen eigenen EK aus der
// Eingangsrechnung. Der EK ist für die gesamte Charge fix. Die GuV ergibt sich
// daraus — nicht umgekehrt. Korrekturen an der Quelle (Charge) sind sauber.
// Im Gegensatz zur go-forward-Korrektur aus economics-correct.js (alle aktiven
// Chargen) wird hier EINE Charge gezielt korrigiert + die betroffenen guv_daily-
// Zeilen restated.
//
// RESTATEMENT-LOGIK: Die GuV-Aggregation (lib/jobs/guv-aggregate.js) verwendet
// pro Buchungstag die ÄLTESTE aktive Charge (FIFO, ORDER BY received_at ASC).
// Eine Charge ist damit für alle guv_daily-Zeilen dieser product_id maßgeblich,
// deren posting_date >= batch.received_at UND < next_batch.received_at
// (keine obere Schranke für die jüngste Charge).
//
// FORMEL: new_cost_of_goods = old_cost_of_goods × (new_ek / old_ek)
// Wenn old_ek ≈ 0 (Platzhalter-Preis wie Twix 0.016): Fallback auf
//   new_cost_of_goods = quantity_sold × new_ek
// (Zähler-0-Division vermeiden; quantity_sold ist jederzeit vorhanden).
//
// AUDIT: Jede restated guv_daily-Zeile wird in audit.guv_restatement_log
// eingetragen (executed_by='batch-ek-correction', executed_context enthält
// batch_key, old/new unit_cost).
//
// ALLES DURCH DIE TÜR (db.tx, RLS-GUC, tenant_id = $1, explizite tables:).
// ─────────────────────────────────────────────────────────────────────────────

function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function validateBatchEkUpdate({ batchKey, unitCostNet } = {}) {
  const errors = [];
  if (!batchKey || typeof batchKey !== 'string' || !batchKey.trim()) {
    errors.push('batch_key erforderlich');
  }
  const n = toNum(unitCostNet);
  if (!Number.isFinite(n) || n <= 0) errors.push('unit_cost_net muss eine Zahl > 0 sein');
  return { ok: errors.length === 0, errors, value: n };
}

/**
 * Korrigiert unit_cost_net einer Charge + restated betroffene guv_daily-Zeilen.
 * Läuft in EINER db.tx (atomar + RLS-GUC). Gibt Restatement-Zusammenfassung zurück.
 *
 * @param {object} db  createTenantDb-Instanz (mit tx/pool)
 * @param {string} tenant
 * @param {object} opts
 * @param {string} opts.batchKey
 * @param {number} opts.unitCostNet  neuer EK (validiert, > 0)
 * @param {string} opts.runId  bündelt Audit-Log-Einträge
 * @param {string} [opts.executedBy]
 * @returns {Promise<{batchKey, oldUnitCost, newUnitCost, guvRestated, guvLogged}>}
 */
async function applyBatchEkUpdate(db, tenant, { batchKey, unitCostNet, runId, executedBy = 'batch-ek-correction' } = {}) {
  if (!runId) throw new Error('applyBatchEkUpdate: runId erforderlich');

  return db.tx(tenant, async (door) => {
    // 1. Charge sperren (FOR UPDATE) + alten EK lesen.
    const batchRes = await door.read({
      tables: ['stock_batches'],
      text:
        `SELECT batch_id, product_id,
                unit_cost_net::numeric AS old_unit_cost,
                received_at::date AS received_at
           FROM automatenlager.stock_batches
          WHERE tenant_id = $1 AND batch_key = $2
          FOR UPDATE`,
      params: [batchKey],
    });
    if (!batchRes.rows.length) {
      const err = new Error(`Charge ${batchKey} nicht gefunden (oder anderer Mandant)`);
      err.code = 'BATCH_NOT_FOUND';
      throw err;
    }
    const batch = batchRes.rows[0];
    const oldUnitCost = toNum(batch.old_unit_cost);
    const productId = batch.product_id;
    const receivedAt = batch.received_at; // date string 'YYYY-MM-DD'

    // 2. Nächste Charge (FIFO-Datum) für diese product_id → obere Datumsgrenze.
    const nextRes = await door.read({
      tables: ['stock_batches'],
      text:
        `SELECT received_at::date AS received_at
           FROM automatenlager.stock_batches
          WHERE tenant_id = $1 AND product_id = $2 AND received_at::date > $3::date
          ORDER BY received_at ASC LIMIT 1`,
      params: [productId, receivedAt],
    });
    const nextReceivedAt = nextRes.rows.length ? nextRes.rows[0].received_at : null;

    // 3. Batch-EK aktualisieren.
    await door.write({
      tables: ['stock_batches'],
      text:
        `UPDATE automatenlager.stock_batches
            SET unit_cost_net = $2::numeric, updated_at = now()
          WHERE tenant_id = $1 AND batch_key = $3`,
      params: [unitCostNet, batchKey],
    });

    // 4. Betroffene guv_daily-Zeilen lesen.
    const guvRes = await door.read({
      tables: ['guv_daily'],
      text:
        `SELECT guv_key, quantity_sold,
                cost_of_goods::numeric   AS cost_of_goods,
                gross_profit::numeric    AS gross_profit,
                revenue_gross::numeric   AS revenue_gross,
                source
           FROM automatenlager.guv_daily
          WHERE tenant_id = $1
            AND product_id = $2
            AND posting_date >= $3::date
            AND ($4::date IS NULL OR posting_date < $4::date)`,
      params: [productId, receivedAt, nextReceivedAt],
    });

    let guvRestated = 0;
    let guvLogged = 0;
    const auditCtx = JSON.stringify({ batch_key: batchKey, old_unit_cost: oldUnitCost, new_unit_cost: unitCostNet });

    for (const row of guvRes.rows) {
      const oldCogs = toNum(row.cost_of_goods);
      const revGross = toNum(row.revenue_gross);

      // Restatement-Formel: skaliert old_cogs mit dem EK-Verhältnis.
      // Fallback wenn old_ek ≈ 0 (Platzhalter): quantity × new_ek.
      let newCogs;
      if (oldUnitCost > 0.001) {
        newCogs = round2(oldCogs * (unitCostNet / oldUnitCost));
      } else {
        newCogs = round2(toNum(row.quantity_sold) * unitCostNet);
      }
      const newProfit = round2(revGross - newCogs);

      const upd = await door.write({
        tables: ['guv_daily'],
        text:
          `UPDATE automatenlager.guv_daily
              SET cost_of_goods = $2::numeric, gross_profit = $3::numeric
            WHERE tenant_id = $1 AND guv_key = $4`,
        params: [newCogs, newProfit, row.guv_key],
      });
      if (!upd.rowCount) continue;
      guvRestated += upd.rowCount;

      await door.write({
        tables: ['guv_restatement_log'],
        text:
          `INSERT INTO audit.guv_restatement_log
             (restatement_run_id, tenant_id, guv_key, source,
              old_cost_of_goods, new_cost_of_goods, old_revenue_net, new_revenue_net,
              old_gross_profit, new_gross_profit, vat_rate, factor, executed_by, executed_context)
           VALUES ($2, $1, $3, $4,
                   $5::numeric, $6::numeric, $7::numeric, $8::numeric,
                   $9::numeric, $10::numeric, 0, 0, $11, $12::jsonb)`,
        params: [
          runId, row.guv_key, String(row.source || 'unknown'),
          oldCogs, newCogs,
          revGross, revGross, // revenue_net unverändert
          toNum(row.gross_profit), newProfit,
          executedBy, auditCtx,
        ],
      });
      guvLogged++;
    }

    return { batchKey, oldUnitCost, newUnitCost: unitCostNet, guvRestated, guvLogged };
  });
}

module.exports = { validateBatchEkUpdate, applyBatchEkUpdate };
