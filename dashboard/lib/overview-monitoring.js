'use strict';

const PIPELINE_STALE_THRESHOLD_MINUTES = 24 * 60;

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
  const hasBackupOk = (raw.warnings || []).some((row) => clean(row.warning_type).toUpperCase() === 'BACKUP_OK');
  const stale = buildStaleInfo(raw);

  const postgresState = pgUnreachable > 0 ? 'red' : 'green';
  const n8nState = hasContainerDown(raw, 'n8n') ? 'red' : hasWorkflowError(raw) ? 'yellow' : 'green';
  const backupState = (backupStale > 0 || backupFail > 0) ? 'red' : hasBackupOk ? 'green' : 'yellow';
  const validationState = valDrift > 0 ? 'yellow' : 'green';
  const workflowsState = hasWorkflowError(raw) ? 'red' : 'green';
  const monitoringState = stale.isStale ? 'yellow' : 'green';

  return {
    stale,
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

function buildOverviewData(raw = {}) {
  const metrics = {
    openWarningsCount: toNum(raw.openWarningsCount),
    mhdRiskCount: toNum(raw.mhdRiskCount),
    lowStockCount: toNum(raw.lowStockCount),
    revenueNetToday: Math.round(toNum(raw.economicsToday?.revenueNet) * 100) / 100,
    dbNetToday: Math.round(toNum(raw.economicsToday?.dbNet) * 100) / 100,
    quantityToday: Math.round(toNum(raw.economicsToday?.quantity)),
  };

  const priorities = [];
  addPriority(
    priorities,
    'warnings-open',
    'critical',
    'Offene Warnungen',
    `${metrics.openWarningsCount} offene Warnung(en) erfordern Pruefung.`,
    metrics.openWarningsCount,
  );
  addPriority(
    priorities,
    'mhd-risk',
    'warning',
    'MHD-Risiko',
    `${metrics.mhdRiskCount} Produkt(e) mit MHD-Risiko gefunden.`,
    metrics.mhdRiskCount,
  );
  addPriority(
    priorities,
    'low-stock',
    'warning',
    'Niedriger Bestand',
    `${metrics.lowStockCount} Slot(s) unter Zielbestand.`,
    metrics.lowStockCount,
  );
  if (metrics.revenueNetToday > 0) {
    priorities.push({
      id: 'economics',
      severity: 'info',
      title: 'Wirtschaft heute',
      message: `${metrics.revenueNetToday.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR Umsatz netto, ${metrics.dbNetToday.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR DB.`,
      count: metrics.quantityToday,
    });
  }

  return {
    metrics,
    priorities,
  };
}

async function queryOverviewMonitoringPg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const [
      openWarningsResult,
      mhdRiskResult,
      lowStockResult,
      economicsResult,
      workflowRunsResult,
      warningsResult,
    ] = await Promise.all([
      client.query('SELECT COUNT(*)::int AS count FROM automatenlager.v_warnings_open'),
      client.query(
        `SELECT COUNT(*)::int AS count
           FROM automatenlager.stock_batches sb
          WHERE sb.status IN ('aktiv', 'active')
            AND sb.remaining_qty > 0
            AND sb.mhd_date IS NOT NULL
            AND sb.mhd_date <= CURRENT_DATE + INTERVAL '30 days'`,
      ),
      client.query(
        `SELECT COUNT(*)::int AS count
           FROM automatenlager.slot_assignments
          WHERE active = TRUE
            AND target_stock IS NOT NULL
            AND current_machine_qty < target_stock`,
      ),
      client.query(
        `SELECT COALESCE(SUM(revenue_net), 0)::numeric AS revenue_net,
                COALESCE(SUM(gross_profit), 0)::numeric AS db_net,
                COALESCE(SUM(quantity_sold), 0)::int AS quantity
           FROM automatenlager.guv_daily
          WHERE posting_date = (timezone('Europe/Berlin', now()))::date
            AND source != 'historic_backfill'`,
      ),
      client.query(
        `SELECT workflow_key, started_at, finished_at, status
           FROM audit.workflow_runs
          WHERE started_at >= now() - INTERVAL '3 days'
          ORDER BY started_at DESC
          LIMIT 80`,
      ),
      client.query(
        `SELECT warning_type, severity, resolved, created_at, warning_key, message
           FROM automatenlager.warnings
          WHERE created_at >= now() - INTERVAL '3 days'
          ORDER BY created_at DESC
          LIMIT 120`,
      ),
    ]);

    return {
      nowIso: new Date().toISOString(),
      openWarningsCount: toNum(openWarningsResult.rows?.[0]?.count),
      mhdRiskCount: toNum(mhdRiskResult.rows?.[0]?.count),
      lowStockCount: toNum(lowStockResult.rows?.[0]?.count),
      economicsToday: {
        revenueNet: toNum(economicsResult.rows?.[0]?.revenue_net),
        dbNet: toNum(economicsResult.rows?.[0]?.db_net),
        quantity: toNum(economicsResult.rows?.[0]?.quantity),
      },
      workflowRuns: workflowRunsResult.rows || [],
      warnings: warningsResult.rows || [],
    };
  } finally {
    await client.end();
  }
}

module.exports = {
  buildOverviewData,
  buildMonitoringData,
  queryOverviewMonitoringPg,
};
