'use strict';

/**
 * WF3 Nachbuch-Reconciliation (Issue #221).
 *
 * Nayax liefert Verkäufe gelegentlich unvollständig (Preis fehlt) oder ein Verkauf
 * kann zum Importzeitpunkt nicht FIFO-abgebucht werden (kein aktiver Bestand).
 * Solche Zeilen bleiben mit gross_amount = 0 / Fehler-Status in sales_transactions
 * liegen und verfälschen Umsatz/GuV. Dieser Job holt die betroffenen Transaktionen
 * erneut von Nayax (lastSales, Mapping wie der Live-Import in nayax-sales.js), bucht
 * sie nach sobald Preis UND Bestand verfügbar sind, lässt nicht-auflösbare Zeilen
 * ehrlich pending (kein stilles Schlucken) und auditiert jede Korrektur (alt/neu).
 *
 * Aufbau (wie nayax-sales.js — reine Logik von I/O getrennt):
 *   - isReconcilable / computeReconcilePlan : REIN, kein I/O, unit-getestet.
 *   - applyNayaxReconcile(db, tenant, opts) : durch die Mandanten-Tür (db.tx, RLS-GUC).
 *   - readReconcileBacklog(db, tenant)      : Arbeitsvorrat (Sichtbarkeit).
 *   - createNayaxReconcileJob(...)          : Worker-Factory (Nayax-Fetch + per-Mandant).
 *
 * Abgrenzung (bewusst):
 *   - SKIPPED_BEFORE_CUTOVER wird NICHT automatisch verbucht (vor Inventurstart gab
 *     es keinen Bestand → FIFO unmöglich, Doppelzählungsrisiko). Es wird im Backlog
 *     separat gezählt/sichtbar gemacht, aber nicht angefasst.
 *   - Historische Zeilen außerhalb des lastSales-Fensters sind nicht re-fetchbar →
 *     bleiben pending (NO_NAYAX_MATCH). Der laufende Wert ist die wiederkehrende
 *     Korrektur frischer unvollständiger Lieferungen.
 */

const { isAvailableBatchStatus, availableBatchStatusSqlList } = require('../stock-status.js');

const NAYAX_RECONCILE_JOB_KEY = 'wf3-nayax-reconcile';
const DEPLETED_BATCH_STATUS = 'leer';

// Status, deren gross<=0-Zeilen nachbuchungsbedürftig sind (AC1). SKIPPED_BEFORE_CUTOVER
// bewusst AUSGENOMMEN (Vor-Inventur). 'UNKNOWN' fängt den nicht-zugeordneten Importfall.
const RECONCILABLE_STATUSES = Object.freeze(['INSUFFICIENT_BATCH_STOCK', 'OK', 'UNKNOWN']);
const RECONCILABLE_SET = new Set(RECONCILABLE_STATUSES);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function sortByMhd(a, b) {
  const aDate = clean(a.mhd) ? new Date(a.mhd) : new Date('9999-12-31');
  const bDate = clean(b.mhd) ? new Date(b.mhd) : new Date('9999-12-31');
  return aDate - bDate;
}

/**
 * AC1 — „nachbuchungsbedürftig" sauber definiert: fehlender/0-Preis UND ein Status
 * aus der nachbuchbaren Menge. SKIPPED_BEFORE_CUTOVER ⇒ false (bewusst).
 */
function isReconcilable(row) {
  if (!row) return false;
  const g = row.gross_amount;
  const grossEmpty = g == null || !Number.isFinite(Number(g)) || Number(g) <= 0;
  return grossEmpty && RECONCILABLE_SET.has(clean(row.processing_status));
}

/**
 * Kern (REIN). Bekommt Backlog-Zeilen, frische Nayax-Verkäufe und aktive Chargen,
 * schreibt NICHTS. Liefert die BEABSICHTIGTEN Korrekturen + Stock-Movements + die
 * ehrlich pending gebliebenen Zeilen (mit Grund).
 *
 * @param {object} opts
 * @param {Array} opts.backlog     Zeilen wie reconcileBacklogSql liefert
 *   ({nayax_transaction_id, machine_key, product_key, product_slot_key, quantity,
 *     gross_amount, processing_status, settlement_at}).
 * @param {Array} opts.freshSales  rohe Nayax-lastSales (TransactionID, SettlementValue, …).
 * @param {Array} opts.batches     aktive Chargen ({batch_id, product_key, remaining_qty, mhd, status}).
 * @param {object} [opts.config]   {default_quantity_per_sale}.
 * @param {string} [opts.nowIso]
 */
function computeReconcilePlan({ backlog = [], freshSales = [], batches = [], config = {}, nowIso } = {}) {
  const now = nowIso || new Date().toISOString();
  const cfg = config || {};
  const freshById = new Map();
  for (const s of freshSales || []) {
    const id = clean(s.TransactionID || s.transaction_id || s.nayax_transaction_id);
    if (id) freshById.set(id, s);
  }
  // Arbeitskopie der Chargen: FIFO über mehrere Backlog-Zeilen hinweg konsistent.
  const working = (batches || []).map((b) => ({ ...b }));

  const corrections = [];
  const pending = [];
  const stockMovements = [];

  for (const row of backlog || []) {
    const txId = clean(row.nayax_transaction_id);
    if (!txId) continue;
    const qty = Number(row.quantity) || Number(cfg.default_quantity_per_sale) || 1;

    const fresh = freshById.get(txId);
    if (!fresh) { pending.push({ nayax_transaction_id: txId, reason: 'NO_NAYAX_MATCH' }); continue; }

    const price = Number(fresh.SettlementValue);
    if (!Number.isFinite(price) || price <= 0) { pending.push({ nayax_transaction_id: txId, reason: 'NO_PRICE' }); continue; }
    const newGross = round2(qty * price);

    // FIFO-Plan (nur planen, noch nicht abbuchen — Teil-Abbuchung vermeiden).
    const productBatches = working
      .filter((b) => clean(b.product_key) === clean(row.product_key) && isAvailableBatchStatus(b.status) && Number(b.remaining_qty) > 0)
      .sort(sortByMhd);
    let remaining = qty;
    const planned = [];
    for (const b of productBatches) {
      if (remaining <= 0) break;
      const deduct = Math.min(Number(b.remaining_qty), remaining);
      planned.push({ batch: b, deduct });
      remaining -= deduct;
    }
    if (remaining > 0) { pending.push({ nayax_transaction_id: txId, reason: 'INSUFFICIENT_BATCH_STOCK' }); continue; }

    // Abbuchung committen (Arbeitskopie mutieren) + idempotente Movements je Transaktion.
    const deductedBatches = [];
    const movementsForRow = [];
    for (const p of planned) {
      p.batch.remaining_qty = Number(p.batch.remaining_qty) - p.deduct;
      if (p.batch.remaining_qty <= 0) p.batch.status = DEPLETED_BATCH_STATUS;
      deductedBatches.push(String(p.batch.batch_id));
      const movement = {
        movement_key: `wf3_reconcile_${p.batch.batch_id}_${txId}`,
        batch_key: String(p.batch.batch_id),
        product_slot_key: clean(row.product_slot_key) || null,
        movement_type: 'sale',
        quantity_delta_total: -p.deduct,
        quantity_delta_slot: 0,
        reason: 'WF3 Reconcile FIFO Nachbuchung',
        source: 'wf3_nayax_reconcile',
        occurred_at: now,
      };
      movementsForRow.push(movement);
      stockMovements.push(movement);
    }
    corrections.push({
      nayax_transaction_id: txId,
      machine_key: clean(row.machine_key),
      product_key: clean(row.product_key),
      product_slot_key: clean(row.product_slot_key) || null,
      quantity: qty,
      old: { gross: Number(row.gross_amount) || 0, net: Number(row.net_amount) || 0, status: clean(row.processing_status) },
      new: { gross: newGross, net: newGross, vat: 0, status: 'OK' },
      deductedBatches,
      stockMovements: movementsForRow,
      note: `Nachgebucht (#221): Preis ${price} aus Nayax, FIFO über ${deductedBatches.join(', ') || '—'}.`,
    });
  }

  return {
    corrections,
    pending,
    stockMovements,
    summary: {
      backlog: (backlog || []).length,
      corrected: corrections.length,
      pending: pending.length,
      movements: stockMovements.length,
      processed_at: now,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O-Schicht — alles durch die Mandanten-Tür (db.tx / db.read), RLS-GUC,
// explizites tenant_id. Idempotent: das UPDATE trägt einen gross<=0-Guard, sodass
// ein zweiter Lauf 0 Zeilen trifft (kein Doppel-Dekrement, kein Doppel-Audit) —
// analog guv-restatement.js (WHERE cost_basis='netto').
// ─────────────────────────────────────────────────────────────────────────────

// Backlog-Read (AC1/AC6): gross<=0 + Status nachbuchbar. machine_key/product_key/
// product_slot_key für FIFO + Movement-Auflösung. $2 = Status-Array.
const RECONCILE_BACKLOG_SQL = `
  SELECT s.nayax_transaction_id,
         m.machine_key,
         p.product_key,
         sa.product_slot_key,
         s.quantity,
         s.gross_amount,
         s.net_amount,
         s.processing_status,
         s.settlement_at
    FROM automatenlager.sales_transactions s
    LEFT JOIN automatenlager.machines m ON m.machine_id = s.machine_id AND m.tenant_id = s.tenant_id
    LEFT JOIN automatenlager.products p ON p.product_id = s.product_id AND p.tenant_id = s.tenant_id
    LEFT JOIN automatenlager.slot_assignments sa ON sa.slot_assignment_id = s.slot_assignment_id AND sa.tenant_id = s.tenant_id
   WHERE s.tenant_id = $1
     AND (s.gross_amount IS NULL OR s.gross_amount <= 0)
     AND s.processing_status = ANY($2)`;

// Backlog-Zählung (Arbeitsvorrat) — gruppiert nach Status, gross<=0.
const BACKLOG_COUNT_SQL = `
  SELECT s.processing_status, COUNT(*)::int AS n
    FROM automatenlager.sales_transactions s
   WHERE s.tenant_id = $1 AND (s.gross_amount IS NULL OR s.gross_amount <= 0)
   GROUP BY s.processing_status`;

// Aktive Chargen in Plan-Form (batch_id ← batch_key, mhd ← mhd_date).
function reconcileBatchReadSql() {
  return `
  SELECT sb.batch_key AS batch_id, p.product_key, sb.remaining_qty,
         to_char(sb.mhd_date, 'YYYY-MM-DD') AS mhd, sb.status
    FROM automatenlager.stock_batches sb
    JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
   WHERE sb.tenant_id = $1 AND sb.status IN (${availableBatchStatusSqlList()}) AND sb.remaining_qty > 0`;
}

// Idempotentes UPDATE: nur Zeilen mit gross<=0 (Re-Run trifft 0 ⇒ kein Doppel-Effekt).
const SALE_RECONCILE_UPDATE_SQL = `
  UPDATE automatenlager.sales_transactions
     SET gross_amount = $3::numeric, net_amount = $4::numeric, vat_amount = $5::numeric,
         processing_status = $6, processing_note = $7
   WHERE tenant_id = $1 AND nayax_transaction_id = $2
     AND (gross_amount IS NULL OR gross_amount <= 0)`;

// stock_movement (Trigger apply_stock_movement pflegt remaining_qty!). ON CONFLICT
// (tenant_id, movement_key) DO NOTHING ⇒ keine Doppel-Abbuchung.
const MOVEMENT_INSERT_SQL = `
  INSERT INTO automatenlager.stock_movements
    (movement_key, batch_id, slot_assignment_id, movement_type,
     quantity_delta_total, quantity_delta_slot, reason, source, occurred_at, tenant_id)
  SELECT $2, sb.batch_id, sa.slot_assignment_id, $4, $5::integer, $6::integer, $7, $8, $9::timestamptz, $1
    FROM automatenlager.stock_batches sb
    LEFT JOIN automatenlager.slot_assignments sa ON sa.product_slot_key = $3 AND sa.tenant_id = $1
   WHERE sb.batch_key = $10 AND sb.tenant_id = $1
   LIMIT 1
  ON CONFLICT (tenant_id, movement_key) DO NOTHING`;

// Audit alt/neu (Vorbild guv_restatement_log). $1 = tenant (Tür).
const AUDIT_INSERT_SQL = `
  INSERT INTO audit.sales_reconciliation_log
    (reconcile_run_id, tenant_id, nayax_transaction_id, machine_key, product_key, quantity,
     old_gross, new_gross, old_net, new_net, old_status, new_status, deducted_batches,
     executed_by, executed_context)
  VALUES ($2, $1, $3, $4, $5, $6::integer, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
          $11, $12, $13, $14, $15::jsonb)`;

/**
 * Backlog (Arbeitsvorrat) zählen — Sichtbarkeit (AC6). Read-only durch die Tür.
 * @returns {Promise<{reconcilable:number, skippedBeforeCutover:number, byStatus:object}>}
 */
async function readReconcileBacklog(db, tenant) {
  const res = await db.read({ tenant, tables: ['sales_transactions'], text: BACKLOG_COUNT_SQL, params: [] });
  const byStatus = {};
  let reconcilable = 0;
  let skippedBeforeCutover = 0;
  for (const r of res.rows || []) {
    const st = clean(r.processing_status);
    const n = Number(r.n) || 0;
    byStatus[st] = n;
    if (RECONCILABLE_SET.has(st)) reconcilable += n;
    if (st === 'SKIPPED_BEFORE_CUTOVER') skippedBeforeCutover += n;
  }
  return { reconcilable, skippedBeforeCutover, byStatus };
}

/**
 * Nachbuchung durch die Tür anwenden: Backlog + Chargen lesen → Plan rechnen →
 * je Korrektur sales_transactions idempotent UPDATEn, stock_movements INSERTen
 * (Trigger pflegt remaining_qty), Audit (alt/neu) schreiben — alles in EINER db.tx.
 * @param {object} db      Mandanten-Tür (lib/tenant-db.js)
 * @param {string} tenant  expliziter Mandant
 * @param {object} opts    { freshSales, config, nowIso, runId, executedBy, executedContext }
 */
async function applyNayaxReconcile(db, tenant, { freshSales = [], config = {}, nowIso, runId, executedBy = 'reconcile-0036', executedContext = null } = {}) {
  const at = nowIso || new Date().toISOString();
  const rid = runId || `reconcile_${at.slice(0, 10)}`;
  return db.tx(tenant, async (door) => {
    const backlogRes = await door.read({
      tables: ['sales_transactions', 'machines', 'products', 'slot_assignments'],
      text: RECONCILE_BACKLOG_SQL, params: [RECONCILABLE_STATUSES],
    });
    const batchRes = await door.read({ tables: ['stock_batches', 'products'], text: reconcileBatchReadSql() });

    const plan = computeReconcilePlan({ backlog: backlogRes.rows, freshSales, batches: batchRes.rows, config, nowIso: at });

    let correctedCount = 0;
    let movementsWritten = 0;
    for (const c of plan.corrections) {
      const upd = await door.write({
        tables: ['sales_transactions'],
        text: SALE_RECONCILE_UPDATE_SQL,
        params: [c.nayax_transaction_id, c.new.gross, c.new.net, c.new.vat, c.new.status, c.note],
      });
      if (!upd.rowCount) continue; // bereits korrigiert (Idempotenz) ⇒ kein Movement/Audit
      correctedCount += 1;
      for (const m of c.stockMovements) {
        const mr = await door.write({
          tables: ['stock_movements', 'stock_batches', 'slot_assignments'],
          text: MOVEMENT_INSERT_SQL,
          params: [m.movement_key, m.product_slot_key || null, m.movement_type,
            m.quantity_delta_total, m.quantity_delta_slot, m.reason, m.source, m.occurred_at, m.batch_key],
        });
        movementsWritten += (mr.rowCount || 0);
      }
      await door.write({
        tables: ['sales_reconciliation_log'],
        text: AUDIT_INSERT_SQL,
        params: [rid, c.nayax_transaction_id, c.machine_key || null, c.product_key || null, c.quantity,
          c.old.gross, c.new.gross, c.old.net, c.new.net, c.old.status, c.new.status,
          c.deductedBatches.join(','), executedBy, executedContext ? JSON.stringify(executedContext) : null],
      });
    }
    return {
      correctedCount,
      movementsWritten,
      pendingCount: plan.pending.length,
      pending: plan.pending,
      corrections: plan.corrections,
      summary: plan.summary,
      runId: rid,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker-Factory (#221). Holt Nayax-lastSales (gleiche Quelle/Mapping wie der
// Live-Import WF3) und bucht den Backlog je aufgelöstem Mandanten nach. Ein Token
// = ein Mandant (NAYAX_TENANT_ID oder einziger Registry-Mandant). Lauf-Telemetrie
// trägt der Worker über recordRun (audit.workflow_runs); die per-Zeilen-Audits
// schreibt applyNayaxReconcile in audit.sales_reconciliation_log.
// ─────────────────────────────────────────────────────────────────────────────
const { normalizeAuthValue, resolveNayaxTenant } = require('./nayax-devices-sync.js');
const { fetchNayaxLastSales, configFromEnv } = require('./nayax-sales.js');

function createNayaxReconcileJob({ db, directory, env = process.env, fetchImpl } = {}) {
  if (!db) throw new TypeError('nayax-reconcile: db (Mandanten-Tür) erforderlich');
  return {
    key: NAYAX_RECONCILE_JOB_KEY,
    run: async () => {
      const token = normalizeAuthValue(env.NAYAX_API_TOKEN);
      if (!token) return { skipped: 'kein NAYAX_API_TOKEN in der Env' };
      const tenant = resolveNayaxTenant(env, directory);
      if (!tenant) return { skipped: 'kein eindeutiger Nayax-Mandant (NAYAX_TENANT_ID setzen)' };
      const config = configFromEnv(env);
      const sales = await fetchNayaxLastSales({
        token,
        headerName: (env.NAYAX_HEADER_NAME && String(env.NAYAX_HEADER_NAME).trim()) || 'Authorization',
        baseUrl: config.nayax_base_url,
        machineId: config.machine_id,
        fetchImpl,
      });
      const res = await applyNayaxReconcile(db, tenant, { freshSales: sales, config });
      const backlog = await readReconcileBacklog(db, tenant);
      return { tenant, fetched: sales.length, correctedCount: res.correctedCount, pendingCount: res.pendingCount, backlog };
    },
  };
}

module.exports = {
  NAYAX_RECONCILE_JOB_KEY,
  RECONCILABLE_STATUSES,
  isReconcilable,
  computeReconcilePlan,
  applyNayaxReconcile,
  readReconcileBacklog,
  createNayaxReconcileJob,
  // SQL-Bausteine (für gezielte Tests / Wiederverwendung)
  RECONCILE_BACKLOG_SQL,
  reconcileBatchReadSql,
  // interne Helfer (für gezielte Tests / Wiederverwendung)
  round2,
};
