'use strict';

// Alert-Digest: einzige Quelle der Wahrheit für die tägliche WF5-Report-Mail.
//
// Hintergrund: WF5 baute die Mail-Sektion „Niedriger Bestand" bisher aus dem
// Google-Sheet `Produkte` (current_machine_qty) — das driftet von PostgreSQL.
// Zusätzlich klassifizierte der Mail-Code harmlose `AUTO_REFILL_SLOT`-Infos
// (WF3-Auto-Korrektur) über `type.includes('SLOT')` als „Workflow-Fehler".
//
// Dieser Endpunkt berechnet alle Mail-Sektionen aus PG-FAKTEN:
//   - MHD (abgelaufen / läuft bald ab)  → stock_batches
//   - Lagerchargen (leer / niedrig)     → stock_batches-Aggregat je Produkt
//   - Niedriger Bestand (leere Slots)   → slot_assignments (active = TRUE), qty = 0
//   - Daten-/Workflowfehler             → NUR operative Warnungen + Workflow-Failures
//
// Bewusst NICHT aus der `warnings`-Tabelle gelesen für Bestand/MHD: die wird
// von WF5 selbst geschrieben → das wäre eine Schleife. Bestand/MHD kommen aus
// den Fakten-Tabellen; nur echte operative Probleme stammen aus warnings/audit.

const { availableBatchStatusSqlList } = require('./stock-status.js');
const { liveWarningReconcileSql } = require('./overview-monitoring.js'); // Self-Healing wie im Cockpit

const DEFAULT_LOW_BATCH_THRESHOLD = 5;
const DEFAULT_MHD_DAYS = 30;

// Warnungstypen, die ein echtes Daten-/Workflowproblem darstellen (rot in der
// Mail). Bestands-/MHD-Typen und info-Auto-Korrekturen sind hier bewusst NICHT
// enthalten — die haben ihre eigenen Sektionen bzw. sind kein Fehler.
const OPERATIONAL_ISSUE_TYPES = new Set([
  'WORKFLOW_ERROR',
  'CONTAINER_DOWN',
  'PG_UNREACHABLE',
  'VALIDATION_DRIFT_SHEETS_PG',
  'BACKUP_FAIL',
  'BACKUP_STALE',
  'UNKNOWN_PRODUCT',
  'UNMATCHED_PRODUCT',
  'MDB_CODE_CHANGED_FOR_PRODUCT',
]);

// Typen, die NIE als Datenfehler zählen — auch wenn ihre Severity mal hoch ist.
// AUTO_REFILL_SLOT ist die WF3-Auto-Heilung („Slot war leer, auf X gesetzt"),
// rein informativ. Bestands-/MHD-Typen haben eigene Sektionen.
const NON_ISSUE_TYPES = new Set([
  'AUTO_REFILL_SLOT',
  'LOW_STOCK',
  'LOW_BATCH',
  'EMPTY_BATCH',
  'INSUFFICIENT_BATCH_STOCK',
  'MHD_NEAR',
  'MHD_EXPIRED',
  'MHD_WARNING',
  'BACKUP_OK',
]);

const ISSUE_SEVERITIES = new Set(['warning', 'critical', 'error']);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Entscheidet, ob eine Warnung als „Daten-/Workflowfehler" in die Mail gehört.
// Der KERN-FIX gegen die Fehlalarme: type-basiert + severity-basiert, NICHT
// mehr per `message.includes('SLOT')`.
function isOperationalIssue(warning = {}) {
  const type = clean(warning.warning_type).toUpperCase();
  const severity = clean(warning.severity).toLowerCase();
  if (warning.resolved === true) return false;
  if (NON_ISSUE_TYPES.has(type)) return false;
  if (severity === 'info') return false;
  if (!ISSUE_SEVERITIES.has(severity)) return false;
  return OPERATIONAL_ISSUE_TYPES.has(type);
}

function buildAlertDigest(raw = {}) {
  const lowBatchThreshold = Number.isFinite(Number(raw.lowBatchThreshold))
    ? Number(raw.lowBatchThreshold)
    : DEFAULT_LOW_BATCH_THRESHOLD;

  // ── MHD: aufteilen in abgelaufen (< 0) und bald (0..30) ──────────────────
  const mhdExpired = [];
  const mhdSoon = [];
  for (const row of raw.mhdBatches || []) {
    const days = Number(row.days_remaining);
    const entry = {
      product_name: clean(row.product_name),
      batch_key: clean(row.batch_key),
      machine_id: clean(row.machine_id),
      mhd_date: clean(row.mhd_date),
      remaining_qty: toNum(row.remaining_qty),
      days_remaining: Number.isFinite(days) ? days : null,
    };
    if (Number.isFinite(days) && days < 0) mhdExpired.push(entry);
    else mhdSoon.push(entry);
  }

  // ── Lager (Backstock) leer (<= 0) und niedrig (1..Schwellwert) ───────────
  // WICHTIG: remaining_qty läuft im Gesamt-Modell (Maschine + Lager, da WF3
  // jeden Verkauf davon abzieht). Echter LAGER-Bestand = SUMME(remaining_qty)
  // − current_machine_qty, exakt wie dashboard/lib/inventory-mhd.js (backstock_qty,
  // GREATEST(..,0)). Sonst würde z.B. "1 Dose im Automat, 0 im Lager" fälschlich
  // als "Lagerbestand 1" gemeldet. Die Query liefert backstock_qty bereits so;
  // total_remaining bleibt als Fallback für direkt übergebene Testdaten.
  const emptyBatches = [];
  const lowBatches = [];
  for (const row of raw.batchTotals || []) {
    const backstock = toNum(row.backstock_qty != null ? row.backstock_qty : row.total_remaining);
    const entry = {
      product_name: clean(row.product_name),
      product_key: clean(row.product_key),
      total_remaining_qty: backstock,
      threshold: lowBatchThreshold,
    };
    if (backstock <= 0) emptyBatches.push(entry);
    else lowBatches.push(entry);
  }

  // ── Niedriger Bestand = leere aktive Slots (current_machine_qty = 0) ──────
  const emptySlots = (raw.emptySlots || []).map((row) => ({
    product_name: clean(row.product_name),
    machine_id: clean(row.machine_id),
    product_slot_key: clean(row.product_slot_key),
    mdb_code: clean(row.mdb_code),
    current_machine_qty: toNum(row.current_machine_qty),
  }));

  // ── Daten-/Workflowfehler: operative Warnungen + Workflow-Failures ───────
  const warningIssues = (raw.warnings || [])
    .filter(isOperationalIssue)
    .map((w) => ({
      source: 'warning',
      warning_type: clean(w.warning_type),
      severity: clean(w.severity).toLowerCase(),
      message: clean(w.message),
      entity: clean(w.warning_key).split('|')[1] || '',
      created_at: w.created_at || null,
    }));

  const workflowIssues = (raw.workflowFailures || []).map((r) => ({
    source: 'workflow_run',
    warning_type: 'WORKFLOW_ERROR',
    severity: 'critical',
    message: `Workflow ${clean(r.workflow_key)} fehlgeschlagen (Status: ${clean(r.status) || 'unbekannt'}).`,
    entity: clean(r.workflow_key),
    created_at: r.finished_at || r.started_at || null,
  }));

  const dataIssues = [...workflowIssues, ...warningIssues];

  return {
    generatedAt: raw.nowIso || null,
    lowBatchThreshold,
    counts: {
      mhdExpired: mhdExpired.length,
      mhdSoon: mhdSoon.length,
      emptyBatches: emptyBatches.length,
      lowBatches: lowBatches.length,
      emptySlots: emptySlots.length,
      dataIssues: dataIssues.length,
    },
    mhdExpired,
    mhdSoon,
    emptyBatches,
    lowBatches,
    emptySlots,
    dataIssues,
  };
}

// #124 (Stufe 3): Hintergrund-/zeitgesteuerter Lesepfad OHNE Viewer. Der Mandant wird
// EXPLIZIT übergeben (vom Endpunkt aus dem Verzeichnis abgeleitet, pro Mandant) —
// NIEMALS ein Default-Mandant. Liest mandantengetrennt durch die Mandanten-Tür.
// Kein/leerer Mandant ⇒ leerer Digest (fail-closed): der Job verschickt dann nichts
// (statt fremde Warnungen). `audit.workflow_runs` ist System-Telemetrie ohne
// tenant_id (geteilte Pipeline) — tenant-gated via `$1::text IS NOT NULL`.
async function queryAlertDigestPg(db, tenant, opts = {}) {
  const lowBatchThreshold = Number.isFinite(Number(opts.lowBatchThreshold))
    ? Number(opts.lowBatchThreshold)
    : DEFAULT_LOW_BATCH_THRESHOLD;
  const mhdDays = Number.isFinite(Number(opts.mhdDays))
    ? Number(opts.mhdDays)
    : DEFAULT_MHD_DAYS;
  const availableStatuses = availableBatchStatusSqlList();
  const [mhdResult, batchResult, slotsResult, warningsResult, workflowResult] = await Promise.all([
    // MHD: 30-Tage-Fenster inkl. bereits abgelaufener Chargen (days < 0).
    db.read({ tenant, tables: ['stock_batches', 'products'], params: [], text:
      `SELECT p.name AS product_name, sb.batch_key, sb.mhd_date::text,
                sb.remaining_qty,
                (sb.mhd_date - CURRENT_DATE)::int AS days_remaining
           FROM automatenlager.stock_batches sb
           JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
          WHERE sb.tenant_id = $1
            AND sb.status IN (${availableStatuses})
            AND sb.remaining_qty > 0
            AND sb.mhd_date IS NOT NULL
            AND sb.mhd_date <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY sb.mhd_date` }),
    // LAGER-Bestand (Backstock) je Produkt, verankert an aktiven Slots. Mandant=$1,
    // Schwellwert=$2 (Tür stellt $1 voran).
    db.read({ tenant, tables: ['stock_batches', 'slot_assignments', 'products'], params: [lowBatchThreshold], text:
      `WITH batch_totals AS (
           SELECT product_id, SUM(remaining_qty)::int AS total_qty
             FROM automatenlager.stock_batches
            WHERE status IN (${availableStatuses}) AND tenant_id = $1
            GROUP BY product_id
         )
         SELECT p.name AS product_name, p.product_key,
                GREATEST(COALESCE(bt.total_qty, 0) - COALESCE(SUM(sa.current_machine_qty), 0), 0)::int AS backstock_qty
           FROM automatenlager.slot_assignments sa
           JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
           LEFT JOIN batch_totals bt ON bt.product_id = sa.product_id
          WHERE sa.active = TRUE AND sa.tenant_id = $1
          GROUP BY p.product_id, p.name, p.product_key, bt.total_qty
         HAVING GREATEST(COALESCE(bt.total_qty, 0) - COALESCE(SUM(sa.current_machine_qty), 0), 0) <= $2
          ORDER BY backstock_qty, product_name` }),
    // Niedriger Bestand = aktive Slots mit Bestand 0 (PG-Fakt).
    db.read({ tenant, tables: ['slot_assignments', 'products'], params: [], text:
      `SELECT sa.product_slot_key, sa.machine_id::text AS machine_id, sa.mdb_code,
                p.name AS product_name, sa.current_machine_qty
           FROM automatenlager.slot_assignments sa
           JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
          WHERE sa.tenant_id = $1
            AND sa.active = TRUE
            AND sa.current_machine_qty = 0
          ORDER BY sa.machine_id, sa.product_slot_key` }),
    // Operative Warnungen (offen) der letzten 7 Tage, self-healing via liveWarningReconcileSql.
    db.read({ tenant, tables: ['warnings', 'stock_batches', 'slot_assignments'], params: [], text:
      `SELECT w.warning_type, w.severity, w.resolved, w.created_at, w.warning_key, w.message
           FROM automatenlager.warnings w
          WHERE w.tenant_id = $1
            AND w.resolved = FALSE
            AND w.created_at >= now() - INTERVAL '7 days'
            AND (${liveWarningReconcileSql(mhdDays)})
          ORDER BY w.created_at DESC
          LIMIT 200` }),
    // Fehlgeschlagene Workflow-Läufe der letzten 24 h — System-Telemetrie, tenant-gated.
    db.read({ tenant, tables: ['workflow_runs'], params: [], text:
      `SELECT DISTINCT ON (workflow_key) workflow_key, started_at, finished_at, status
           FROM audit.workflow_runs
          WHERE started_at >= now() - INTERVAL '24 hours'
            AND $1::text IS NOT NULL
            AND lower(status) NOT IN ('success', 'succeeded', 'ok', 'running', 'new', 'waiting')
          ORDER BY workflow_key, started_at DESC
          LIMIT 50` }),
  ]);

  return {
    nowIso: new Date().toISOString(),
    lowBatchThreshold,
    mhdBatches: mhdResult.rows || [],
    batchTotals: batchResult.rows || [],
    emptySlots: slotsResult.rows || [],
    warnings: warningsResult.rows || [],
    workflowFailures: workflowResult.rows || [],
  };
}

module.exports = {
  buildAlertDigest,
  queryAlertDigestPg,
  isOperationalIssue,
  OPERATIONAL_ISSUE_TYPES,
  NON_ISSUE_TYPES,
  DEFAULT_LOW_BATCH_THRESHOLD,
};
