'use strict';

/**
 * WF5 MHD/Low-Stock-Überwachung + Versand-Abschluss — In-Process-Port
 * (Issue #162, Stufe 6 Slice 2). n8n: scheduleTrigger täglich 07:00.
 *
 *   - Leseseite für die E-Mail: `alert-digest.js` (bereits portiert).
 *   - Warnungs-Lebenszyklus (NEU hier): MHD_EXPIRED/MHD_NEAR/LOW_BATCH erzeugen
 *     + Auto-Resolve durch die Mandanten-Tür. Eigener Read mit IDs/Keys
 *     (der Display-Digest trägt nur Namen, keine FKs).
 *   - Warnungs-INSERT verhaltensgetreu zum WF5→WF-PGW-Zweig: Key-Format
 *     `WARN_<type>_<productKey|NO_PRODUCT>_<batch|mdb|NO_SLOT>`, ON CONFLICT DO NOTHING,
 *     aber als direktes Tür-INSERT mit explizitem tenant_id (RLS-sauber, Slice-1-Muster).
 */

const { buildAlertDigest, queryAlertDigestPg, DEFAULT_LOW_BATCH_THRESHOLD } = require('../alert-digest.js');
const { availableBatchStatusSqlList } = require('../stock-status.js');
const { resolveTenantAlertEmail } = require('./mailer.js');

const WF5_JOB_KEY = 'wf5-monitor';
const DEFAULT_MHD_DAYS = 30;
const MANAGED_WARNING_TYPES = ['MHD_EXPIRED', 'MHD_NEAR', 'LOW_BATCH'];

function clean(v) { return String(v == null ? '' : v).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(); }
function sanitize(v) { return clean(v).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
function num(v) { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : null; }

/** Verhaltensgetreues WF5-Warnungs-Key-Format. */
function wf5WarningKey(type, productKey, batchOrSlot) {
  return ['WARN', type, productKey || 'NO_PRODUCT', batchOrSlot || 'NO_SLOT'].map(sanitize).filter(Boolean).join('_');
}

/** Reine Logik: aus den Bedingungen die zu persistierenden Warnungen ableiten. */
function buildWf5Warnings({ mhdExpired = [], mhdNear = [], lowBatch = [] } = {}) {
  const out = [];
  for (const r of mhdExpired) {
    out.push({
      warning_key: wf5WarningKey('MHD_EXPIRED', r.product_key, r.batch_key),
      warning_type: 'MHD_EXPIRED', severity: 'critical', product_id: r.product_id || null,
      message: clean(r.message) || `MHD abgelaufen: ${clean(r.product_name)} (Charge ${clean(r.batch_key)})`,
    });
  }
  for (const r of mhdNear) {
    out.push({
      warning_key: wf5WarningKey('MHD_NEAR', r.product_key, r.batch_key),
      warning_type: 'MHD_NEAR', severity: 'warning', product_id: r.product_id || null,
      message: clean(r.message) || `MHD bald: ${clean(r.product_name)} (Charge ${clean(r.batch_key)}, in ${r.days_remaining} Tagen)`,
    });
  }
  for (const r of lowBatch) {
    out.push({
      warning_key: wf5WarningKey('LOW_BATCH', r.product_key, r.batch_key),
      warning_type: 'LOW_BATCH', severity: 'warning', product_id: r.product_id || null,
      message: clean(r.message) || `Niedriger Lagerbestand: ${clean(r.product_name)} (${num(r.backstock_qty) ?? 0} Stk.)`,
    });
  }
  return out;
}

/** Reine Logik: Digest → E-Mail (Betreff + Text + einfaches HTML). */
function formatDigestEmail(digest = {}, tenant = '') {
  const c = digest.counts || {};
  const total = (c.mhdExpired || 0) + (c.mhdSoon || 0) + (c.emptyBatches || 0) + (c.lowBatches || 0) + (c.emptySlots || 0) + (c.dataIssues || 0);
  const subject = `[Automatenlager] Bestand & MHD — ${c.mhdExpired || 0} abgelaufen, ${c.mhdSoon || 0} bald, ${c.lowBatches || 0} niedrig`;
  const lines = [
    `Tägliche Bestands-/MHD-Übersicht${tenant ? ` (${tenant})` : ''}:`,
    '',
    `MHD abgelaufen: ${c.mhdExpired || 0}`,
    `MHD bald (<=30 Tage): ${c.mhdSoon || 0}`,
    `Lager leer: ${c.emptyBatches || 0}`,
    `Lager niedrig: ${c.lowBatches || 0}`,
    `Leere Slots: ${c.emptySlots || 0}`,
    `Daten-/Workflow-Fehler: ${c.dataIssues || 0}`,
  ];
  const detail = (label, arr, fmt) => (arr && arr.length ? `\n${label}:\n${arr.map(fmt).join('\n')}` : '');
  const text = lines.join('\n')
    + detail('Abgelaufen', digest.mhdExpired, (e) => `  - ${e.product_name} (Charge ${e.batch_key}, ${e.days_remaining} Tage)`)
    + detail('Niedriger Bestand', digest.lowBatches, (e) => `  - ${e.product_name}: ${e.total_remaining_qty} Stk.`)
    + detail('Probleme', digest.dataIssues, (e) => `  - [${e.severity}] ${e.message}`);
  const html = `<pre>${text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))}</pre>`;
  return { subject, text, html, totalIssues: total };
}

/** Eigener Read MIT IDs/Keys für die Warnungs-Synchronisation (durch die Tür). */
async function readWf5Conditions(db, tenant, { mhdDays = DEFAULT_MHD_DAYS, lowBatchThreshold = DEFAULT_LOW_BATCH_THRESHOLD } = {}) {
  const statuses = availableBatchStatusSqlList();
  // Sequenziell (nicht Promise.all): der #94-Sandbox-Harness teilt EINEN Client; parallele
  // Tür-Reads würden Savepoints überlappen (RELEASE-Reihenfolge → 3B001). Zwei Reads, vernachlässigbar.
  const mhdRes = await db.read({
    tenant, tables: ['stock_batches', 'products'], params: [mhdDays],
    text: `SELECT p.product_key, sb.product_id, sb.batch_key, p.name AS product_name,
                  sb.remaining_qty, (sb.mhd_date - CURRENT_DATE)::int AS days_remaining
             FROM automatenlager.stock_batches sb
             JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
            WHERE sb.tenant_id = $1 AND sb.status IN (${statuses})
              AND sb.remaining_qty > 0 AND sb.mhd_date IS NOT NULL
              AND sb.mhd_date <= CURRENT_DATE + ($2 || ' days')::interval
            ORDER BY sb.mhd_date`,
  });
  const lowRes = await db.read({
    tenant, tables: ['stock_batches', 'slot_assignments', 'products'], params: [lowBatchThreshold],
    text: `WITH bt AS (
               SELECT product_id, SUM(remaining_qty)::int AS total_qty
                 FROM automatenlager.stock_batches
                WHERE status IN (${statuses}) AND tenant_id = $1 GROUP BY product_id)
           SELECT p.product_key, p.product_id, p.name AS product_name,
                  GREATEST(COALESCE(bt.total_qty,0) - COALESCE(SUM(sa.current_machine_qty),0),0)::int AS backstock_qty
             FROM automatenlager.slot_assignments sa
             JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
             LEFT JOIN bt ON bt.product_id = sa.product_id
            WHERE sa.active = TRUE AND sa.tenant_id = $1
            GROUP BY p.product_id, p.name, p.product_key, bt.total_qty
           HAVING GREATEST(COALESCE(bt.total_qty,0) - COALESCE(SUM(sa.current_machine_qty),0),0) <= $2
            ORDER BY backstock_qty`,
  });
  const mhdExpired = []; const mhdNear = [];
  for (const r of mhdRes.rows) {
    if (Number(r.days_remaining) < 0) mhdExpired.push(r); else mhdNear.push(r);
  }
  return { mhdExpired, mhdNear, lowBatch: lowRes.rows };
}

/** Warnungen synchronisieren: neue INSERT (idempotent) + nicht mehr zutreffende Auto-Resolve. */
async function syncWf5Warnings(db, tenant, warnings = [], { nowIso } = {}) {
  return db.tx(tenant, async (door) => {
    let inserted = 0;
    for (const w of warnings) {
      const r = await door.write({
        tables: ['warnings'],
        text: `INSERT INTO automatenlager.warnings
                 (warning_key, warning_type, severity, message, product_id, source_workflow, resolved, created_at, tenant_id)
               VALUES ($2, $3, $4, $5, $6, 'wf5', FALSE, NOW(), $1)
               ON CONFLICT (warning_key) DO NOTHING`,
        params: [w.warning_key, w.warning_type, w.severity, w.message, w.product_id || null],
      });
      inserted += (r.rowCount || 0);
    }
    const currentKeys = warnings.map((w) => w.warning_key);
    const res = await door.write({
      tables: ['warnings'],
      text: `UPDATE automatenlager.warnings
                SET resolved = TRUE, resolved_at = NOW(), resolved_by = 'wf5'
              WHERE tenant_id = $1 AND source_workflow = 'wf5' AND resolved = FALSE
                AND warning_type = ANY($2) AND warning_key <> ALL($3)`,
      params: [MANAGED_WARNING_TYPES, currentKeys],
    });
    return { inserted, resolved: res.rowCount || 0 };
  });
}

/** Orchestrierung je Mandant: Warnungen synchronisieren + Digest-Mail bei Issues. */
async function runWf5MonitorForTenant(db, tenant, { mailer, env = process.env, nowIso } = {}) {
  const cond = await readWf5Conditions(db, tenant, {});
  const warnings = buildWf5Warnings(cond);
  const sync = await syncWf5Warnings(db, tenant, warnings, { nowIso });

  const raw = await queryAlertDigestPg(db, tenant, {});
  const digest = raw && raw.counts ? raw : buildAlertDigest(raw || {});
  const mail = formatDigestEmail(digest, tenant);

  let mailed = false;
  if (mail.totalIssues > 0 && mailer && typeof mailer.send === 'function') {
    await mailer.send({ to: resolveTenantAlertEmail(env, tenant), subject: mail.subject, text: mail.text, html: mail.html });
    mailed = true;
  }
  return { tenant, inserted: sync.inserted, resolved: sync.resolved, issues: mail.totalIssues, mailed };
}

/** Worker-Factory (per Mandant durch die Tür). */
function createWf5MonitorJob({ tenantRunner, mailer, env = process.env } = {}) {
  if (!tenantRunner || typeof tenantRunner.runForAll !== 'function') {
    throw new TypeError('wf5-monitor: tenantRunner mit runForAll() erforderlich');
  }
  return {
    key: WF5_JOB_KEY,
    run: async () => tenantRunner.runForAll(
      (db, tenant) => runWf5MonitorForTenant(db, tenant, { mailer, env }),
      { continueOnError: true },
    ),
  };
}

module.exports = {
  WF5_JOB_KEY,
  MANAGED_WARNING_TYPES,
  wf5WarningKey,
  buildWf5Warnings,
  formatDigestEmail,
  readWf5Conditions,
  syncWf5Warnings,
  runWf5MonitorForTenant,
  createWf5MonitorJob,
};
