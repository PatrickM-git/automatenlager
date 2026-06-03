'use strict';

const { availableBatchStatusSqlList } = require('./stock-status.js');

const PIPELINE_STALE_THRESHOLD_MINUTES = 24 * 60;

// Live-Abgleich: Die warnings-Tabelle wird nachts von WF5 aus dem Google-Sheet
// geschrieben und veraltet (driftet von PG). Bestands-bezogene Warnungen
// (MHD/Slot leer/Charge fast leer) werden daher gegen den AKTUELLEN PG-Stand
// geprueft und nur gezeigt, wenn die Bedingung jetzt noch zutrifft. System-/
// Betriebswarnungen (CONTAINER_DOWN, WORKFLOW_ERROR, …) bleiben unberuehrt.
const LIVE_WARNING_RECONCILE_SQL = `
  CASE
    WHEN w.warning_type IN ('MHD_NEAR', 'MHD_EXPIRED') THEN EXISTS (
      SELECT 1 FROM automatenlager.stock_batches sb
       WHERE sb.product_id = w.product_id
         AND sb.remaining_qty > 0
         AND sb.status IN (${availableBatchStatusSqlList()})
         AND sb.mhd_date <= CURRENT_DATE + INTERVAL '30 days'
    )
    WHEN w.warning_type = 'LOW_STOCK' THEN EXISTS (
      SELECT 1 FROM automatenlager.slot_assignments sa
       WHERE sa.product_id = w.product_id AND sa.active = TRUE
         AND sa.current_machine_qty = 0
    )
    WHEN w.warning_type = 'LOW_BATCH' THEN (
      SELECT COALESCE(SUM(sb.remaining_qty), 0) FROM automatenlager.stock_batches sb
       WHERE sb.product_id = w.product_id
         AND sb.status IN (${availableBatchStatusSqlList()})
    ) <= 5
    ELSE TRUE
  END`;

function clean(value) {
  return String(value ?? '').trim();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function findLastEvidenceAt(raw = {}) {
  const timestamps = [];
  for (const row of raw.warnings || []) {
    if (row?.created_at) timestamps.push(row.created_at);
  }
  for (const row of raw.workflowRuns || []) {
    if (row?.finished_at) timestamps.push(row.finished_at);
    else if (row?.started_at) timestamps.push(row.started_at);
  }
  if (!timestamps.length) return null;
  return timestamps
    .map(parseDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];
}

function buildStaleInfo(raw = {}) {
  const now = parseDate(raw.nowIso) || new Date();
  const lastEvidenceAt = findLastEvidenceAt(raw);
  if (!lastEvidenceAt) {
    return {
      isStale: true,
      lastEvidenceAt: null,
      message: 'Keine Pipeline-Aktivität gefunden – Monitoring prüfen.',
    };
  }

  const ageMinutes = Math.floor((now.getTime() - lastEvidenceAt.getTime()) / 60000);
  const isStale = ageMinutes > PIPELINE_STALE_THRESHOLD_MINUTES;
  return {
    isStale,
    ageMinutes,
    lastEvidenceAt: lastEvidenceAt.toISOString(),
    message: isStale
      ? `Datenstand veraltet: seit ${Math.floor(ageMinutes / 60)} h keine Pipeline-Aktivität – Monitoring prüfen.`
      : 'Datenstand live aus PostgreSQL abgerufen.',
  };
}

function unresolvedWarnings(raw = {}, warningType) {
  return (raw.warnings || []).filter((row) => {
    if (clean(row.warning_type).toUpperCase() !== warningType.toUpperCase()) return false;
    return row.resolved !== true;
  });
}

function hasContainerDown(raw = {}, needle) {
  return unresolvedWarnings(raw, 'CONTAINER_DOWN')
    .some((row) => clean(row.warning_key).toLowerCase().includes(needle.toLowerCase()));
}

function hasWorkflowError(raw = {}) {
  return unresolvedWarnings(raw, 'WORKFLOW_ERROR').length > 0;
}

function ampel(key, label, state, message, details = '') {
  return { key, label, state, message, details };
}

function buildMonitoringData(raw = {}) {
  const valDrift = unresolvedWarnings(raw, 'VALIDATION_DRIFT_SHEETS_PG').length;
  const pgUnreachable = unresolvedWarnings(raw, 'PG_UNREACHABLE').length;
  const backupStale = unresolvedWarnings(raw, 'BACKUP_STALE').length;
  const backupFail = unresolvedWarnings(raw, 'BACKUP_FAIL').length;
  const hasBackupOk = raw.hasBackupOk === true;
  const stale = buildStaleInfo(raw);

  const postgresState = pgUnreachable > 0 ? 'red' : 'green';
  const n8nState = hasContainerDown(raw, 'n8n') ? 'red' : hasWorkflowError(raw) ? 'yellow' : 'green';
  const backupState = (backupStale > 0 || backupFail > 0) ? 'red' : hasBackupOk ? 'green' : 'yellow';
  const validationState = valDrift > 0 ? 'yellow' : 'green';
  const workflowsState = hasWorkflowError(raw) ? 'red' : 'green';
  const monitoringState = stale.isStale ? 'yellow' : 'green';

  const warnings = (raw.warnings || []).map(buildWarningDrilldown);

  return {
    stale,
    warnings,
    ampels: [
      ampel('postgres', 'PostgreSQL', postgresState, pgUnreachable > 0 ? 'Nicht erreichbar' : 'Verbindung ok'),
      ampel('n8n', 'n8n', n8nState, n8nState === 'red' ? 'Container down' : n8nState === 'yellow' ? 'Workflow-Fehler erkannt' : 'Dienst ok'),
      ampel('backups', 'Backups', backupState, backupState === 'red' ? 'Backup stale/fehlgeschlagen' : backupState === 'yellow' ? 'Noch kein BACKUP_OK erkannt' : 'Backup ok'),
      ampel('validation', 'Validierung', validationState, validationState === 'yellow' ? `${valDrift} Drift-Warnung(en)` : 'Keine Drift-Warnung offen'),
      ampel('workflows', 'Workflows', workflowsState, workflowsState === 'red' ? 'Offene Workflow-Fehler' : 'Keine offenen Workflow-Fehler'),
      ampel('monitoring', 'Monitoring', monitoringState, monitoringState === 'yellow' ? 'Monitoring-Daten veraltet' : 'Monitoring aktuell'),
    ],
  };
}

function addPriority(list, id, severity, title, message, count = 0) {
  if (!count) return;
  list.push({ id, severity, title, message, count });
}

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

// Höchste Severity über die TATSÄCHLICH offenen Warnungen, die im Drilldown
// gezeigt werden. So bleibt das zugeklappte Sammel-Label „Offene Warnungen"
// deckungsgleich mit der aufgeklappten Detailliste (kein „kritisch" oben,
// während unten nur „Warnung"/„Info" steht). resolved-/BACKUP_OK-Zeilen
// zählen nicht — analog zur Warnungs-Liste in queryOverviewMonitoringPg.
function highestOpenWarningSeverity(warnings = []) {
  let best = null;
  for (const w of warnings) {
    if (w.resolved === true) continue;
    if (clean(w.warning_type).toUpperCase() === 'BACKUP_OK') continue;
    const sev = clean(w.severity).toLowerCase();
    const rank = SEVERITY_RANK[sev] || 0;
    if (rank > (SEVERITY_RANK[best] || 0)) best = sev;
  }
  // Fallback, falls der Zähler > 0 ist, die (auf 7 Tage/40 Zeilen begrenzte)
  // Liste aber leer bleibt: konservativ „warning", nie fälschlich „critical".
  return best || 'warning';
}

function buildOverviewData(raw = {}) {
  const metrics = {
    openWarningsCount: toNum(raw.openWarningsCount),
    mhdRiskCount: toNum(raw.mhdRiskCount),
    lowStockCount: toNum(raw.lowStockCount),
    revenueGrossToday: Math.round(toNum(raw.economicsToday?.revenueGross) * 100) / 100,
    revenueNetToday: Math.round(toNum(raw.economicsToday?.revenueNet) * 100) / 100,
    quantityToday: Math.round(toNum(raw.economicsToday?.quantity)),
  };

  const priorities = [];
  addPriority(
    priorities,
    'warnings-open',
    highestOpenWarningSeverity(raw.warnings),
    'Offene Warnungen',
    `${metrics.openWarningsCount} offene Warnung(en) erfordern Pruefung.`,
    metrics.openWarningsCount,
  );
  {
    // Eskaliere auf 'critical', sobald eine Charge bereits abgelaufen ist
    // (days_remaining < 0). Das MHD-Fenster selbst bleibt wie im Cockpit-KPI
    // bei 30 Tagen (siehe queryOverviewMonitoringPg), damit der Zaehler zur
    // v3-Cockpit-Kachel deckungsgleich bleibt.
    const anyExpired = (raw.mhdItems || []).some((it) => Number(it.days_remaining) < 0);
    addPriority(
      priorities,
      'mhd-risk',
      anyExpired ? 'critical' : 'warning',
      'MHD-Risiko',
      `${metrics.mhdRiskCount} Produkt(e) mit MHD-Risiko gefunden.`,
      metrics.mhdRiskCount,
    );
  }
  addPriority(
    priorities,
    'low-stock',
    'warning',
    'Leere Slots',
    `${metrics.lowStockCount} Slot(s) leer.`,
    metrics.lowStockCount,
  );
  if (metrics.revenueGrossToday > 0) {
    priorities.push({
      id: 'economics',
      severity: 'info',
      title: 'Wirtschaft heute',
      message: `${metrics.revenueGrossToday.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR Umsatz, ${metrics.quantityToday} Stück verkauft.`,
      count: metrics.quantityToday,
    });
  }

  return {
    metrics,
    priorities,
    mhdItems: raw.mhdItems || [],
    lowStockItems: raw.lowStockItems || [],
  };
}

async function queryOverviewMonitoringPg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const [
      openWarningsResult,
      mhdItemsResult,
      lowStockItemsResult,
      economicsResult,
      workflowRunsResult,
      warningsResult,
      backupOkResult,
    ] = await Promise.all([
      client.query(
        // BACKUP_OK ist eine Erfolgsmeldung, keine offene Warnung — wie in der
        // Warnungs-Liste unten ausschließen, sonst bläht es den Cockpit-Zähler auf.
        `SELECT COUNT(*)::int AS count FROM (
           SELECT DISTINCT ON (warning_type, COALESCE(product_id::text, warning_key))
             warning_id
           FROM automatenlager.warnings w
           WHERE w.resolved = FALSE
             AND w.warning_type != 'BACKUP_OK'
             AND NOT (
               w.warning_type = 'MDB_CODE_CHANGED_FOR_PRODUCT'
               AND w.product_id IS NOT NULL
               AND (SELECT COUNT(*) FROM automatenlager.slot_assignments sa WHERE sa.active = TRUE AND sa.product_id = w.product_id) > 1
             )
             AND (${LIVE_WARNING_RECONCILE_SQL})
           ORDER BY warning_type, COALESCE(product_id::text, warning_key), created_at DESC
         ) d`,
      ),
      // MHD-Risiko: 30-Tage-Fenster wie bisher (KPI-deckungsgleich mit dem
      // v3-Cockpit), liefert jetzt zusaetzlich die Chargen-Zeilen inkl.
      // days_remaining fuer den Overview-Drilldown. Bereits abgelaufene Chargen
      // (days_remaining < 0) sind eingeschlossen und eskalieren die Prioritaet.
      client.query(
        `SELECT p.name AS product_name, sb.batch_key, sb.mhd_date::text,
                (sb.mhd_date - CURRENT_DATE)::int AS days_remaining
           FROM automatenlager.stock_batches sb
           JOIN automatenlager.products p ON p.product_id = sb.product_id
          WHERE sb.status IN (${availableBatchStatusSqlList()})
            AND sb.remaining_qty > 0
            AND sb.mhd_date IS NOT NULL
            AND sb.mhd_date <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY sb.mhd_date`,
      ),
      // Cockpit-KPI "Leere Slots": nur wirklich leere Slots (= 0), deckungsgleich
      // mit der Detailseite (inventory-mhd.js). "Unter Zielbestand" war als Cockpit-
      // Signal zu laut (Normalzustand), die echte Aktion ist der leere Slot.
      // Liefert zusaetzlich die Slot-Zeilen fuer den Overview-Drilldown.
      client.query(
        `SELECT sa.product_slot_key, sa.machine_id, p.name AS product_name,
                sa.current_machine_qty
           FROM automatenlager.slot_assignments sa
           JOIN automatenlager.products p ON p.product_id = sa.product_id
          WHERE sa.active = TRUE
            AND sa.current_machine_qty = 0
          ORDER BY sa.machine_id, sa.product_slot_key`,
      ),
      // Umsatz HEUTE live aus sales_transactions (von WF3 befüllt), NICHT aus
      // guv_daily — letzteres wird erst nachts (WF8, 02:00) aggregiert und ist
      // tagsüber 0. Brutto, konsistent zur GuV-Live-Kachel (economics-live.js).
      client.query(
        `SELECT COALESCE(SUM(gross_amount), 0)::numeric AS revenue_gross,
                COALESCE(SUM(net_amount), 0)::numeric   AS revenue_net,
                COALESCE(SUM(quantity), 0)::int         AS quantity
           FROM automatenlager.sales_transactions
          WHERE (settlement_at AT TIME ZONE 'Europe/Berlin')::date
                = (now() AT TIME ZONE 'Europe/Berlin')::date
            AND source <> 'historic_backfill'`,
      ),
      client.query(
        `SELECT workflow_key, started_at, finished_at, status
           FROM audit.workflow_runs
          WHERE started_at >= now() - INTERVAL '3 days'
          ORDER BY started_at DESC
          LIMIT 80`,
      ),
      // Bestands-Warnungen (LOW_BATCH/LOW_STOCK) tragen einen von WF5
      // EINGEFRORENEN Meldungstext mit veralteter Stückzahl (z. B. „Nur noch 5
      // im Lager", obwohl längst leer). Das Cockpit prüft die Bedingung zwar
      // live, zeigte aber die alte Zahl. Daher hier den Text für diese Typen aus
      // dem AKTUELLEN PG-Stand neu bauen: Lager = echter Backstock
      // GREATEST(SUM(remaining_qty) − SUM(current_machine_qty), 0), exakt wie
      // inventory-mhd.js / alert-digest.js. MHD-/System-Warnungen bleiben
      // unverändert (ihr Text ist datums-/zustandsbasiert).
      client.query(
        `WITH live_stock AS (
           SELECT p.product_id, p.name,
                  GREATEST(COALESCE(b.total, 0) - COALESCE(s.mq, 0), 0)::int AS backstock,
                  COALESCE(s.mq, 0)::int AS machine_qty
             FROM automatenlager.products p
             LEFT JOIN (
               SELECT product_id, SUM(remaining_qty)::int AS total
                 FROM automatenlager.stock_batches
                WHERE status IN (${availableBatchStatusSqlList()})
                GROUP BY product_id
             ) b ON b.product_id = p.product_id
             LEFT JOIN (
               SELECT product_id, SUM(current_machine_qty)::int AS mq
                 FROM automatenlager.slot_assignments
                WHERE active = TRUE
                GROUP BY product_id
             ) s ON s.product_id = p.product_id
         ),
         filtered AS (
           SELECT DISTINCT ON (warning_type, COALESCE(product_id::text, warning_key))
             warning_type, severity, resolved, created_at, warning_key, message, product_id
           FROM automatenlager.warnings w
           WHERE w.created_at >= now() - INTERVAL '7 days'
             AND w.warning_type != 'BACKUP_OK'
             AND w.resolved = FALSE
             AND NOT (
               w.warning_type = 'MDB_CODE_CHANGED_FOR_PRODUCT'
               AND w.product_id IS NOT NULL
               AND (SELECT COUNT(*) FROM automatenlager.slot_assignments sa WHERE sa.active = TRUE AND sa.product_id = w.product_id) > 1
             )
             AND (${LIVE_WARNING_RECONCILE_SQL})
           ORDER BY warning_type, COALESCE(product_id::text, warning_key), created_at DESC
         )
         SELECT f.warning_type, f.severity, f.resolved, f.created_at, f.warning_key,
                CASE
                  WHEN f.warning_type = 'LOW_BATCH' AND ls.product_id IS NOT NULL THEN
                    CASE WHEN ls.backstock <= 0
                         THEN ls.name || ': Lager leer (0 im Lager, ' || ls.machine_qty || ' im Automat).'
                         ELSE ls.name || ': Nur noch ' || ls.backstock || ' Stück im Lager (Schwellwert 5).' END
                  WHEN f.warning_type = 'LOW_STOCK' AND ls.product_id IS NOT NULL THEN
                    ls.name || ': ' || ls.machine_qty || ' Stück im Automaten.'
                  ELSE f.message
                END AS message
         FROM filtered f
         LEFT JOIN live_stock ls ON ls.product_id = f.product_id
         ORDER BY
           CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           f.created_at DESC
         LIMIT 40`,
      ),
      // BACKUP_OK separat zaehlen: aus der Warnungs-Liste oben gefiltert, aber
      // fuer die Backup-Ampel (gruen bei frischem BACKUP_OK) weiterhin noetig.
      client.query(
        `SELECT COUNT(*)::int AS count FROM automatenlager.warnings
          WHERE warning_type = 'BACKUP_OK'
            AND resolved = FALSE
            AND created_at >= now() - INTERVAL '3 days'`,
      ),
    ]);

    const mhdItems = mhdItemsResult.rows || [];
    const lowStockItems = lowStockItemsResult.rows || [];

    return {
      nowIso: new Date().toISOString(),
      openWarningsCount: toNum(openWarningsResult.rows?.[0]?.count),
      mhdRiskCount: mhdItems.length,
      mhdItems,
      lowStockCount: lowStockItems.length,
      lowStockItems,
      hasBackupOk: toNum(backupOkResult.rows?.[0]?.count) > 0,
      economicsToday: {
        revenueGross: toNum(economicsResult.rows?.[0]?.revenue_gross),
        revenueNet: toNum(economicsResult.rows?.[0]?.revenue_net),
        quantity: toNum(economicsResult.rows?.[0]?.quantity),
      },
      workflowRuns: workflowRunsResult.rows || [],
      warnings: warningsResult.rows || [],
    };
  } finally {
    await client.end();
  }
}

const CORRECTION_LINK_TYPES = new Set([
  'UNKNOWN_PRODUCT',
  'UNMATCHED_PRODUCT',
  'MDB_CODE_CHANGED_FOR_PRODUCT',
]);

function buildWarningDrilldown(warning = {}) {
  const parts = clean(warning.warning_key).split('|');
  let entity = null;
  if (parts.length >= 2) {
    entity = parts[1];
  } else {
    const msg = clean(warning.message);
    const colonIdx = msg.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) {
      entity = msg.substring(0, colonIdx).trim();
    }
  }
  // Strip leading [TYPE_TAG] prefix from entity (e.g. "[EMPTY_BATCH] 7 Days Croissant" → "7 Days Croissant")
  if (entity) entity = entity.replace(/^\[[^\]]+\]\s*/, '').trim() || entity;
  const correctionLink = CORRECTION_LINK_TYPES.has(
    clean(warning.warning_type).toUpperCase(),
  ) ? '#correctionCasesPanel' : null;

  return {
    warning_type: warning.warning_type ?? null,
    severity: warning.severity ?? 'warning',
    message: warning.message ?? null,
    entity,
    created_at: warning.created_at ?? null,
    resolved: warning.resolved ?? false,
    correction_link: correctionLink,
  };
}

module.exports = {
  buildOverviewData,
  buildMonitoringData,
  buildWarningDrilldown,
  queryOverviewMonitoringPg,
};
