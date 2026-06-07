'use strict';

const { resolvePeriod, formatProductName } = require('./economics.js');
const { classifyTurnover } = require('./slow-mover.js');
const { buildEffectiveConfig, normalizeCategoryKey, loadEffectiveConfig, DEFAULT_MANDANT } = require('./category-config.js');
const { getThresholds } = require('./settings-thresholds.js');
const { availableBatchStatusSqlList } = require('./stock-status.js');

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function parseWarningTypes(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(',').map(clean).filter(Boolean);
}

function daysUntil(dateText) {
  const raw = clean(dateText);
  if (!raw) return null;
  const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((date.getTime() - today) / 86400000);
}

function indicator(code, label, source, evidence) {
  return {
    code,
    label,
    source,
    evidence,
    isRecommendation: false,
  };
}

// Indikatoren = transparente Zusatzhinweise (DB-stark, Marge schwach, MHD, …).
// Die EINZIGE Renner/Langsam-Definition liefert classifyTurnover (lib/slow-mover.js)
// über `turnover_class` — die frühere, hier hartcodierte Zweitdefinition
// (qty>=30 || turnover_count>=20 = „Renner") ist bewusst entfernt (Issue #65),
// damit derselbe Slot nie in zwei Ansichten unterschiedlich etikettiert wird.
function buildIndicators(slot, mhdRiskDays = 30) {
  const indicators = [];
  if (slot.db_net >= 20) {
    indicators.push(indicator('db_strong', 'DB-stark', 'kpi', `${slot.db_net.toLocaleString('de-DE')} EUR DB netto`));
  }
  if (slot.revenue_net > 0 && slot.margin_pct < 25) {
    indicators.push(indicator('margin_weak', 'Marge schwach', 'kpi', `${slot.margin_pct.toLocaleString('de-DE')} % Marge`));
  }
  if (slot.mhd_risk_qty > 0 || (slot.nearest_mhd_days != null && slot.nearest_mhd_days <= mhdRiskDays) || slot.warning_types.some((type) => type.startsWith('MHD'))) {
    indicators.push(indicator('mhd_risk', 'MHD-Risiko', 'stock', slot.nearest_mhd_date ? `naechstes MHD ${slot.nearest_mhd_date}` : 'offene MHD-Warnung'));
  }
  if (slot.value_per_product >= 75) {
    indicators.push(indicator('capital_tied', 'Kapitalbindung', 'stock', `${slot.value_per_product.toLocaleString('de-DE')} EUR Warenwert`));
  }
  if (slot.target_stock > 0 && slot.current_machine_qty < slot.target_stock) {
    indicators.push(indicator('refill_need', 'Nachfuellbedarf', 'stock', `${slot.current_machine_qty} / ${slot.target_stock} Zielbestand`));
  }
  return indicators;
}

function matchesFilters(slot, filters) {
  return (!filters.location || slot.location_id === filters.location || slot.location_name.toLowerCase().includes(filters.location.toLowerCase()))
    && (!filters.machine || slot.machine_id === filters.machine || slot.machine_name.toLowerCase().includes(filters.machine.toLowerCase()));
}

function parseDaysSinceLastSale(value) {
  // Wichtig: null bleibt null (= nie verkauft → Ladenhüter). toNum würde null
  // fälschlich zu 0 ("heute verkauft") machen und die Ladenhüter-Regel kippen.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseSlotRow(row, mhdRiskDays = 30) {
  const current = toNum(row.current_machine_qty);
  const target = toNum(row.target_stock);
  const capacity = toNum(row.machine_capacity);
  const revenue = Math.round(toNum(row.revenue_net) * 100) / 100;
  const db = Math.round(toNum(row.db_net) * 100) / 100;
  const slot = {
    slot_assignment_id: toNum(row.slot_assignment_id),
    location_id: clean(row.location_id),
    location_name: clean(row.location_name),
    machine_id: clean(row.machine_id),
    machine_ref: clean(row.machine_ref),
    machine_name: clean(row.machine_name),
    mdb_code: toNum(row.mdb_code),
    product_id: toNum(row.product_id),
    product_name: formatProductName(clean(row.product_name)) || String(row.product_id ?? ''),
    current_machine_qty: current,
    target_stock: target,
    machine_capacity: capacity,
    qty: toNum(row.qty),
    revenue_net: revenue,
    db_net: db,
    margin_pct: revenue > 0 ? round1((db / revenue) * 100) : 0,
    turnover_count: toNum(row.turnover_count),
    daysSinceLastSale: parseDaysSinceLastSale(row.days_since_last_sale),
    // Geldbasierte Drehgeschwindigkeits-Klassifikation (#64/#65):
    category: normalizeCategoryKey(row.category),                 // produktart (#62)
    db_window: parseDaysSinceLastSale(row.db_window),            // Deckungsbeitrag im 4-Wochen-Fenster
    listedDays: parseDaysSinceLastSale(row.listed_days),        // Tage seit Listung (Schonfrist)
    // EK fehlt: im Fenster verkauft, aber kein Wareneinsatz erfasst → keine Bewertung.
    ek_missing: toNum(row.window_qty) > 0 && toNum(row.cost_window) <= 0,
    value_per_product: Math.round(toNum(row.value_per_product) * 100) / 100,
    nearest_mhd_date: clean(row.nearest_mhd_date) || null,
    nearest_mhd_days: daysUntil(row.nearest_mhd_date),
    mhd_risk_qty: toNum(row.mhd_risk_qty),
    warning_types: parseWarningTypes(row.warning_types),
    occupancy: {
      current_machine_qty: current,
      target_stock: target,
      machine_capacity: capacity,
      fill_pct: capacity > 0 ? Math.round((current / capacity) * 100) : 0,
      label: `${current} / ${capacity || target || 0} im Slot`,
    },
  };
  slot.indicators = buildIndicators(slot, mhdRiskDays);
  return slot;
}

function buildAssortmentSlotsData(pgRows, query = {}) {
  const filters = {
    location: clean(query.location),
    machine: clean(query.machine),
  };
  // #34: MHD-Fenster aus der EINEN Settings-Quelle (auch für den Anzeige-Indikator).
  const cfg = pgRows.config || buildEffectiveConfig({});
  const parsed = (pgRows.slots || [])
    .map((row) => parseSlotRow(row, cfg.mhdRiskDays))
    .filter((slot) => matchesFilters(slot, filters))
    .sort((a, b) => a.location_name.localeCompare(b.location_name, 'de')
      || a.machine_name.localeCompare(b.machine_name, 'de')
      || a.mdb_code - b.mdb_code);

  // Geldbasierte Drehgeschwindigkeits-Klasse pro Slot/Automat (lib/slow-mover.js,
  // Issue #64): Deckungsbeitrag/Slot/Woche gegen die Kategorie-Latten der
  // effektiven Config (#63). Fällt die Config (Unit-Tests) weg, greifen die
  // Branchen-Anker-Defaults. Jeder Slot trägt danach `turnover_class`.
  const slots = classifyTurnover(parsed, cfg);

  return {
    slots,
    filters,
    // Lagerware ohne aktiven Slot (ausgetauscht/ausgelistet, noch Restbestand) —
    // unverändert durchgereicht für die "Im Lager"-Sektion im Slot-Editor.
    lagerOhneSlot: pgRows.lagerOhneSlot || [],
    recommendations: [],
    indicatorLegend: [
      { code: 'db_strong', label: 'DB-stark', source: 'kpi' },
      { code: 'margin_weak', label: 'Marge schwach', source: 'kpi' },
      { code: 'mhd_risk', label: 'MHD-Risiko', source: 'stock' },
      { code: 'capital_tied', label: 'Kapitalbindung', source: 'stock' },
      { code: 'refill_need', label: 'Nachfuellbedarf', source: 'stock' },
    ],
  };
}

// #125 (Stufe 3): mandantengetrennt durch die Mandanten-Tür. Mandant = $1 (Tür);
// Filter/Datumsgrenzen folgen ab $2. Config/Schwellwerte unter __default__ (Config ist
// in Stufe 3 nicht per-Mandant; per-Mandant-Config = Stufe 6). Kein Mandant ⇒ leer.
async function queryAssortmentSlotsPg(db, tenant, query = {}) {
  const locationFilter = clean(query.location);
  const machineFilter = clean(query.machine);
  const { from, to } = resolvePeriod(query);
  const dateFrom = `${from}-01`;
  const dateTo = `${to}-01`;

  // #34/#31: MHD-Fenster + Ladenhüter-Schwelle aus der Settings-Quelle (durch die Tür,
  // unter __default__ — Verhalten wie bisher). loadEffectiveConfig/getThresholds nehmen
  // die Tür (asDoor).
  let config = await loadEffectiveConfig(db, DEFAULT_MANDANT);
  const thresholds = await getThresholds(db, DEFAULT_MANDANT, null);
  if (thresholds.ladenhueterDays.source !== 'default') {
    config = { ...config, ladenhueterDays: Number(thresholds.ladenhueterDays.value) };
  }
  const mhdDays = config.mhdRiskDays;

  const result = await db.read({
    tenant,
    tables: ['slot_assignments', 'products', 'machines', 'locations', 'guv_daily',
      'v_slot_turnover', 'sales_transactions', 'stock_batches', 'v_inventory_value_daily', 'v_warnings_open'],
    text:
      `WITH sales AS (
         SELECT machine_id, mdb_code, product_id,
                SUM(quantity_sold)::int AS qty,
                SUM(revenue_net) AS revenue_net,
                SUM(gross_profit) AS db_net
           FROM automatenlager.guv_daily
          WHERE tenant_id = $1
            AND source != 'historic_backfill'
            AND date_trunc('month', posting_date) >= $4::date
            AND date_trunc('month', posting_date) <= $5::date
          GROUP BY machine_id, mdb_code, product_id
       ),
       turnover AS (
         SELECT machine_id, mdb_code, SUM(turnover_count)::int AS turnover_count
           FROM automatenlager.v_slot_turnover
          WHERE tenant_id = $1 AND month >= $4::date AND month <= $5::date
          GROUP BY machine_id, mdb_code
       ),
       money_window AS (
         -- Rollierendes 4-Wochen-Fenster (28 Tage) je Slot (#64).
         SELECT machine_id, mdb_code,
                SUM(gross_profit)  AS db_window,
                SUM(cost_of_goods) AS cost_window,
                SUM(quantity_sold)::int AS window_qty
           FROM automatenlager.guv_daily
          WHERE tenant_id = $1
            AND source != 'historic_backfill'
            AND posting_date >= CURRENT_DATE - INTERVAL '28 days'
          GROUP BY machine_id, mdb_code
       ),
       last_sale AS (
         SELECT st.machine_id, st.mdb_code, MAX(st.settlement_at) AS last_sale_at
           FROM automatenlager.sales_transactions st
          WHERE st.tenant_id = $1 AND st.source != 'historic_backfill'
          GROUP BY st.machine_id, st.mdb_code
       ),
       first_sale AS (
         SELECT st.product_id, MIN(st.settlement_at) AS first_sale_at
           FROM automatenlager.sales_transactions st
          WHERE st.tenant_id = $1 AND st.source != 'historic_backfill'
          GROUP BY st.product_id
       ),
       batch_status AS (
         SELECT product_id,
                MIN(mhd_date) FILTER (WHERE mhd_date IS NOT NULL AND status NOT IN ('depleted', 'expired')) AS nearest_mhd_date,
                SUM(remaining_qty) FILTER (WHERE mhd_date <= CURRENT_DATE + INTERVAL '${mhdDays} days' AND status NOT IN ('depleted', 'expired'))::int AS mhd_risk_qty
           FROM automatenlager.stock_batches
          WHERE tenant_id = $1
          GROUP BY product_id
       ),
       warning_status AS (
         SELECT product_id, slot_assignment_id,
                ARRAY_AGG(DISTINCT warning_type) FILTER (WHERE warning_type IS NOT NULL) AS warning_types
           FROM automatenlager.v_warnings_open
          WHERE tenant_id = $1
          GROUP BY product_id, slot_assignment_id
       )
       SELECT sa.slot_assignment_id,
              l.location_key AS location_id,
              l.name AS location_name,
              m.machine_key AS machine_id,
              sa.machine_id::text AS machine_ref,
              m.name AS machine_name,
              sa.mdb_code,
              p.product_id,
              p.name AS product_name,
              p.category AS category,
              sa.current_machine_qty,
              sa.target_stock,
              sa.machine_capacity,
              COALESCE(s.qty, 0) AS qty,
              COALESCE(s.revenue_net, 0) AS revenue_net,
              COALESCE(s.db_net, 0) AS db_net,
              COALESCE(t.turnover_count, 0) AS turnover_count,
              COALESCE(mw.db_window, 0) AS db_window,
              COALESCE(mw.cost_window, 0) AS cost_window,
              COALESCE(mw.window_qty, 0) AS window_qty,
              COALESCE(
                (CURRENT_DATE - (fs.first_sale_at AT TIME ZONE 'Europe/Berlin')::date),
                (CURRENT_DATE - (sa.valid_from AT TIME ZONE 'Europe/Berlin')::date)
              ) AS listed_days,
              (CURRENT_DATE - (ls.last_sale_at AT TIME ZONE 'Europe/Berlin')::date) AS days_since_last_sale,
              COALESCE(iv.value_per_product, 0) AS value_per_product,
              bs.nearest_mhd_date,
              COALESCE(bs.mhd_risk_qty, 0) AS mhd_risk_qty,
              COALESCE(ws.warning_types, ARRAY[]::text[]) AS warning_types
         FROM automatenlager.slot_assignments sa
         JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
         JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
         JOIN automatenlager.locations l ON l.location_id = m.location_id AND l.tenant_id = m.tenant_id
         LEFT JOIN sales s
           ON s.machine_id = sa.machine_id AND s.mdb_code = sa.mdb_code AND s.product_id = sa.product_id
         LEFT JOIN turnover t
           ON t.machine_id = sa.machine_id AND t.mdb_code = sa.mdb_code
         LEFT JOIN money_window mw
           ON mw.machine_id = sa.machine_id AND mw.mdb_code = sa.mdb_code
         LEFT JOIN last_sale ls
           ON ls.machine_id = sa.machine_id AND ls.mdb_code = sa.mdb_code
         LEFT JOIN first_sale fs
           ON fs.product_id = sa.product_id
         LEFT JOIN automatenlager.v_inventory_value_daily iv ON iv.product_id = sa.product_id AND iv.tenant_id = sa.tenant_id
         LEFT JOIN batch_status bs ON bs.product_id = sa.product_id
         LEFT JOIN warning_status ws
           ON ws.product_id = sa.product_id
          AND (ws.slot_assignment_id = sa.slot_assignment_id OR ws.slot_assignment_id IS NULL)
        WHERE sa.active = TRUE
          AND sa.tenant_id = $1
          AND ($2 = '' OR l.location_key = $2 OR l.name ILIKE '%' || $2 || '%')
          AND ($3 = '' OR m.machine_key = $3 OR m.name ILIKE '%' || $3 || '%')
        ORDER BY l.name, m.name, sa.mdb_code`,
    params: [locationFilter, machineFilter, dateFrom, dateTo],
  });

  // Lagerware OHNE aktiven Slot (mandanten-gefiltert).
  const lagerOhneSlotResult = await db.read({
    tenant,
    tables: ['stock_batches', 'products', 'slot_assignments'],
    text:
      `SELECT sb.batch_key, p.name AS product_name, sb.remaining_qty, sb.mhd_date::text AS mhd_date
         FROM automatenlager.stock_batches sb
         JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
        WHERE sb.tenant_id = $1
          AND sb.status IN (${availableBatchStatusSqlList()})
          AND sb.remaining_qty > 0
          AND NOT EXISTS (
            SELECT 1 FROM automatenlager.slot_assignments sa
             WHERE sa.product_id = p.product_id AND sa.active = TRUE AND sa.tenant_id = sb.tenant_id
          )
        ORDER BY p.name, sb.batch_key`,
    params: [],
  });

  return { slots: result.rows, config, lagerOhneSlot: lagerOhneSlotResult.rows };
}

module.exports = { buildAssortmentSlotsData, queryAssortmentSlotsPg };
