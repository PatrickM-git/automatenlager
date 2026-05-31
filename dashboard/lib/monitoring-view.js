'use strict';

/**
 * Monitoring-View — reine Aufbereitung der bestehenden /api/v2/monitoring-Daten
 * plus Integration der offenen Korrekturfälle (/api/v2/correction-cases) für die
 * v3-Monitoring-Seite. Keine DB-/HTTP-Abhängigkeit: Eingabe -> View-Modell.
 *
 * Begriffe (siehe docs/UBIQUITOUS_LANGUAGE.md):
 *  - Ampel-Zustand: 'green' (ok), 'yellow' (Warnung), 'red' (kritisch).
 *  - Gesamt-Ampel: der schlechteste Einzelzustand gewinnt.
 */

const STATES = ['red', 'yellow', 'green'];
const SEVERITY = { red: 3, yellow: 2, green: 1 };

function buildMonitoringView(monitoring = {}, correctionCases = [], options = {}) {
  const mon = monitoring || {};
  const ampelsAll = Array.isArray(mon.ampels) ? mon.ampels.slice() : [];
  const cases = Array.isArray(correctionCases) ? correctionCases.slice() : [];
  const warnings = Array.isArray(mon.warnings) ? mon.warnings.slice() : [];

  const counts = { red: 0, yellow: 0, green: 0 };
  let worst = 0;
  for (const a of ampelsAll) {
    const st = a && a.state;
    if (st === 'red' || st === 'yellow' || st === 'green') {
      counts[st] += 1;
      if (SEVERITY[st] > worst) { worst = SEVERITY[st]; }
    }
  }
  const overallState = worst === 3 ? 'red' : worst === 2 ? 'yellow' : 'green';

  const distribution = STATES.map((state) => ({ state, count: counts[state] }));

  const requested = options && options.stateFilter;
  const activeFilter = (requested && requested !== 'all') ? requested : 'all';
  const ampels = activeFilter === 'all'
    ? ampelsAll
    : ampelsAll.filter((a) => a && a.state === activeFilter);

  return {
    overallState,
    counts,
    total: ampelsAll.length,
    distribution,
    ampels,
    activeFilter,
    warnings,
    warningsCount: warnings.length,
    correction: {
      openCount: cases.length,
      cases,
    },
  };
}

module.exports = { buildMonitoringView };
