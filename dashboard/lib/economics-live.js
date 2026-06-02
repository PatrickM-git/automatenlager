'use strict';

// Live-Umsatz (quasi-live) — schneller Lesepfad auf automatenlager.sales_transactions.
//
// Hintergrund: WF3 (Mini) schreibt Nayax-`lastSales` idempotent (UNIQUE auf
// nayax_transaction_id, ON CONFLICT DO NOTHING) nach sales_transactions. Wird WF3
// häufig getaktet, ist diese Tabelle quasi-live. Dieser Endpunkt liest sie nur —
// keine eigene Schreiblogik, keine Interferenz mit WF3/WF8/GuV.
//
// Bewusst getrennt von economics.js (GuV liest guv_daily, Monats-/Produktlogik);
// hier geht es nur um „Tagesumsatz heute" + „letzte Verkäufe". settlement_at trägt
// den Verkaufszeitstempel (Index idx_sales_settlement_at / _machine_settlement).

const { formatProductName, parseMachineFilter } = require('./economics.js');

const HISTORIC_SOURCE = 'historic_backfill';
const DEFAULT_RECENT_LIMIT = 15;
const MAX_RECENT_LIMIT = 100;

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampRecentLimit(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECENT_LIMIT;
  return Math.min(n, MAX_RECENT_LIMIT);
}

// Anzeigename: bevorzugt den Stammdatennamen (products.name, ggf. SKU→Klartext),
// sonst den rohen Nayax-Namen ohne das angehängte "(MDB = Preis)"-Suffix.
function displayName(productName, rawName) {
  if (productName) return formatProductName(productName);
  if (rawName == null) return null;
  return String(rawName).replace(/\s*\([^)]*\)\s*$/, '').trim() || String(rawName).trim();
}

// Reine Formung der Live-Antwort aus DB-Zeilen — ohne DB, damit testbar.
// todayRow: ein Aggregat-Objekt { verkaeufe, stueck, umsatz_brutto } (oder null).
// recentRows: jüngste Verkäufe (DESC) [{ nayax_transaction_id, settlement_at,
//   product_name, product_name_raw, quantity, gross_amount, machine_id }].
function shapeLiveData({ todayRow, recentRows = [] }) {
  const today = {
    verkaeufe: todayRow ? Math.round(toNum(todayRow.verkaeufe)) : 0,
    stueck: todayRow ? Math.round(toNum(todayRow.stueck)) : 0,
    umsatzBrutto: todayRow ? toNum(todayRow.umsatz_brutto) : 0,
  };

  const recent = recentRows.map((r) => ({
    txId: r.nayax_transaction_id != null ? String(r.nayax_transaction_id) : null,
    settlementAt: r.settlement_at instanceof Date ? r.settlement_at.toISOString() : (r.settlement_at || null),
    product: displayName(r.product_name, r.product_name_raw),
    quantity: Math.round(toNum(r.quantity)) || 1,
    grossAmount: toNum(r.gross_amount),
    machineId: r.machine_id != null ? String(r.machine_id) : null,
  }));

  // Zeitstempel des jüngsten Verkaufs — die Kachel zeigt damit „zuletzt aktualisiert".
  const lastSaleAt = recent.length ? recent[0].settlementAt : null;

  return { today, recent, lastSaleAt };
}

async function queryEconomicsLivePg(pgUrl, query = {}) {
  const { Client } = require('pg');
  const machines = parseMachineFilter(query.machines != null ? query.machines : query.machine);
  const recentLimit = clampRecentLimit(query.limit);

  // Optionaler Automaten-Filter als ANY(array); machine_id ist bigint → Cast auf text.
  const machineClause = machines.length ? 'AND s.machine_id::text = ANY($1::text[])' : '';
  const params = machines.length ? [machines] : [];
  const limitParam = '$' + (params.length + 1);
  params.push(recentLimit);

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const [todayRes, recentRes] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int                       AS verkaeufe,
                COALESCE(SUM(s.quantity), 0)::int    AS stueck,
                COALESCE(SUM(s.gross_amount), 0)     AS umsatz_brutto
           FROM automatenlager.sales_transactions s
          WHERE s.source <> '${HISTORIC_SOURCE}'
            AND (s.settlement_at AT TIME ZONE 'Europe/Berlin')::date
                = (now() AT TIME ZONE 'Europe/Berlin')::date
            ${machineClause}`,
        machines.length ? [machines] : [],
      ),
      client.query(
        `SELECT s.nayax_transaction_id,
                s.settlement_at,
                s.machine_id,
                s.quantity,
                s.gross_amount,
                s.product_name_raw,
                p.name AS product_name
           FROM automatenlager.sales_transactions s
           LEFT JOIN automatenlager.products p ON p.product_id = s.product_id
          WHERE s.source <> '${HISTORIC_SOURCE}'
            ${machineClause}
          ORDER BY s.settlement_at DESC NULLS LAST
          LIMIT ${limitParam}`,
        params,
      ),
    ]);

    return shapeLiveData({ todayRow: todayRes.rows[0], recentRows: recentRes.rows });
  } finally {
    await client.end();
  }
}

module.exports = {
  shapeLiveData,
  displayName,
  clampRecentLimit,
  queryEconomicsLivePg,
};
