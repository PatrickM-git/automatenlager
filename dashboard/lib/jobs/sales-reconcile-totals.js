'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: Täglicher Umsatz-Reconciliation-Alarm — Issue #229.
//
// Findet zwei Klassen von Lücken, bevor sie in GuV/Steuer wandern:
//   * Check A (Import-Vollständigkeit): Nayax/Moma-Tagessumme vs. sales_transactions.
//     (Hätte die 2,20-€-Lücke am 08.06. erkannt: Moma hatte Verkäufe, der Import nicht.)
//   * Check B (Buchungs-Vollständigkeit): sales_transactions-Tagessumme vs. guv_daily.
//     (Hätte den #228-Einfrier-Bug erkannt: GuV niedriger als die Rohverkäufe.)
//
// Aufbau wie nayax-sales/-reconcile: reine Logik (reconcileDailyTotals, getrennt
// testbar) von I/O (Mandanten-Tür + Nayax-Fetch + Mailer) getrennt.
//
// Hinweis Zeitzone: sales/guv werden in Europe/Berlin gruppiert; die Nayax-Tagessumme
// gruppiert nach dem Datum im Nayax-Zeitstempel (GMT). Tagesrand-Verkäufe können daher
// minimal in den Nachbartag fallen — die Schwelle (RECONCILE_THRESHOLD_EUR) absorbiert
// dieses Rauschen; gemeldet werden materielle Abweichungen.
// ─────────────────────────────────────────────────────────────────────────────

const { normalizeAuthValue, resolveNayaxTenant } = require('./nayax-devices-sync.js');
const { fetchNayaxLastSales, configFromEnv } = require('./nayax-sales.js');

const SALES_RECONCILE_TOTALS_JOB_KEY = 'sales-reconcile-totals';

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/**
 * REINER Vergleichskern. Bekommt drei {datum: betrag}-Karten, liefert je Tag die
 * Deltas + die Liste der Alarme (Abweichung > Schwelle).
 * @param {object} opts
 * @param {Object<string,number>} opts.salesByDay  gross je Tag aus sales_transactions
 * @param {Object<string,number>} opts.guvByDay    revenue_gross je Tag aus guv_daily
 * @param {Object<string,number>} opts.nayaxByDay  gross je Tag aus Nayax/Moma (ggf. nur Fenster)
 * @param {number} [opts.thresholdEur=0.01]        Toleranz (Rundung); > Schwelle ⇒ Alarm
 */
function reconcileDailyTotals({ salesByDay = {}, guvByDay = {}, nayaxByDay = {}, thresholdEur = 0.01 } = {}) {
  const allDates = [...new Set([
    ...Object.keys(salesByDay || {}), ...Object.keys(guvByDay || {}), ...Object.keys(nayaxByDay || {}),
  ])].sort();

  const days = [];
  const alerts = [];
  for (const date of allDates) {
    const hasNayax = Object.prototype.hasOwnProperty.call(nayaxByDay || {}, date);
    const nayax = hasNayax ? round2(nayaxByDay[date]) : null;
    const sales = round2(salesByDay[date] || 0);
    const guv = round2(guvByDay[date] || 0);

    const importDelta = hasNayax ? round2(nayax - sales) : null; // Moma > DB ⇒ Verkäufe fehlen im Import
    const bookingDelta = round2(sales - guv);                    // Verkauf > GuV ⇒ Buchung unvollständig

    const importFlag = importDelta != null && Math.abs(importDelta) > thresholdEur;
    const bookingFlag = Math.abs(bookingDelta) > thresholdEur;
    const flagged = importFlag || bookingFlag;

    days.push({ date, nayax, sales, guv, importDelta, bookingDelta, flagged });
    if (flagged) {
      alerts.push({
        date,
        importDelta: importFlag ? importDelta : null,
        bookingDelta: bookingFlag ? bookingDelta : null,
      });
    }
  }
  return { days, alerts };
}

/** Nayax-lastSales → {datum: brutto-summe}. SettlementValue je Verkauf, Datum aus dem Zeitstempel. */
function nayaxTotalsByDay(sales = []) {
  const byDay = {};
  for (const s of sales || []) {
    const dt = String(
      s.SettlementDateTime || s.MachineTime || s.AuthorizationDateTime ||
      s.settlement_datetime_gmt || s.TransactionDateTime || '',
    ).trim();
    const m = dt.match(/(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    const val = Number(s.SettlementValue != null ? s.SettlementValue : (s.Amount != null ? s.Amount : NaN));
    if (!Number.isFinite(val)) continue;
    byDay[m[1]] = round2((byDay[m[1]] || 0) + val);
  }
  return byDay;
}

/** Menschenlesbare Alarm-Mail (Text). */
function buildReconcileEmail(alerts = [], tenant = '') {
  const lines = (alerts || []).map((a) => {
    const parts = [];
    if (a.importDelta != null) parts.push(`Import fehlt ${Number(a.importDelta).toFixed(2)} EUR (Moma > DB)`);
    if (a.bookingDelta != null) parts.push(`Buchung fehlt ${Number(a.bookingDelta).toFixed(2)} EUR (Verkauf > GuV)`);
    return `- ${a.date}: ${parts.join('; ')}`;
  });
  return {
    subject: `Faltrix: Umsatz-Reconciliation — ${alerts.length} Tag(e) mit Abweichung`,
    text:
      `Der taegliche Abgleich (Moma <-> Verkaeufe <-> GuV) fuer Mandant ${tenant} meldet Abweichungen:\n\n` +
      `${lines.join('\n')}\n\n` +
      `Bitte die betroffenen Tage in Moma pruefen und fehlende Verkaeufe nachtragen.`,
  };
}

// ── I/O: Tagessummen durch die Mandanten-Tür (RLS-/$1-gefiltert) ──────────────
const SALES_BY_DAY_SQL = `
  SELECT (st.settlement_at AT TIME ZONE 'Europe/Berlin')::date::text AS d,
         ROUND(SUM(st.gross_amount), 2)::float8 AS total
    FROM automatenlager.sales_transactions st
   WHERE st.tenant_id = $1
     AND st.settlement_at > NOW() - make_interval(days => $2::int)
     AND (st.settlement_at AT TIME ZONE 'Europe/Berlin')::date < (NOW() AT TIME ZONE 'Europe/Berlin')::date
     AND COALESCE(st.processing_status,'OK') = 'OK'
   GROUP BY 1`;

const GUV_BY_DAY_SQL = `
  SELECT gd.posting_date::text AS d, ROUND(SUM(gd.revenue_gross), 2)::float8 AS total
    FROM automatenlager.guv_daily gd
   WHERE gd.tenant_id = $1 AND gd.source = 'wf8_guv_aggregator'
     AND gd.posting_date > (CURRENT_DATE - $2::int)
     AND gd.posting_date < (NOW() AT TIME ZONE 'Europe/Berlin')::date
   GROUP BY 1`;

function rowsToMap(rows) {
  const m = {};
  for (const r of rows || []) m[r.d] = Number(r.total) || 0;
  return m;
}

async function readDailyTotals(db, tenant, { days = 14 } = {}) {
  const salesRes = await db.read({ tenant, tables: ['sales_transactions'], text: SALES_BY_DAY_SQL, params: [days] });
  const guvRes = await db.read({ tenant, tables: ['guv_daily'], text: GUV_BY_DAY_SQL, params: [days] });
  return { salesByDay: rowsToMap(salesRes.rows), guvByDay: rowsToMap(guvRes.rows) };
}

/** Orchestrierung: DB-Tagessummen + Nayax-Tagessummen → Report. Schreibt nichts. */
async function runSalesReconcileTotals(db, tenant, { nayaxSales = [], thresholdEur = 0.05, days = 14 } = {}) {
  const { salesByDay, guvByDay } = await readDailyTotals(db, tenant, { days });
  const nayaxByDay = nayaxTotalsByDay(nayaxSales);
  return reconcileDailyTotals({ salesByDay, guvByDay, nayaxByDay, thresholdEur });
}

// ── Worker-Factory (#229) ────────────────────────────────────────────────────
function createSalesReconcileTotalsJob({ db, directory, env = process.env, fetchImpl, mailer } = {}) {
  if (!db) throw new TypeError('sales-reconcile-totals: db (Mandanten-Tür) erforderlich');
  return {
    key: SALES_RECONCILE_TOTALS_JOB_KEY,
    run: async () => {
      const tenant = resolveNayaxTenant(env, directory);
      if (!tenant) return { skipped: 'kein eindeutiger Nayax-Mandant (NAYAX_TENANT_ID setzen)' };

      // Nayax-Fetch ist OPTIONAL: ohne Token läuft Check B (Verkauf↔GuV) trotzdem.
      let nayaxSales = [];
      const token = normalizeAuthValue(env.NAYAX_API_TOKEN);
      if (token) {
        try {
          const config = configFromEnv(env);
          nayaxSales = await fetchNayaxLastSales({
            token,
            headerName: (env.NAYAX_HEADER_NAME && String(env.NAYAX_HEADER_NAME).trim()) || 'Authorization',
            baseUrl: config.nayax_base_url,
            machineId: config.machine_id,
            fetchImpl,
          });
        } catch (e) {
          console.warn('[sales-reconcile-totals] Nayax-Fetch fehlgeschlagen, nur Check B:', e && e.message);
        }
      }

      const thresholdEur = Number(env.RECONCILE_THRESHOLD_EUR) || 0.05;
      const days = Number(env.RECONCILE_WINDOW_DAYS) || 14;
      const report = await runSalesReconcileTotals(db, tenant, { nayaxSales, thresholdEur, days });

      if (report.alerts.length && mailer) {
        const to = env.ALERT_EMAIL_DEFAULT && String(env.ALERT_EMAIL_DEFAULT).trim();
        if (to) {
          const mail = buildReconcileEmail(report.alerts, tenant);
          try { await mailer.send({ to, subject: mail.subject, text: mail.text }); }
          catch (e) { console.warn('[sales-reconcile-totals] Mailer-Fehler:', e && e.message); }
        }
      }
      return { tenant, daysChecked: report.days.length, alerts: report.alerts.length, alertDates: report.alerts.map((a) => a.date) };
    },
  };
}

module.exports = {
  SALES_RECONCILE_TOTALS_JOB_KEY,
  reconcileDailyTotals,
  nayaxTotalsByDay,
  buildReconcileEmail,
  readDailyTotals,
  runSalesReconcileTotals,
  createSalesReconcileTotalsJob,
  round2,
};
