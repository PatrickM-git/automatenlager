'use strict';

/**
 * Kategorie- & Schwellwert-Fundament (Issue #63).
 * ------------------------------------------------------------------
 * Eine mandantenfähige, editierbare Konfiguration für die geldbasierte
 * Drehgeschwindigkeits-Klassifikation (Issue #64) — mit sinnvollen Defaults aus
 * der Branchennorm, damit ein neuer Mandant **ohne jede Konfiguration** ab Tag 1
 * sinnvolle Klassen sieht (Onboarding).
 *
 * Aufbau (Deep Module, DB-frei testbar):
 *   - DEFAULT_CONFIG            die Branchen-Anker-Defaults (Norm, Margen, Latten-
 *                              faktoren, Schon-/Ladenhüter-Tage).
 *   - mergeConfig()            Defaults + Mandant-Override → effektive Config.
 *   - resolveCategory()        produktart (category_key) → effektive Marge/Label,
 *                              Fallback auf Default-Marge für unbekannte Kategorien.
 *   - lattenForCategory()      leitet die Geld-Latten (€/Slot/Woche) je Kategorie
 *                              aus dem Branchen-Anker ab (Umsatz-Norm × Marge ×
 *                              Faktoren). Das ist die „Messlatte von außen".
 *   - buildEffectiveConfig()   liefert die fertige Config inkl. vorberechneter
 *                              Latten je Kategorie — genau das, was slow-mover.js
 *                              und /einstellungen konsumieren.
 *
 * Persistenz: classification_settings (JSONB-Override je mandant_id). Read/Write
 * weiter unten; Defaults greifen, solange kein Override existiert.
 *
 * Mandantenfähigkeit: alle Strukturen tragen eine `mandant_id`-Dimension
 * (Konstruktions-Spalt, keine Voll-Tenancy). Mandant-A-Werte lecken nie zu B.
 */

// Sentinel für „der globale Default-Mandant" (solange keine echte Tenancy existiert).
const DEFAULT_MANDANT = '__default__';

/**
 * Branchen-Anker-Defaults. Quelle: SPEC branchen-anker-drehgeschwindigkeit-v1.md
 * (Branchenrecherche 2026-06-03). Alle Werte editierbar (Issue #66).
 */
const DEFAULT_CONFIG = {
  // Umsatz-Norm eines gut positionierten Automaten (€/Automat/Monat). Quelle der
  // Latte — bewusst NICHT aus den eigenen (ggf. schwachen) Ist-Zahlen abgeleitet.
  umsatzNormMonth: 800,
  // Angenommene belegte Slot-Zahl je Automat (für die Umrechnung auf €/Slot/Woche).
  slotsPerMachine: 30,
  // Wochen je Monat (für die Umrechnung Monat → Woche).
  weeksPerMonth: 4.33,
  // Schonfrist neuer Produkte: jünger als so viele Tage → Klasse „neu", nie Langsam.
  graceDays: 14,
  // Ladenhüter: 0 Verkäufe seit ≥ so vielen Tagen (eigenes Zeitsignal).
  ladenhueterDays: 30,
  // Renner ab: Deckungsbeitrag/Slot/Woche ≥ Erwartungswert × rennerFactor.
  rennerFactor: 1.3,
  // Langsam-Dreher unter: Deckungsbeitrag/Slot/Woche < Erwartungswert × langsamFactor.
  langsamFactor: 0.6,
  // Fallback-Marge für unbekannte/neue Kategorien (z. B. Spielzeug).
  defaultMarginPct: 50,
  // Kategorie-Stammdaten: key (= produktart in products.category) → Label + Marge.
  categories: {
    getraenk: { label: 'Getränke', marginPct: 43 },
    snack: { label: 'Snacks', marginPct: 52 },
  },
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Effektive Config = Defaults + Mandant-Override (flach + categories tief gemerged).
 * Override-Felder, die fehlen/ungültig sind, fallen auf den Default zurück.
 * Gibt IMMER eine neue, vollständige Config zurück (Eingaben unverändert).
 */
function mergeConfig(defaults = DEFAULT_CONFIG, override = {}) {
  const o = isPlainObject(override) ? override : {};
  const merged = {
    umsatzNormMonth: num(o.umsatzNormMonth, defaults.umsatzNormMonth),
    slotsPerMachine: Math.max(1, num(o.slotsPerMachine, defaults.slotsPerMachine)),
    weeksPerMonth: num(o.weeksPerMonth, defaults.weeksPerMonth) > 0
      ? num(o.weeksPerMonth, defaults.weeksPerMonth) : defaults.weeksPerMonth,
    graceDays: Math.max(0, num(o.graceDays, defaults.graceDays)),
    ladenhueterDays: Math.max(1, num(o.ladenhueterDays, defaults.ladenhueterDays)),
    rennerFactor: num(o.rennerFactor, defaults.rennerFactor),
    langsamFactor: num(o.langsamFactor, defaults.langsamFactor),
    defaultMarginPct: num(o.defaultMarginPct, defaults.defaultMarginPct),
    categories: {},
  };
  // Renner-Latte darf nie unter der Langsam-Latte liegen (Editier-Sicherung).
  if (merged.langsamFactor > merged.rennerFactor) {
    merged.langsamFactor = defaults.langsamFactor;
    merged.rennerFactor = defaults.rennerFactor;
  }
  // Kategorien: Default-Kategorien + Mandant-Kategorien. Override je key tief.
  const baseCats = isPlainObject(defaults.categories) ? defaults.categories : {};
  const ovrCats = isPlainObject(o.categories) ? o.categories : {};
  for (const key of new Set([...Object.keys(baseCats), ...Object.keys(ovrCats)])) {
    const base = baseCats[key] || {};
    const ovr = isPlainObject(ovrCats[key]) ? ovrCats[key] : {};
    merged.categories[normalizeCategoryKey(key)] = {
      label: (ovr.label != null && String(ovr.label).trim())
        ? String(ovr.label).trim()
        : (base.label || key),
      marginPct: num(ovr.marginPct, num(base.marginPct, merged.defaultMarginPct)),
    };
  }
  return merged;
}

// Kategorie-Schlüssel kanonisch (lowercase/getrimmt) — deckungsgleich zu #62
// (products.category) und verhindert Casing-Drift „Snack" vs „snack".
function normalizeCategoryKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

/**
 * Liefert {key, label, marginPct} für eine produktart. Unbekannte Kategorie →
 * Fallback-Marge (defaultMarginPct), key bleibt erhalten (z. B. neue „spielzeug").
 */
function resolveCategory(config, categoryKey) {
  const key = normalizeCategoryKey(categoryKey);
  const cat = config.categories[key];
  if (cat) return { key, label: cat.label, marginPct: cat.marginPct, known: true };
  return { key, label: key || 'Unbekannt', marginPct: config.defaultMarginPct, known: false };
}

/**
 * Erwarteter Deckungsbeitrag pro Slot pro Woche für eine Kategorie (Branchen-Anker):
 *   (Umsatz-Norm/Monat ÷ Slots ÷ Wochen/Monat) × Kategorie-Marge.
 * Plus die zwei Schnittpunkte (Renner ab / Langsam unter).
 */
function lattenForCategory(config, categoryKey) {
  const { key, label, marginPct, known } = resolveCategory(config, categoryKey);
  const umsatzPerSlotWeek = config.umsatzNormMonth / config.slotsPerMachine / config.weeksPerMonth;
  const expected = umsatzPerSlotWeek * (marginPct / 100);
  return {
    key,
    label,
    marginPct,
    known,
    expectedDbPerSlotWeek: round2(expected),
    rennerThreshold: round2(expected * config.rennerFactor),
    langsamThreshold: round2(expected * config.langsamFactor),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Fertige effektive Config inkl. vorberechneter Latten je bekannter Kategorie +
 * Default-Latte (__default__) für unbekannte. Das ist der Vertrag, den
 * slow-mover.js (#64) und /einstellungen (#66) konsumieren.
 */
function buildEffectiveConfig(override = {}, defaults = DEFAULT_CONFIG) {
  const config = mergeConfig(defaults, override);
  const latten = {};
  for (const key of Object.keys(config.categories)) {
    latten[key] = lattenForCategory(config, key);
  }
  latten[DEFAULT_MANDANT] = lattenForCategory(config, DEFAULT_MANDANT); // Fallback-Latte
  return { ...config, latten };
}

// ── Persistenz: classification_settings (JSONB-Override je mandant_id) ──────────

const SETTINGS_TABLE = 'automatenlager.classification_settings';

const CREATE_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS automatenlager.classification_settings (
    mandant_id text PRIMARY KEY,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

/**
 * Liest den rohen Override eines Mandanten (leeres Objekt, wenn keiner existiert).
 * Mandant-Isolation: liest exakt die Zeile dieses mandant_id, nie eine fremde.
 */
async function readOverride(client, mandantId = DEFAULT_MANDANT) {
  const res = await client.query(
    `SELECT config FROM automatenlager.classification_settings WHERE mandant_id = $1`,
    [String(mandantId || DEFAULT_MANDANT)],
  );
  if (!res.rows.length) return {};
  return isPlainObject(res.rows[0].config) ? res.rows[0].config : {};
}

/**
 * Schreibt den Override eines Mandanten (Upsert). Validiert/normalisiert über
 * mergeConfig, sodass nie Müll persistiert wird; gibt die effektive Config zurück.
 */
async function writeOverride(client, mandantId, override) {
  const clean = sanitizeOverride(override);
  await client.query(
    `INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (mandant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [String(mandantId || DEFAULT_MANDANT), JSON.stringify(clean)],
  );
  return buildEffectiveConfig(clean);
}

/**
 * Reduziert beliebige Eingaben auf die erlaubten Override-Felder (keine fremden
 * Schlüssel in die DB). Zahlen werden numerisch gehalten, Kategorien normalisiert.
 */
function sanitizeOverride(input) {
  const o = isPlainObject(input) ? input : {};
  const out = {};
  const numKeys = ['umsatzNormMonth', 'slotsPerMachine', 'weeksPerMonth', 'graceDays',
    'ladenhueterDays', 'rennerFactor', 'langsamFactor', 'defaultMarginPct'];
  for (const k of numKeys) {
    if (o[k] != null && Number.isFinite(Number(o[k]))) out[k] = Number(o[k]);
  }
  if (isPlainObject(o.categories)) {
    out.categories = {};
    for (const [rawKey, val] of Object.entries(o.categories)) {
      const key = normalizeCategoryKey(rawKey);
      if (!key || !isPlainObject(val)) continue;
      const cat = {};
      if (val.label != null && String(val.label).trim()) cat.label = String(val.label).trim();
      if (val.marginPct != null && Number.isFinite(Number(val.marginPct))) cat.marginPct = Number(val.marginPct);
      out.categories[key] = cat;
    }
  }
  return out;
}

/**
 * Effektive Config eines Mandanten aus der DB (Override + Defaults). Stellt die
 * Tabelle sicher (idempotent), liest den Override und baut die effektive Config.
 */
async function loadEffectiveConfig(client, mandantId = DEFAULT_MANDANT) {
  await client.query(CREATE_SETTINGS_TABLE_SQL);
  const override = await readOverride(client, mandantId);
  return buildEffectiveConfig(override);
}

module.exports = {
  DEFAULT_MANDANT,
  DEFAULT_CONFIG,
  SETTINGS_TABLE,
  CREATE_SETTINGS_TABLE_SQL,
  mergeConfig,
  normalizeCategoryKey,
  resolveCategory,
  lattenForCategory,
  buildEffectiveConfig,
  sanitizeOverride,
  readOverride,
  writeOverride,
  loadEffectiveConfig,
};
