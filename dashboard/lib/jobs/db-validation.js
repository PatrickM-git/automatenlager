'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: DB-Validierung (Konsistenz-Checks) — Issue #161 (Stufe 6, Slice 1).
// Ersetzt WF-Val (n8n `pdIjiyIfVIIPuJIt`), ABER bewusst nur die DB-KONSISTENZ-
// CHECKS. Die WF3-Neustart-Mechanik + der `execution_entity`-Liveness-Check + der
// Nayax-Schreibstillstand-Gegencheck ENTFALLEN (SPEC, §"Pro-Workflow-Disposition"):
// der Worker plant WF3 selbst (kein Neustart-Hack), und n8n-Execution-Telemetrie
// ist durch `audit.workflow_runs` ersetzt (siehe monitor.js).
//
// Basierte auf dem echten „DB - Konsistenzcheck"-SQL, aber BEWUSST auf HANDLUNGS-
// RELEVANTE Befunde eingedampft (Nutzer-Feedback 2026-06-08): der Alert soll nur
// Dinge enthalten, die der Empfänger JETZT ändern kann.
//   * `keine_preise` (Aktive Slots ohne Preis) ENTFERNT — der Preis wird automatisch
//     aus dem ersten Nayax-Verkauf gesetzt; ein preisloser Slot ist nichts, woran der
//     Nutzer direkt etwas tut (Rauschen). [Hängt eher an #163: fehlende Verkäufe.]
//   * `alte_warnungen` schließt jetzt BESTANDS-/MHD-Typen (LOW_BATCH/LOW_STOCK/MHD_*/…)
//     AUS — das sind operative Zustände (z. B. ein bewusster Ladenhüter mit niedrigem
//     Bestand), keine Daten-/Workflow-Fehler. Nur echte Probleme bleiben.
//   * Behalten: negative Mengen, offene Rechnungsvorschläge, echte Workflow-/Datenfehler.
//
// Gelesen PER MANDANT DURCH DIE TÜR (tenant_id=$1, RLS); Alert über den provider-
// agnostischen Mailer an die MANDANTEN-Adresse. KEIN rohes pg (#107-rein).
// ─────────────────────────────────────────────────────────────────────────────

const { resolveTenantAlertEmail } = require('./mailer.js');

const WORKFLOW_KEY = 'wf-db-validation';

const CHECK_ORDER = ['alte_warnungen', 'negative_qty', 'pending_proposals'];
const CHECK_LABELS = {
  negative_qty: 'Negative Lagermengen',
  alte_warnungen: 'Alte ungeloeste Warnungen (>7 Tage)',
  pending_proposals: 'Offene Rechnungsvorschlaege (>14 Tage)',
};

// Warnungstypen, die KEINE Daten-/Workflow-Fehler sind (operative Bestands-/MHD-
// Zustände + Auto-Korrekturen). Sie haben ihre eigene Behandlung und sollen NICHT
// als „alte ungelöste Warnung" alarmieren (sonst Dauer-Fehlalarm bei Ladenhütern).
// Konsistent zu alert-digest.js NON_ISSUE_TYPES.
const NON_ISSUE_WARNING_TYPES = [
  'LOW_STOCK', 'LOW_BATCH', 'EMPTY_BATCH', 'INSUFFICIENT_BATCH_STOCK',
  'MHD_NEAR', 'MHD_EXPIRED', 'MHD_WARNING', 'AUTO_REFILL_SLOT', 'BACKUP_OK',
];

// ── Reads (per Mandant durch die Tür; tenant-scoped, sequenziell) ─────────────
async function readConsistencyChecks(db, tenant) {
  const out = { negative_qty: [], alte_warnungen: [], pending_proposals: [] };

  const r2 = await db.read({
    tenant, tables: ['stock_batches', 'products'], params: [],
    text:
      `SELECT 'Negative Menge (' || sb.remaining_qty || ') fuer: ' || p.name AS message
         FROM automatenlager.stock_batches sb
         JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
        WHERE sb.tenant_id = $1 AND sb.remaining_qty < 0 AND sb.status IN ('aktiv','active','reserve')
        ORDER BY p.name` });
  out.negative_qty = r2.rows || [];

  // Nur ECHTE Daten-/Workflow-Fehler: operative Bestands-/MHD-Typen ausgenommen
  // (sonst Dauer-Fehlalarm bei bewusst niedrigem Bestand / Ladenhütern). Mandant=$1,
  // Ausschluss-Liste ab $2 (die Tür stellt $1 voran).
  const r3 = await db.read({
    tenant, tables: ['warnings'], params: [NON_ISSUE_WARNING_TYPES],
    text:
      `SELECT COUNT(*) || ' ungeloeste Warnungen (Typ: ' || warning_type || ') aelter 7 Tage' AS message
         FROM automatenlager.warnings
        WHERE tenant_id = $1 AND resolved = FALSE AND severity != 'info'
          AND created_at < NOW() - INTERVAL '7 days'
          AND warning_type <> ALL($2::text[])
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
  NON_ISSUE_WARNING_TYPES,
  WORKFLOW_KEY,
};
