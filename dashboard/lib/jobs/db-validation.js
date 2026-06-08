'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: DB-Validierung (Konsistenz-Checks) — Issue #161 (Stufe 6, Slice 1).
// Ersetzt WF-Val (n8n `pdIjiyIfVIIPuJIt`), ABER bewusst nur die DB-KONSISTENZ-
// CHECKS. Die WF3-Neustart-Mechanik + der `execution_entity`-Liveness-Check + der
// Nayax-Schreibstillstand-Gegencheck ENTFALLEN (SPEC, §"Pro-Workflow-Disposition"):
// der Worker plant WF3 selbst (kein Neustart-Hack), und n8n-Execution-Telemetrie
// ist durch `audit.workflow_runs` ersetzt (siehe monitor.js).
//
// FAITHFUL gegen den echten „DB - Konsistenzcheck"-SQL + „Code - Ergebnisse
// aggregieren": die 4 Checks (keine_preise, negative_qty, alte_warnungen,
// pending_proposals), Gruppierung, Betreff/HTML-Format. Gelesen PER MANDANT DURCH
// DIE TÜR (tenant_id=$1, RLS); Alert über den provider-agnostischen Mailer an die
// MANDANTEN-Adresse. KEIN rohes pg (#107-rein).
// ─────────────────────────────────────────────────────────────────────────────

const { resolveTenantAlertEmail } = require('./mailer.js');

const WORKFLOW_KEY = 'wf-db-validation';

// Reihenfolge + Labels faithful zum n8n (ORDER BY check_type ⇒ alphabetisch).
const CHECK_ORDER = ['alte_warnungen', 'keine_preise', 'negative_qty', 'pending_proposals'];
const CHECK_LABELS = {
  keine_preise: 'Aktive Slots ohne Preis',
  negative_qty: 'Negative Lagermengen',
  alte_warnungen: 'Alte ungeloeste Warnungen (>7 Tage)',
  pending_proposals: 'Offene Rechnungsvorschlaege (>14 Tage)',
};

// ── Reads (per Mandant durch die Tür; tenant-scoped, sequenziell) ─────────────
async function readConsistencyChecks(db, tenant) {
  const out = { keine_preise: [], negative_qty: [], alte_warnungen: [], pending_proposals: [] };

  const r1 = await db.read({
    tenant, tables: ['slot_assignments', 'products', 'machines', 'prices'], params: [],
    text:
      `SELECT 'Aktiver Slot ohne Preis: ' || p.name AS message
         FROM automatenlager.slot_assignments sa
         JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
         JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
         LEFT JOIN automatenlager.prices pr ON pr.slot_assignment_id = sa.slot_assignment_id AND pr.tenant_id = sa.tenant_id AND pr.valid_to IS NULL
        WHERE sa.tenant_id = $1 AND sa.active = TRUE AND pr.price_id IS NULL
        ORDER BY p.name` });
  out.keine_preise = r1.rows || [];

  const r2 = await db.read({
    tenant, tables: ['stock_batches', 'products'], params: [],
    text:
      `SELECT 'Negative Menge (' || sb.remaining_qty || ') fuer: ' || p.name AS message
         FROM automatenlager.stock_batches sb
         JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
        WHERE sb.tenant_id = $1 AND sb.remaining_qty < 0 AND sb.status IN ('aktiv','active','reserve')
        ORDER BY p.name` });
  out.negative_qty = r2.rows || [];

  const r3 = await db.read({
    tenant, tables: ['warnings'], params: [],
    text:
      `SELECT COUNT(*) || ' ungeloeste Warnungen (Typ: ' || warning_type || ') aelter 7 Tage' AS message
         FROM automatenlager.warnings
        WHERE tenant_id = $1 AND resolved = FALSE AND severity != 'info' AND created_at < NOW() - INTERVAL '7 days'
        GROUP BY warning_type HAVING COUNT(*) > 0
        ORDER BY warning_type` });
  out.alte_warnungen = r3.rows || [];

  const r4 = await db.read({
    tenant, tables: ['product_change_proposals'], params: [],
    text:
      `SELECT 'Proposal seit ' || EXTRACT(DAY FROM NOW()-created_at)::int || ' Tagen offen: ' || COALESCE(reason,'?') AS message
         FROM automatenlager.product_change_proposals
        WHERE tenant_id = $1 AND status = 'pending' AND created_at < NOW() - INTERVAL '14 days'
        ORDER BY created_at` });
  out.pending_proposals = r4.rows || [];

  return out;
}

// ── Reiner Report-Bau (faithful zum n8n-Mail-Format, ohne WF3/Stall-Sektionen) ─
function buildValidationReport(findings = {}, nowIso) {
  const groups = CHECK_ORDER
    .map((type) => ({ type, label: CHECK_LABELS[type] || type, msgs: (findings[type] || []).map((r) => r.message) }))
    .filter((g) => g.msgs.length);
  const count = groups.reduce((s, g) => s + g.msgs.length, 0);
  if (count === 0) {
    return { hasIssues: false, count: 0, subject: null, html: null, summary: 'Alle Pruefungen bestanden (DB-Konsistenz ok).' };
  }
  const plural = count !== 1 ? 'e' : '';
  const otherLines = groups
    .map((g) => `<h3 style="color:#c0392b">${g.label} (${g.msgs.length})</h3><ul>${g.msgs.map((m) => '<li>' + m + '</li>').join('')}</ul>`)
    .join('');
  const ts = nowIso || new Date().toISOString();
  return {
    hasIssues: true,
    count,
    subject: `[DB-Check] ${count} Problem${plural} - Automatenlager`,
    html: `<h2 style="color:#c0392b">WF-Val Pruefung: ${count} Problem${plural}</h2>${otherLines}<hr><p style="color:#888;font-size:12px">WF-Val Check: ${ts}</p>`,
  };
}

// ── Per-Mandant-Lauf: prüfen + (bei Issues) mailen ───────────────────────────
async function validateTenant(db, tenant, { mailer, env = process.env, now } = {}) {
  const findings = await readConsistencyChecks(db, tenant);
  const report = buildValidationReport(findings, now ? now() : undefined);
  let mailed = false;
  let recipient = null;
  if (report.hasIssues && mailer) {
    recipient = resolveTenantAlertEmail(env, tenant);
    if (recipient) {
      await mailer.send({ to: recipient, subject: report.subject, html: report.html });
      mailed = true;
    }
  }
  return { tenant, count: report.count, hasIssues: report.hasIssues, mailed, recipient };
}

/**
 * @param {object} deps
 * @param {{runForAll:Function}} deps.tenantRunner
 * @param {{send:Function}} [deps.mailer]
 * @param {object} [deps.env]
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createDbValidationJob({ tenantRunner, mailer, env = process.env } = {}) {
  if (!tenantRunner || typeof tenantRunner.runForAll !== 'function') {
    throw new TypeError('db-validation: tenantRunner mit runForAll() erforderlich');
  }
  return {
    key: WORKFLOW_KEY,
    run: async () => {
      const res = await tenantRunner.runForAll((db, tenant) => validateTenant(db, tenant, { mailer, env }), { continueOnError: true });
      const issues = Object.values(res.perTenant).reduce((s, r) => s + ((r && r.count) || 0), 0);
      const mails = Object.values(res.perTenant).filter((r) => r && r.mailed).length;
      return { tenants: res.tenants.length, issues, mails, errors: res.errors, perTenant: res.perTenant };
    },
  };
}

module.exports = {
  createDbValidationJob,
  validateTenant,
  readConsistencyChecks,
  buildValidationReport,
  CHECK_LABELS,
  CHECK_ORDER,
  WORKFLOW_KEY,
};
