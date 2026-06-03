'use strict';

const VALID_SORT_FIELDS = new Set(['revenue_net', 'db_net', 'margin_pct', 'qty', 'revenue_gross', 'gross_profit', 'margin_gross_pct']);

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function marginPct(db, revenue) {
  return revenue > 0 ? round1((db / revenue) * 100) : 0;
}

function isBackfill(row) {
  return row.source === 'historic_backfill';
}

function formatProductName(name) {
  if (name == null) return null;
  if (/^SKU_[A-Z0-9_]+$/.test(name)) {
    return name
      .replace(/^SKU_/, '')
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return name;
}

function currentBerlinMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date()).slice(0, 7);
}

function currentBerlinDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Robuster Monatsschlüssel 'YYYY-MM'. PostgreSQL liefert date_trunc('month')::DATE
// als Berlin-Mitternacht, das JSON-serialisiert als UTC-Vortag erscheint
// (z. B. '2026-04-30T22:00:00.000Z' = Mai). Reine 'YYYY-MM[-DD]'-Strings ohne
// Zeitanteil werden direkt zugeschnitten; alles mit Zeit wird in Europe/Berlin
// interpretiert, damit der fachliche Monat stimmt.
function monthKeyBerlin(value) {
  if (value == null) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value) && value.indexOf('T') === -1) {
    return value.slice(0, 7);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).format(d).slice(0, 7);
}

// Robuster Tagesschlüssel 'YYYY-MM-DD' – analog zu monthKeyBerlin, aber
// tagesgenau. PostgreSQL liefert date_trunc('day',…)::DATE; reine
// 'YYYY-MM-DD'-Strings werden direkt zugeschnitten, alles mit Zeitanteil in
// Europe/Berlin interpretiert, damit der fachliche Tag stimmt.
function dayKeyBerlin(value) {
  if (value == null) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && value.indexOf('T') === -1) {
    return value.slice(0, 10);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d).slice(0, 10);
}

// Normalisiert den Standort-/Automaten-Filter zu einer deduplizierten Liste
// von machine_id-Strings. Akzeptiert Array oder kommaseparierten String
// (z. B. aus dem Query-Parameter ?machines=VM01,VM02).
function parseMachineFilter(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = String(v == null ? '' : v).trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

const VALID_MONTH_RE = /^\d{4}-\d{2}$/;
const VALID_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fmtUtcDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Letzter Kalendertag eines 'YYYY-MM'-Monats als 'YYYY-MM-DD'.
function monthEndDate(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // Tag 0 des Folgemonats = letzter Tag
  return fmtUtcDate(last);
}

// Anzahl Kalendertage zwischen zwei 'YYYY-MM-DD' (inklusive beider Ränder).
function dayCount(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

// Montag (Wochenstart) der ISO-Kalenderwoche als Date (UTC). KW 1 enthält den
// 4. Januar (ISO-8601-Definition). Wochen beginnen montags.
function isoWeekStart(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7; // Mo=0 … So=6
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - dow);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

// Wie viele ISO-Wochen hat ein Jahr (52 oder 53)?
function isoWeeksInYear(year) {
  const jan1Dow = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return (jan1Dow === 4 || (isLeap && jan1Dow === 3)) ? 53 : 52;
}

function resolvePeriod(query = {}) {
  const current = currentBerlinMonth();
  const validMonth = /^\d{4}-\d{2}$/;
  const year = parseInt(query.year, 10);

  if (query.mode === 'quarter' && Number.isInteger(year)) {
    const q = parseInt(query.quarter, 10);
    if (q >= 1 && q <= 4) {
      const startMonth = (q - 1) * 3 + 1;
      return { from: `${year}-${pad2(startMonth)}`, to: `${year}-${pad2(startMonth + 2)}` };
    }
  }

  if (query.mode === 'year' && Number.isInteger(year)) {
    return { from: `${year}-01`, to: `${year}-12` };
  }

  const from = validMonth.test(query.from || '') ? query.from : current;
  const to = validMonth.test(query.to || '') ? query.to : current;
  return { from, to };
}

function parseProductRow(row) {
  const revenue = round2(toNum(row.revenue_net));
  const db = round2(toNum(row.db_net));
  const revenueGross = round2(toNum(row.revenue_gross));
  const dbGross = round2(toNum(row.gross_profit));
  return {
    product_id: toNum(row.product_id),
    product_name: formatProductName(row.product_name) ?? String(toNum(row.product_id)),
    month: row.month,
    revenue_net: revenue,
    db_net: db,
    revenue_gross: revenueGross,
    gross_profit: dbGross,
    qty: toNum(row.qty),
    margin_pct: marginPct(db, revenue),
    margin_gross_pct: marginPct(dbGross, revenueGross),
  };
}

function parseSlotRow(row) {
  return {
    machine_id: String(row.machine_id),
    mdb_code: toNum(row.mdb_code),
    month: row.month,
    revenue_net: round2(toNum(row.revenue_net)),
    db_net: round2(toNum(row.db_net)),
    revenue_gross: round2(toNum(row.revenue_gross)),
    gross_profit: round2(toNum(row.gross_profit)),
    qty: toNum(row.qty),
  };
}

function parseInventoryRow(row) {
  return {
    product_id: toNum(row.product_id),
    value_per_product: round2(toNum(row.value_per_product)),
    total_value: round2(toNum(row.total_value)),
  };
}

function sortRows(rows, sortBy, sortOrder) {
  const field = VALID_SORT_FIELDS.has(sortBy) ? sortBy : 'revenue_net';
  const dir = sortOrder === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[field] ?? 0;
    const bv = b[field] ?? 0;
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
}

const VALID_MODES = new Set(['month', 'quarter', 'year', 'week', 'custom']);

// Verdichtet die (bereits geparsten) Produktzeilen zu einer Monats-Zeitreihe
// für die Diagramme – aufsteigend nach Monat, je Monat brutto/netto + Marge.
function buildSeries(productRows) {
  const byMonth = new Map();
  for (const r of productRows) {
    const month = monthKeyBerlin(r.month);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const acc = byMonth.get(month) ||
      { month, revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 };
    acc.revenue_net += r.revenue_net;
    acc.db_net += r.db_net;
    acc.revenue_gross += r.revenue_gross;
    acc.gross_profit += r.gross_profit;
    acc.qty += r.qty;
    byMonth.set(month, acc);
  }
  return [...byMonth.values()]
    .map((m) => ({
      month: m.month,
      revenue_net: round2(m.revenue_net),
      db_net: round2(m.db_net),
      revenue_gross: round2(m.revenue_gross),
      gross_profit: round2(m.gross_profit),
      qty: m.qty,
      margin_pct: marginPct(m.db_net, m.revenue_net),
      margin_gross_pct: marginPct(m.gross_profit, m.revenue_gross),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

// Verdichtet bereits gruppierte DB-Bucket-Zeilen (eine Zeile je Tag bzw. Monat,
// nicht je Produkt) zur Diagramm-Zeitreihe. Granularität 'day' nutzt den
// Tagesschlüssel, 'month' den Monatsschlüssel. Das Feld heißt weiterhin `month`
// (= Bucket-Schlüssel), damit der Chart-Code unverändert darauf zeichnet.
function buildSeriesFromBuckets(rows, granularity = 'month') {
  const isDay = granularity === 'day';
  const keyOf = isDay ? dayKeyBerlin : monthKeyBerlin;
  const valid = isDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
  const byBucket = new Map();
  for (const r of rows || []) {
    const key = keyOf(r.bucket != null ? r.bucket : r.month);
    if (!valid.test(key)) continue;
    const acc = byBucket.get(key) ||
      { month: key, revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 };
    acc.revenue_net += toNum(r.revenue_net);
    acc.db_net += toNum(r.db_net);
    acc.revenue_gross += toNum(r.revenue_gross);
    acc.gross_profit += toNum(r.gross_profit);
    acc.qty += toNum(r.qty);
    byBucket.set(key, acc);
  }
  return [...byBucket.values()]
    .map((m) => ({
      month: m.month,
      revenue_net: round2(m.revenue_net),
      db_net: round2(m.db_net),
      revenue_gross: round2(m.revenue_gross),
      gross_profit: round2(m.gross_profit),
      qty: m.qty,
      margin_pct: marginPct(m.db_net, m.revenue_net),
      margin_gross_pct: marginPct(m.gross_profit, m.revenue_gross),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

// Löst die Periode taggenau auf ('YYYY-MM-DD' from/to + Granularität für die
// Zeitreihe). Monat/Quartal/Jahr leiten sich aus resolvePeriod (Monatslogik) ab;
// Woche (ISO-KW) und ein taggenauer eigener Zeitraum liefern echte Tagesgrenzen.
//   - granularity 'day'  → Tagesverlauf (Einzelmonat, Woche, kurzer Custom ≤45 T.)
//   - granularity 'month'→ Monatsverlauf (längere Zeiträume)
function resolveDateRange(query = {}) {
  const mode = VALID_MODES.has(query.mode) ? query.mode : 'month';

  if (mode === 'week') {
    const year = parseInt(query.year, 10);
    const week = parseInt(query.week, 10);
    if (Number.isInteger(year) && week >= 1 && week <= 53) {
      const monday = isoWeekStart(year, week);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      return { fromDate: fmtUtcDate(monday), toDate: fmtUtcDate(sunday), granularity: 'day', mode };
    }
  }

  if (mode === 'custom') {
    const f = String(query.from || '');
    const t = String(query.to || '');
    if (VALID_DAY_RE.test(f) && VALID_DAY_RE.test(t)) {
      const [lo, hi] = f <= t ? [f, t] : [t, f];
      return { fromDate: lo, toDate: hi, granularity: dayCount(lo, hi) <= 45 ? 'day' : 'month', mode };
    }
  }

  // Monat / Quartal / Jahr (und Alt-Custom in 'YYYY-MM'): Monatsgrenzen.
  const { from, to } = resolvePeriod(query);
  return { fromDate: `${from}-01`, toDate: monthEndDate(to), granularity: from === to ? 'day' : 'month', mode };
}

// Hat der Resolver für diese Query echte Tagesgrenzen geliefert (Woche / Custom
// taggenau)? Dann ist `period` tagesgenau statt monatsgenau.
function isDayPreciseQuery(query = {}) {
  const mode = VALID_MODES.has(query.mode) ? query.mode : 'month';
  if (mode === 'week') {
    const year = parseInt(query.year, 10);
    const week = parseInt(query.week, 10);
    return Number.isInteger(year) && week >= 1 && week <= 53;
  }
  if (mode === 'custom') {
    return VALID_DAY_RE.test(String(query.from || '')) && VALID_DAY_RE.test(String(query.to || ''));
  }
  return false;
}

// Sequenzielle FIFO-Bewertung der vorläufigen (heutigen) Verkäufe EINES Produkts.
// `batches` sind ALLE Chargen des Produkts; soldQty die noch nicht aggregierte
// Verkaufsmenge. Idee: WF3 bucht beim Verkauf bereits FIFO von der ältesten
// Charge ab (remaining_qty sinkt). Die zuletzt verbrauchten `soldQty` Einheiten
// sind damit das Ende der FIFO-Verbrauchskette — also der bereits verbrauchte
// Teil der „Frontier"-Charge (älteste mit Restbestand) und davor die komplett
// geleerten älteren Chargen. Genau das verrechnet WF8 nachts; hier wird es für
// heute live nachgebildet. unit_cost_net = EK-Basis von guv_daily.cost_of_goods
// (empirisch bestätigt: cost_of_goods = Menge × unit_cost_net).
function fifoProvisionalCostForProduct(batches, soldQty, fallbackUnitCost) {
  const qty = Math.max(0, Math.round(toNum(soldQty)));
  if (qty === 0) return { cost: 0, allocated: 0, complete: true, estimated: false };
  const fb = toNum(fallbackUnitCost);
  const ordered = [...(batches || [])].sort((a, b) => {
    const ra = String(a.received_at || ''), rb = String(b.received_at || '');
    if (ra !== rb) return ra < rb ? -1 : 1;
    return toNum(a.batch_id) - toNum(b.batch_id);
  });
  let remaining = qty;
  let cost = 0;
  let estimated = false;
  for (let i = ordered.length - 1; i >= 0 && remaining > 0; i--) {
    const consumed = Math.max(0, toNum(ordered[i].initial_qty) - toNum(ordered[i].remaining_qty));
    if (consumed <= 0) continue;
    const take = Math.min(remaining, consumed);
    // Fehlt der EK einer Charge (unit_cost_net = 0), greift der letzte bekannte
    // EK des Produkts (Schätzung) statt einer falschen 100-%-Marge.
    let unit = toNum(ordered[i].unit_cost_net);
    if (unit <= 0) { unit = fb; if (fb > 0) estimated = true; }
    cost += take * unit;
    remaining -= take;
  }
  return { cost: round2(cost), allocated: qty - remaining, complete: remaining === 0, estimated };
}

// Letzter bekannter Einkaufspreis (netto) eines Produkts als Fallback, wenn die
// FIFO-getroffene Charge keinen EK trägt: jüngste Charge mit unit_cost_net > 0.
function latestKnownUnitCost(batches) {
  let best = null;
  for (const b of batches || []) {
    if (toNum(b.unit_cost_net) > 0) {
      const key = String(b.received_at || '');
      if (!best || key > best.key || (key === best.key && toNum(b.batch_id) > best.id)) {
        best = { key, id: toNum(b.batch_id), cost: toNum(b.unit_cost_net) };
      }
    }
  }
  return best ? best.cost : 0;
}

// #40 / Live-FIFO: Vorläufige Position für den noch nicht von WF8 aggregierten
// Zeitraum (heute / seit dem letzten guv_daily-Lauf), aus sales_transactions.
// Trägt jetzt zusätzlich den sequenziell FIFO-bewerteten Wareneinsatz (`cost`)
// und damit Gewinn/Marge — sofern der EK vollständig zugeordnet werden konnte
// (`hasCost`). Ohne EK fällt es auf das alte Verhalten zurück (nur Umsatz/Menge).
function buildProvisional(row) {
  const revenueGross = round2(toNum(row && row.revenue_gross));
  const revenueNet = round2(toNum(row && row.revenue_net));
  const qty = Math.round(toNum(row && row.qty));
  const hasCost = !!(row && row.cost != null);
  const cost = hasCost ? round2(toNum(row.cost)) : 0;
  const grossProfit = hasCost ? round2(revenueGross - cost) : 0;
  const byProduct = Array.isArray(row && row.byProduct)
    ? row.byProduct.map((p) => ({
        product_id: toNum(p.product_id),
        product_name: p.product_name != null ? p.product_name : null,
        qty: Math.round(toNum(p.qty)),
        revenue_gross: round2(toNum(p.revenue_gross)),
        revenue_net: round2(toNum(p.revenue_net)),
        cost: round2(toNum(p.cost)),
      }))
    : [];
  return {
    hasProvisional: revenueGross > 0 || qty > 0,
    revenueGross,
    revenueNet,
    qty,
    cost,
    grossProfit,
    hasCost,
    costComplete: row ? row.costComplete !== false : true,
    byProduct,
    fromDate: row && row.from_date ? String(row.from_date) : null,
    toDate: row && row.to_date ? String(row.to_date) : null,
  };
}

// Mischt die vorläufigen (heutigen) Produktposten in die endgültigen guv_daily-
// Produktzeilen, damit die Top-Produkt-Tabelle konsistent zu den KPIs „inkl.
// heute" ist. Nur wenn der EK live zugeordnet werden konnte (sonst würde die
// Marge je Produkt still verfälscht).
function mergeProvisionalProducts(finalRows, provisional) {
  if (!provisional.hasProvisional || !provisional.hasCost || !provisional.byProduct.length) {
    return finalRows;
  }
  const byId = new Map(finalRows.map((r) => [r.product_id, { ...r }]));
  for (const pr of provisional.byProduct) {
    const gp = round2(pr.revenue_gross - pr.cost);
    const dbNet = round2(pr.revenue_net - pr.cost);
    const ex = byId.get(pr.product_id);
    if (ex) {
      ex.revenue_gross = round2(ex.revenue_gross + pr.revenue_gross);
      ex.revenue_net = round2(ex.revenue_net + pr.revenue_net);
      ex.gross_profit = round2(ex.gross_profit + gp);
      ex.db_net = round2(ex.db_net + dbNet);
      ex.qty += pr.qty;
      ex.margin_pct = marginPct(ex.db_net, ex.revenue_net);
      ex.margin_gross_pct = marginPct(ex.gross_profit, ex.revenue_gross);
    } else {
      byId.set(pr.product_id, {
        product_id: pr.product_id,
        product_name: formatProductName(pr.product_name) ?? String(pr.product_id),
        month: provisional.toDate,
        revenue_net: pr.revenue_net,
        db_net: dbNet,
        revenue_gross: pr.revenue_gross,
        gross_profit: gp,
        qty: pr.qty,
        margin_pct: marginPct(dbNet, pr.revenue_net),
        margin_gross_pct: marginPct(gp, pr.revenue_gross),
      });
    }
  }
  return [...byId.values()];
}

// Hängt den vorläufigen (heutigen) Tag als Punkt an die Tages-Zeitreihe. Liegt
// für denselben Tag schon ein guv_daily-Bucket vor (Normalfall: nicht, da
// provisional nach dem letzten Aggregat-Tag beginnt), werden die Werte addiert.
function appendProvisionalToSeries(series, provisional) {
  const key = provisional.toDate;
  const out = series.map((b) => ({ ...b }));
  let bucket = out.find((b) => b.month === key);
  if (!bucket) {
    bucket = { month: key, revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 };
    out.push(bucket);
  }
  bucket.revenue_net = round2(bucket.revenue_net + provisional.revenueNet);
  bucket.revenue_gross = round2(bucket.revenue_gross + provisional.revenueGross);
  bucket.gross_profit = round2(bucket.gross_profit + provisional.grossProfit);
  bucket.db_net = round2(bucket.db_net + (provisional.revenueNet - provisional.cost));
  bucket.qty += provisional.qty;
  bucket.margin_pct = marginPct(bucket.db_net, bucket.revenue_net);
  bucket.margin_gross_pct = marginPct(bucket.gross_profit, bucket.revenue_gross);
  return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

function buildEconomicsData(pgRows, query = {}) {
  const sortBy = query.sort || 'revenue_net';
  const sortOrder = query.order === 'asc' ? 'asc' : 'desc';
  const machineFilter = parseMachineFilter(query.machines != null ? query.machines : query.machine);
  const mode = VALID_MODES.has(query.mode) ? query.mode : 'month';
  const period = resolvePeriod(query);

  const finalProducts = (pgRows.byProduct || []).filter((r) => !isBackfill(r)).map(parseProductRow);

  const bySlot = sortRows(
    (pgRows.bySlot || []).filter((r) => !isBackfill(r)).map(parseSlotRow),
    sortBy,
    sortOrder,
  );

  const inventoryValue = (pgRows.inventoryValue || []).map(parseInventoryRow);

  // Endgültige (guv_daily-)Totale — bleiben die reine Nacht-Aggregation, damit
  // `totals` als belastbare Basis erhalten bleibt (Tests/PDF-Report).
  const totals = finalProducts.reduce(
    (acc, r) => ({
      revenue_net: round2(acc.revenue_net + r.revenue_net),
      db_net: round2(acc.db_net + r.db_net),
      revenue_gross: round2(acc.revenue_gross + r.revenue_gross),
      gross_profit: round2(acc.gross_profit + r.gross_profit),
      qty: acc.qty + r.qty,
    }),
    { revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 },
  );

  const provisional = buildProvisional(pgRows.provisional);

  // Top-Produkt-Tabelle: vorläufige Posten einmischen (nur mit Live-EK), sonst
  // bliebe die Tabelle hinter den „inkl. heute"-KPIs zurück.
  const byProduct = sortRows(mergeProvisionalProducts(finalProducts, provisional), sortBy, sortOrder);

  // Bevorzugt die granularitäts-genaue Bucket-Serie aus der DB (Tag im
  // Monatsmodus, sonst Monat). Fehlt sie (z. B. in reinen Unit-Tests), fällt
  // die Logik auf die aus byProduct abgeleitete Monatsserie zurück – damit
  // bleibt das bisherige Verhalten exakt erhalten.
  let series;
  let granularity;
  if (Array.isArray(pgRows.series)) {
    granularity = pgRows.granularity === 'day' ? 'day' : 'month';
    series = buildSeriesFromBuckets(pgRows.series, granularity);
  } else {
    granularity = 'month';
    series = buildSeries(finalProducts);
  }
  // Vorläufigen (heutigen) Tag als jüngsten Punkt in den Tagesverlauf hängen,
  // damit die Diagramme zur „inkl. heute"-KPI passen. Nur mit Live-EK und nur
  // im Tagesmodus (im Monatsverlauf bliebe es ein irreführender Mini-Balken).
  if (granularity === 'day' && provisional.hasProvisional && provisional.hasCost && provisional.toDate) {
    series = appendProvisionalToSeries(series, provisional);
  }

  // Headline inkl. laufendem Tag — Umsatz/Menge wie bisher (#38), zusätzlich
  // jetzt GuV/Wareneinsatz via Live-FIFO (wenn EK zugeordnet werden konnte).
  const totalsWithProvisional = {
    revenue_gross: round2(totals.revenue_gross + provisional.revenueGross),
    revenue_net: round2(totals.revenue_net + provisional.revenueNet),
    qty: totals.qty + provisional.qty,
    gross_profit: round2(totals.gross_profit + provisional.grossProfit),
    cost_of_goods: round2((totals.revenue_gross - totals.gross_profit) + provisional.cost),
  };

  // Periode tagesgenau spiegeln, wenn der Resolver echte Tagesgrenzen lieferte.
  if (isDayPreciseQuery(query)) {
    const range = resolveDateRange(query);
    period.from = range.fromDate;
    period.to = range.toDate;
  }

  return {
    byProduct,
    bySlot,
    inventoryValue,
    totals,
    totalsWithProvisional,
    provisional,
    series,
    granularity,
    period,
    mode,
    sortBy,
    sortOrder,
    machineFilter,
  };
}

async function queryEconomicsPg(pgUrl, query = {}) {
  const { Client } = require('pg');
  const machines = parseMachineFilter(query.machines != null ? query.machines : query.machine);
  // Taggenaue Grenzen (Monat/Quartal/Jahr → Monatsränder, Woche/Custom → Tage).
  const { fromDate, toDate, granularity } = resolveDateRange(query);

  // Optionaler Standort-/Automaten-Filter als ANY(array). $3 nur belegen, wenn
  // gefiltert wird; sonst fällt die Klausel weg und alle Automaten zählen.
  // machine_id ist in der DB ein bigint – Cast auf text macht den Vergleich
  // unabhängig vom Spaltentyp (Scope liefert die IDs als String).
  const machineClause = machines.length ? 'AND g.machine_id::text = ANY($3::text[])' : '';
  const params = machines.length ? [fromDate, toDate, machines] : [fromDate, toDate];

  // posting_date direkt vergleichen (tagesgenau, inklusive beider Ränder).
  const periodWhere = `
            WHERE g.source != 'historic_backfill'
              AND g.posting_date >= $1::date
              AND g.posting_date <= $2::date
              ${machineClause}`;

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const [pr, sr, ser] = await Promise.all([
      client.query(
        `SELECT g.product_id,
                p.name                                     AS product_name,
                date_trunc('month', g.posting_date)::DATE  AS month,
                SUM(g.quantity_sold)::int                  AS qty,
                SUM(g.revenue_net)                         AS revenue_net,
                SUM(g.revenue_gross)                       AS revenue_gross,
                SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
                SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
           FROM automatenlager.guv_daily g
           LEFT JOIN automatenlager.products p ON p.product_id = g.product_id
          ${periodWhere}
          GROUP BY g.product_id, p.name, date_trunc('month', g.posting_date)::DATE`,
        params,
      ),
      client.query(
        `SELECT g.machine_id,
                g.mdb_code,
                date_trunc('month', g.posting_date)::DATE  AS month,
                SUM(g.quantity_sold)::int                  AS qty,
                SUM(g.revenue_net)                         AS revenue_net,
                SUM(g.revenue_gross)                       AS revenue_gross,
                SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
                SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
           FROM automatenlager.guv_daily g
          ${periodWhere}
          GROUP BY g.machine_id, g.mdb_code, date_trunc('month', g.posting_date)::DATE`,
        params,
      ),
      client.query(
        `SELECT date_trunc('${granularity}', g.posting_date)::DATE  AS bucket,
                SUM(g.quantity_sold)::int                  AS qty,
                SUM(g.revenue_net)                         AS revenue_net,
                SUM(g.revenue_gross)                       AS revenue_gross,
                SUM(g.revenue_gross - g.cost_of_goods)     AS gross_profit,
                SUM(g.revenue_net - g.cost_of_goods * g.revenue_net / NULLIF(g.revenue_gross, 0)) AS db_net
           FROM automatenlager.guv_daily g
          ${periodWhere}
          GROUP BY date_trunc('${granularity}', g.posting_date)::DATE
          ORDER BY 1`,
        params,
      ),
    ]);

    const inventoryResult = await client.query(
      `SELECT * FROM automatenlager.mv_inventory_value_daily`,
    );

    return {
      byProduct: pr.rows,
      bySlot: sr.rows,
      series: ser.rows,
      granularity,
      inventoryValue: inventoryResult.rows,
    };
  } finally {
    await client.end();
  }
}

// #40 / Live-FIFO: Vorläufige (noch nicht von WF8 aggregierte) Verkäufe.
// Liefert Umsatz/Menge + sequenziell FIFO-bewerteten Wareneinsatz (`cost`) je
// Produkt für sales_transactions, die NACH dem letzten guv_daily-Tag (im Scope)
// und bis heute liegen — keine Doppelzählung mit dem Aggregat. Nur relevant,
// wenn der gewählte Zeitraum den heutigen Tag einschließt; sonst null
// (Vergangenheit ist vollständig in guv_daily).
async function queryEconomicsProvisionalPg(pgUrl, query = {}) {
  const { fromDate, toDate } = resolveDateRange(query);
  const today = currentBerlinDay();
  if (toDate < today || fromDate > today) return null; // kein Schnitt mit „heute"
  const upperBound = today; // bis einschließlich heute (toDate liegt >= heute)

  const { Client } = require('pg');
  const machines = parseMachineFilter(query.machines != null ? query.machines : query.machine);
  const machineArr = machines.length ? machines : null;

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    // Letzter bereits aggregierter Tag im Zeitraum/Scope (Berlin). Fehlt er,
    // gilt der Tag vor Periodenbeginn -> die ganze Periode ist „vorläufig".
    const covParams = machineArr ? [fromDate, machineArr] : [fromDate];
    const covRes = await client.query(
      `SELECT MAX(g.posting_date)::date AS latest
         FROM automatenlager.guv_daily g
        WHERE g.source <> 'historic_backfill'
          AND g.posting_date >= $1::date
          ${machineArr ? 'AND g.machine_id::text = ANY($2::text[])' : ''}`,
      covParams,
    );
    const latest = covRes.rows[0] && covRes.rows[0].latest; // Date | null

    // Parameter strikt in Referenz-Reihenfolge aufbauen, damit kein Parameter
    // ungenutzt bleibt (sonst: "could not determine data type").
    const provParams = [];
    let lowerBound;
    if (latest) {
      provParams.push(dayKeyBerlin(latest));
      lowerBound = `(s.settlement_at AT TIME ZONE 'Europe/Berlin')::date > $${provParams.length}::date`;
    } else {
      provParams.push(fromDate);
      lowerBound = `(s.settlement_at AT TIME ZONE 'Europe/Berlin')::date >= $${provParams.length}::date`;
    }
    provParams.push(upperBound);
    const upperIdx = provParams.length;
    let salesMachine = '';
    if (machineArr) {
      provParams.push(machineArr);
      salesMachine = `AND s.machine_id::text = ANY($${provParams.length}::text[])`;
    }

    const windowWhere = `
        WHERE s.source <> 'historic_backfill'
          AND ${lowerBound}
          AND (s.settlement_at AT TIME ZONE 'Europe/Berlin')::date <= $${upperIdx}::date
          ${salesMachine}`;

    // Vorläufige Verkäufe je Produkt + Gesamt-Datumsspanne (für den Serienpunkt).
    // Sequenziell — ein pg-Client führt keine zwei Queries gleichzeitig aus.
    const byProdRes = await client.query(
      `SELECT s.product_id,
              p.name                            AS product_name,
              COALESCE(SUM(s.quantity), 0)::int AS qty,
              COALESCE(SUM(s.gross_amount), 0)  AS revenue_gross,
              COALESCE(SUM(s.net_amount), 0)    AS revenue_net
         FROM automatenlager.sales_transactions s
         LEFT JOIN automatenlager.products p ON p.product_id = s.product_id
        ${windowWhere}
        GROUP BY s.product_id, p.name`,
      provParams,
    );
    const spanRes = await client.query(
      `SELECT MIN((s.settlement_at AT TIME ZONE 'Europe/Berlin')::date) AS from_date,
              MAX((s.settlement_at AT TIME ZONE 'Europe/Berlin')::date) AS to_date
         FROM automatenlager.sales_transactions s
        ${windowWhere}`,
      provParams,
    );

    const prodRows = byProdRes.rows;
    if (prodRows.length === 0) {
      return { revenue_gross: 0, qty: 0, cost: 0, costComplete: true, byProduct: [], from_date: null, to_date: null };
    }

    // FIFO-Bewertung: Chargen der beteiligten Produkte einmal laden.
    const productIds = prodRows.map((r) => r.product_id).filter((id) => id != null);
    const batchesByProduct = new Map();
    if (productIds.length) {
      const bRes = await client.query(
        `SELECT b.product_id, b.batch_id, b.initial_qty, b.remaining_qty, b.unit_cost_net, b.received_at
           FROM automatenlager.stock_batches b
          WHERE b.product_id = ANY($1::bigint[])`,
        [productIds],
      );
      for (const b of bRes.rows) {
        const id = String(b.product_id);
        if (!batchesByProduct.has(id)) batchesByProduct.set(id, []);
        batchesByProduct.get(id).push(b);
      }
    }

    let totalGross = 0;
    let totalNet = 0;
    let totalQty = 0;
    let totalCost = 0;
    let costComplete = true;
    const byProduct = [];
    for (const r of prodRows) {
      const qty = toNum(r.qty);
      const batches = batchesByProduct.get(String(r.product_id)) || [];
      const fallback = latestKnownUnitCost(batches);
      const fifo = fifoProvisionalCostForProduct(batches, qty, fallback);
      if (!fifo.complete) costComplete = false;
      const rg = toNum(r.revenue_gross);
      const rn = toNum(r.revenue_net);
      totalGross += rg;
      totalNet += rn;
      totalQty += qty;
      totalCost += fifo.cost;
      byProduct.push({
        product_id: r.product_id,
        product_name: r.product_name,
        qty,
        revenue_gross: rg,
        revenue_net: rn,
        cost: fifo.cost,
        cost_estimated: fifo.estimated,
      });
    }

    const span = spanRes.rows[0] || {};
    return {
      revenue_gross: round2(totalGross),
      revenue_net: round2(totalNet),
      qty: totalQty,
      cost: round2(totalCost),
      costComplete,
      byProduct,
      from_date: span.from_date ? dayKeyBerlin(span.from_date) : null,
      to_date: span.to_date ? dayKeyBerlin(span.to_date) : null,
    };
  } finally {
    await client.end();
  }
}

module.exports = {
  buildEconomicsData,
  buildProvisional,
  queryEconomicsPg,
  queryEconomicsProvisionalPg,
  resolvePeriod,
  resolveDateRange,
  isoWeekStart,
  isoWeeksInYear,
  fifoProvisionalCostForProduct,
  latestKnownUnitCost,
  formatProductName,
  parseMachineFilter,
  buildSeriesFromBuckets,
  dayKeyBerlin,
};

