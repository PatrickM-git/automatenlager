'use strict';

// Reine, framework-freie Helfer für die GuV-Seite (v3).
// Server-seitig getestet; der Client (public/v3.js) spiegelt diese Logik,
// damit kein zusätzlicher Server-Round-Trip nötig ist – analog zu lib/lager.js.

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function marginPct(part, whole) {
  return whole > 0 ? round1((part / whole) * 100) : 0;
}

// Verdichtet (product_id, Monat)-Zeilen zu einer Produkt-Bestenliste über den
// gesamten Zeitraum: je Produkt aufsummiert, absteigend nach Brutto-Umsatz,
// auf die Top-N begrenzt.
function aggregateTopProducts(rows, { limit = 10 } = {}) {
  const byProduct = new Map();
  for (const r of rows || []) {
    const id = toNum(r.product_id);
    const acc = byProduct.get(id) || {
      product_id: id,
      product_name: null,
      revenue_net: 0,
      db_net: 0,
      revenue_gross: 0,
      gross_profit: 0,
      qty: 0,
    };
    if (r.product_name != null && r.product_name !== '') acc.product_name = String(r.product_name);
    acc.revenue_net += toNum(r.revenue_net);
    acc.db_net += toNum(r.db_net);
    acc.revenue_gross += toNum(r.revenue_gross);
    acc.gross_profit += toNum(r.gross_profit);
    acc.qty += toNum(r.qty);
    byProduct.set(id, acc);
  }
  return [...byProduct.values()]
    .map((p) => ({
      product_id: p.product_id,
      product_name: p.product_name != null ? p.product_name : String(p.product_id),
      revenue_net: round2(p.revenue_net),
      db_net: round2(p.db_net),
      revenue_gross: round2(p.revenue_gross),
      gross_profit: round2(p.gross_profit),
      qty: p.qty,
      margin_pct: marginPct(p.db_net, p.revenue_net),
      margin_gross_pct: marginPct(p.gross_profit, p.revenue_gross),
    }))
    .sort((a, b) => b.revenue_gross - a.revenue_gross)
    .slice(0, limit);
}

// Bildet eine Zeitreihe auf SVG-Koordinaten ab: höchster Wert oben (y = pad),
// niedrigster unten (y = height - pad). Liefert Punkte + fertige Pfade für
// Linie und gefüllte Fläche.
function buildLineSeries(series, valueKey, opts = {}) {
  const width = opts.width != null ? opts.width : 320;
  const height = opts.height != null ? opts.height : 120;
  const pad = opts.pad != null ? opts.pad : 10;

  const data = (series || []).map((d) => ({ month: d.month, value: toNum(d[valueKey]) }));
  if (data.length === 0) {
    return { points: [], min: 0, max: 0, path: '', area: '' };
  }

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const bottom = height - pad;

  const points = data.map((d, i) => {
    const x = data.length === 1 ? pad : round2(pad + (i / (data.length - 1)) * innerW);
    const y = span === 0
      ? round2(height / 2)
      : round2(pad + (1 - (d.value - min) / span) * innerH);
    return { x, y, value: d.value, month: d.month };
  });

  const path = 'M' + points.map((p) => `${p.x} ${p.y}`).join(' L');
  const area = path + ` L${points[points.length - 1].x} ${bottom} L${points[0].x} ${bottom} Z`;

  return { points, min, max, path, area };
}

// #57 Tagesverlauf: laufende (kumulierte) Summe je Bucket – Basis für die
// kumulierte Gewinnlinie über der Umsatz-Fläche. Liefert {month, value, cumulative}.
function buildCumulative(series, valueKey) {
  let running = 0;
  return (series || []).map((d) => {
    const value = toNum(d[valueKey]);
    running += value;
    return { month: d.month, value: round2(value), cumulative: round2(running) };
  });
}

// #57 Kombi-Chart (Monats-/Jahresvergleich): teilt je Periode den Brutto-Umsatz
// in Wareneinsatz (unten) + Gewinn (oben), sodass beide gestapelt exakt den
// Umsatz ergeben. Gewinn wird auf [0, total] gedeckelt (Verlust -> 0, der ganze
// Balken ist dann Kosten; Gewinn > Umsatz -> auf Umsatz begrenzt).
function buildStackedBars(series, { totalKey = 'revenue_gross', profitKey = 'gross_profit' } = {}) {
  return (series || []).map((d) => {
    const total = toNum(d[totalKey]);
    const rawProfit = toNum(d[profitKey]);
    const profit = Math.max(0, Math.min(rawProfit, total));
    const cost = Math.max(0, total - profit);
    return { month: d.month, total: round2(total), profit: round2(profit), cost: round2(cost) };
  });
}

module.exports = { aggregateTopProducts, buildLineSeries, buildCumulative, buildStackedBars };
