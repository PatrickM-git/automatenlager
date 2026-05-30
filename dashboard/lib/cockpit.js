'use strict';

function buildCockpitData(overviewData, monitoringData) {
  const metrics    = overviewData?.metrics    || {};
  const priorities = overviewData?.priorities || [];
  const ampels     = monitoringData?.ampels   || [];

  const kpis = [
    { key: 'warnings',  label: 'Offene Warnungen',  value: metrics.openWarningsCount ?? 0, unit: null  },
    { key: 'mhd-risk',  label: 'MHD-Risiko',        value: metrics.mhdRiskCount      ?? 0, unit: null  },
    { key: 'low-stock', label: 'Niedriger Bestand',  value: metrics.lowStockCount     ?? 0, unit: null  },
    { key: 'revenue',   label: 'Umsatz heute',       value: metrics.revenueNetToday   ?? 0, unit: 'EUR' },
  ];

  let ampelState = 'green';
  for (const a of ampels) {
    if (a.state === 'red')    { ampelState = 'red'; break; }
    if (a.state === 'yellow') { ampelState = 'yellow'; }
  }

  const topPriorities = priorities.slice(0, 3);

  return { kpis, ampelState, topPriorities };
}

module.exports = { buildCockpitData };
