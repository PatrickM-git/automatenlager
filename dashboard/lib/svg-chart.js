'use strict';

function buildBarChartData(items, { labelKey = 'label', valueKey = 'value', maxBars = 10 } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { bars: [], max: 0 };
  }

  const sorted = [...items]
    .sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0))
    .slice(0, maxBars);

  const max = Number(sorted[0][valueKey]) || 0;

  const bars = sorted.map(item => ({
    label:    String(item[labelKey] ?? ''),
    value:    Number(item[valueKey]) || 0,
    pct:      max > 0 ? Math.round((Number(item[valueKey]) / max) * 100) : 0,
    severity: item.severity || 'info',
  }));

  return { bars, max };
}

module.exports = { buildBarChartData };
