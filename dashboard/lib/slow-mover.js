'use strict';

/**
 * Umschlag-/Slow-Mover-Klassifikation (Issue v3-H / #8).
 *
 * Granularität: pro Slot/Automat (nicht global pro Produkt).
 * Verfahren: quartilbasiert über die Drehzahl-Kennzahl (turnover) der aktiven
 *   Slots — oberstes Quartil = Renner, unterstes = Langsam-Dreher, dazwischen
 *   Normal.
 * Sonderklasse Ladenhüter: 0 Verkäufe seit ≥ ladenhueterDays Tagen (Default 30)
 *   → eindeutig Ladenhüter, unabhängig von der Quartilseinordnung.
 *
 * Reine Funktion ohne DB-Abhängigkeit (testbar). Das Frontend interpretiert nur
 * die gelieferte Klasse (`turnover_class`) als Badge. Definitionen sind im
 * Glossar `docs/UBIQUITOUS_LANGUAGE.md` verbindlich festgeschrieben und werden
 * unter `/einstellungen` sichtbar gemacht — beides speist sich aus `SLOW_MOVER`.
 */

const SLOW_MOVER = {
  // Ein Slot ohne Verkauf seit ≥ diesen Tagen gilt als Ladenhüter.
  ladenhueterDays: 30,
  // Unter so vielen aktiven Slots sind Quartile nicht aussagekräftig → alle „normal".
  minPointsForQuartiles: 4,
  classes: [
    { key: 'renner',         label: 'Renner',         description: 'Oberstes Quartil der Drehzahl je Slot/Automat — verkauft sich am schnellsten.' },
    { key: 'normal',         label: 'Normal',         description: 'Mittlerer Drehzahl-Bereich zwischen unterem und oberem Quartil.' },
    { key: 'langsam_dreher', label: 'Langsam-Dreher', description: 'Unterstes Quartil der Drehzahl — dreht langsam, beobachten.' },
    { key: 'ladenhueter',    label: 'Ladenhüter',     description: '0 Verkäufe seit ≥ 30 Tagen — totes Kapital und MHD-Risiko, unabhängig vom Quartil.' },
  ],
};

const VALID_CLASSES = SLOW_MOVER.classes.map((c) => c.key);

// Perzentil mit linearer Interpolation. Erwartet aufsteigend sortiertes Array.
function quantile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function turnoverValue(slot) {
  const raw = slot.turnover != null ? slot.turnover : slot.turnover_count;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

// Ladenhüter: kein Verkauf seit >= ladenhueterDays Tagen (oder nie verkauft).
function isLadenhueter(slot, ladenhueterDays) {
  const days = slot.daysSinceLastSale;
  if (days == null) return true; // unbekannt / nie verkauft
  return Number(days) >= ladenhueterDays;
}

/**
 * Klassifiziert eine Liste von Slots. Gibt eine NEUE Liste zurück, in der jeder
 * Slot um `turnover_class` ergänzt ist (Eingabe bleibt unverändert).
 *
 * @param {Array<object>} slots  je Slot: { ...id, turnover|turnover_count, daysSinceLastSale }
 * @param {object} [opts] { ladenhueterDays, minPointsForQuartiles }
 */
function classifyTurnover(slots, opts = {}) {
  const ladenhueterDays = opts.ladenhueterDays ?? SLOW_MOVER.ladenhueterDays;
  const minPoints = opts.minPointsForQuartiles ?? SLOW_MOVER.minPointsForQuartiles;

  const rows = (slots || []).map((s) => ({ ...s }));

  const active = rows.filter((s) => !isLadenhueter(s, ladenhueterDays));
  let q1 = NaN;
  let q3 = NaN;
  if (active.length >= minPoints) {
    const vals = active.map(turnoverValue).sort((a, b) => a - b);
    q1 = quantile(vals, 0.25);
    q3 = quantile(vals, 0.75);
  }
  const hasSpread = Number.isFinite(q1) && Number.isFinite(q3) && q1 !== q3;

  for (const s of rows) {
    if (isLadenhueter(s, ladenhueterDays)) {
      s.turnover_class = 'ladenhueter';
      continue;
    }
    if (!hasSpread) {
      s.turnover_class = 'normal';
      continue;
    }
    const t = turnoverValue(s);
    if (t >= q3) s.turnover_class = 'renner';
    else if (t <= q1) s.turnover_class = 'langsam_dreher';
    else s.turnover_class = 'normal';
  }
  return rows;
}

module.exports = { classifyTurnover, quantile, isLadenhueter, SLOW_MOVER, VALID_CLASSES };
