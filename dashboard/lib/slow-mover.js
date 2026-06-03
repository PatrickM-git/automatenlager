'use strict';

/**
 * Drehgeschwindigkeits-Klassifikation (Issue #64, Branchen-Anker).
 * ------------------------------------------------------------------
 * Kernumbau: weg von der relativen Quartil-/Stückzahl-Logik, hin zu einem
 * **absoluten, kategoriebasierten, mandantenfähigen** Maßstab.
 *
 * Maßstab = **Deckungsbeitrag (Marge) pro Slot pro Woche**, gemittelt über die
 * letzten 4 Wochen. Geld statt Stückzahl macht alle Preisklassen fair
 * vergleichbar (Energydrink mit hoher Marge vs. Kaugummi mit Mini-Marge).
 *
 * Die Latten kommen aus der Kategorie-/Schwellwert-Config (lib/category-config.js,
 * Issue #63): pro Kategorie eine eigene Geld-Latte, abgeleitet aus der Branchennorm
 * — nicht aus den eigenen (ggf. schwachen) Ist-Zahlen. Ein unterdurchschnittlicher
 * Automat zeigt damit ehrlich überwiegend „Langsam-Dreher".
 *
 * Klassen (Vorrang von oben nach unten):
 *   neu            Produkt in Schonfrist (< graceDays gelistet) — noch nicht fair
 *                  bewertbar; nie Langsam-Dreher.
 *   ladenhueter    0 Verkäufe seit ≥ ladenhueterDays Tagen — eigenes ZEIT-Signal
 *                  (totes Kapital/MHD-Risiko), Vorrang vor den Geld-Klassen.
 *   ek_fehlt       Einkaufspreis unbekannt → keine geratene Klasse, Lücke sichtbar.
 *   renner/normal/langsam_dreher   geldbasiert über die Kategorie-Latte.
 *
 * Reine Funktion ohne DB-Abhängigkeit (testbar). Das Frontend interpretiert nur
 * die gelieferte `turnover_class` als Badge. Definitionen sind im Glossar
 * `docs/UBIQUITOUS_LANGUAGE.md` verbindlich und werden unter `/einstellungen`
 * sichtbar/editierbar gemacht — beides speist sich aus dieser Klassenliste +
 * der effektiven Config.
 */

const { buildEffectiveConfig, DEFAULT_MANDANT, DEFAULT_CONFIG } = require('./category-config.js');

const SLOW_MOVER = {
  // Default-Schwellen (aus der Branchen-Anker-Config). Editierbar je Mandant.
  ladenhueterDays: DEFAULT_CONFIG.ladenhueterDays,
  graceDays: DEFAULT_CONFIG.graceDays,
  // Default-Fenster für den Deckungsbeitrag/Woche (4 Wochen).
  windowWeeks: 4,
  classes: [
    { key: 'renner',         label: 'Renner',         description: 'Deckungsbeitrag pro Slot/Woche über der Renner-Latte der Kategorie — der Platz bringt überdurchschnittlich Geld.' },
    { key: 'normal',         label: 'Normal',         description: 'Deckungsbeitrag im erwarteten Bereich der Kategorie zwischen Langsam- und Renner-Latte.' },
    { key: 'langsam_dreher', label: 'Langsam-Dreher', description: 'Deckungsbeitrag pro Slot/Woche unter der Langsam-Latte — der Platz bringt zu wenig Geld.' },
    { key: 'ladenhueter',    label: 'Ladenhüter',     description: '0 Verkäufe seit ≥ 30 Tagen — totes Kapital und MHD-Risiko (zeitbasiert, Vorrang vor den Geld-Klassen).' },
    { key: 'ek_fehlt',       label: 'EK fehlt',       description: 'Einkaufspreis unbekannt — keine Bewertung möglich. Lücke sichtbar machen statt eine Klasse zu raten.' },
    { key: 'neu',            label: 'Neu',            description: 'In der Schonfrist (< 14 Tage gelistet) — noch keine faire Bewertung, nie als Langsam-Dreher eingestuft.' },
  ],
};

const VALID_CLASSES = SLOW_MOVER.classes.map((c) => c.key);

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Liefert eine effektive Config — akzeptiert sowohl eine bereits gebaute Config
// (mit .latten) als auch einen rohen Override / leer (Defaults).
function asConfig(config) {
  if (config && typeof config === 'object' && config.latten) return config;
  return buildEffectiveConfig(config || {});
}

// Latte für die Kategorie eines Slots; unbekannte Kategorie → Fallback-Latte.
function lattenFor(config, categoryKey) {
  const key = String(categoryKey ?? '').trim().toLowerCase();
  return config.latten[key] || config.latten[DEFAULT_MANDANT];
}

/**
 * Deckungsbeitrag pro Woche eines Slots:
 *   - direkt `marginPerWeek` / `margin_per_week`, falls geliefert, sonst
 *   - `db_window` (Marge im Fenster) ÷ Fensterwochen.
 * Gibt null zurück, wenn keine valide Marge-Basis existiert → Klasse ek_fehlt.
 */
function marginPerWeek(slot, windowWeeks) {
  const direct = finiteOrNull(slot.marginPerWeek != null ? slot.marginPerWeek : slot.margin_per_week);
  if (direct != null) return direct;
  const windowMargin = finiteOrNull(slot.db_window != null ? slot.db_window : slot.margin_window);
  if (windowMargin == null) return null;
  const weeks = finiteOrNull(slot.windowWeeks) || windowWeeks || 4;
  return weeks > 0 ? windowMargin / weeks : null;
}

// Ladenhüter: kein Verkauf seit >= ladenhueterDays Tagen (oder nie verkauft).
function isLadenhueter(slot, ladenhueterDays) {
  const days = finiteOrNull(slot.daysSinceLastSale != null ? slot.daysSinceLastSale : slot.days_since_last_sale);
  if (days == null) return true; // unbekannt / nie verkauft → totes Kapital
  return days >= ladenhueterDays;
}

// EK fehlt, wenn explizit markiert ODER die Marge-Basis nicht berechenbar ist.
function isEkMissing(slot, dbWeek) {
  if (slot.ek_missing === true || slot.ekMissing === true) return true;
  return dbWeek == null;
}

/**
 * Klasse eines einzelnen Slots (Vorrang: neu → ladenhueter → ek_fehlt → Geld).
 */
function classFor(slot, config) {
  const listed = finiteOrNull(slot.listedDays != null ? slot.listedDays : slot.listed_days);
  // 1. Schonfrist: neue Produkte nicht einordnen (vor Ladenhüter, sonst würde ein
  //    frisch gelistetes, nie verkauftes Produkt fälschlich als Ladenhüter gelten).
  if (listed != null && listed < config.graceDays) return 'neu';
  // 2. Ladenhüter (zeitbasiert, Vorrang vor den Geld-Klassen).
  if (isLadenhueter(slot, config.ladenhueterDays)) return 'ladenhueter';
  // 3. EK fehlt → keine geratene Klasse.
  const dbWeek = marginPerWeek(slot, config.windowWeeks);
  if (isEkMissing(slot, dbWeek)) return 'ek_fehlt';
  // 4. Geld-Klassen über die Kategorie-Latte.
  const latte = lattenFor(config, slot.category);
  if (dbWeek >= latte.rennerThreshold) return 'renner';
  if (dbWeek <= latte.langsamThreshold) return 'langsam_dreher';
  return 'normal';
}

/**
 * Klassifiziert eine Liste von Slots. Gibt eine NEUE Liste zurück, in der jeder
 * Slot um `turnover_class` ergänzt ist (Eingabe bleibt unverändert).
 *
 * @param {Array<object>} slots  je Slot: { category, marginPerWeek|db_window,
 *   listedDays, daysSinceLastSale, ek_missing }
 * @param {object} [config] effektive Config (lib/category-config.js) ODER roher
 *   Override; fehlt sie, greifen die Branchen-Anker-Defaults.
 */
function classifyTurnover(slots, config) {
  const cfg = asConfig(config);
  return (slots || []).map((s) => ({ ...s, turnover_class: classFor(s, cfg) }));
}

module.exports = {
  classifyTurnover,
  classFor,
  marginPerWeek,
  isLadenhueter,
  isEkMissing,
  lattenFor,
  asConfig,
  SLOW_MOVER,
  VALID_CLASSES,
};
