'use strict';

/**
 * inferProductCategory — leitet die Produktkategorie (`getraenk` | `snack`) aus
 * dem/den Produktnamen ab. Genutzt von WF2 (Prepare PGW), damit neu angelegte
 * Produkte NICHT mehr pauschal `snack` bekommen (alte Hardcode-Vorgabe), sondern
 * Getränke automatisch als `getraenk` landen.
 *
 * Design (bewusst konservativ):
 *   - Default = `snack` (= bisheriges Verhalten). Nur bei einem KLAREN Getränke-
 *     Signal (Marke, Getränke-Wort oder Volumenangabe) wird auf `getraenk`
 *     umgeschaltet. Damit kann der Klassifizierer nie schlechter sein als heute:
 *     ein nicht erkanntes Getränk bleibt `snack` (wie bisher), ein Snack wird nie
 *     fälschlich zum Getränk (keine Snack-Namen enthalten die Signale).
 *   - Mehrere Namensquellen (Produktname + Rechnungs-/Nayax-Alias) werden
 *     zusammen betrachtet — die Rechnungszeile trägt oft die Volumenangabe
 *     ("250ml", "0,25") und damit das stärkste Signal.
 *   - Rein lesend/deterministisch, keine Seiteneffekte. Spiegelbild dieser Logik
 *     liegt im WF2-Code-Node "Prepare PGW - WF2 Product+Batch" (n8n-Runtime).
 */

// Marken-/Wort-Signale, die als Teilstring matchen dürfen (eindeutig Getränk).
const DRINK_SUBSTRINGS = [
  'fanta', 'sprite', 'spezi', 'mezzo mix', 'mezzomix', 'pepsi',
  'capri', // Capri Sonne / Capri Sun
  'red bull', 'redbull', 'monster energy', 'rockstar', 'effect energy',
  'lichtenauer', 'gerolsteiner', 'adelholzener', 'bionade', 'paulaner',
  'eiskaffee', 'eiscafe', 'eiskaffe', 'eis kaffee', 'milchmisch',
  'limonade', 'mineralwasser', 'energydrink', 'energy drink', 'eistee',
  'ice tea', 'icetea', 'eis tee', 'smoothie', 'apfelschorle', 'orangensaft',
  'multivitamin', 'durstloescher',
];

// Kurze, mehrdeutige Wörter — nur mit Wortgrenze (sonst Fehl-Treffer in Snacks).
const DRINK_WORDS = [
  'cola', 'limo', 'schorle', 'saft', 'nektar', 'tee', 'kaffee', 'wasser',
  'energy', 'drink', 'getraenk', 'bull', 'vio', 'bier', 'radler', 'sprudel',
];

// Volumenangaben sind ein starkes Getränke-Signal (Snacks tragen Gramm, keine ml/l).
const VOLUME_PATTERNS = [
  /\b\d{2,4}\s?ml\b/,       // 250ml, 330 ml
  /\b\d{1,2}[.,]\d{1,2}\s?l\b/, // 0,25l  0,5 l  1,5l
  /\b\d{1,2}\s?l\b/,        // 1l, 2 l
  /\bliter\b/,
];

/** Deutsche Umlaute ascii-mappen, lowercase, Satzzeichen -> Space (wie WF4/abgleich). */
function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9.,\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {...(string|undefined|null)} names beliebig viele Namensquellen
 *        (Produktname, Rechnungs-Alias, Nayax-Name …). Reihenfolge egal.
 * @returns {'getraenk'|'snack'}
 */
function inferProductCategory(...names) {
  const text = names.map(normalize).filter(Boolean).join(' ');
  if (!text) return 'snack';

  for (const s of DRINK_SUBSTRINGS) {
    if (text.includes(s)) return 'getraenk';
  }
  for (const w of DRINK_WORDS) {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(text)) return 'getraenk';
  }
  for (const re of VOLUME_PATTERNS) {
    if (re.test(text)) return 'getraenk';
  }
  return 'snack';
}

module.exports = { inferProductCategory, DRINK_SUBSTRINGS, DRINK_WORDS };
