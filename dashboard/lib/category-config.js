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
  // #34: MHD-Risiko-Fenster (Tage bis MHD, ab dem eine Charge als Risiko gilt) —
  // EINE Quelle für Cockpit-KPI, Bestandsliste und Monitoring.
  mhdRiskDays: 30,
  // Renner ab: Deckungsbeitrag/Slot/Woche ≥ Erwartungswert × rennerFactor.
  rennerFactor: 1.3,
  // Langsam-Dreher unter: Deckungsbeitrag/Slot/Woche < Erwartungswert × langsamFactor.
  langsamFactor: 0.6,
  // Fallback-Marge für unbekannte/neue Kategorien (z. B. Spielzeug).
  defaultMarginPct: 50,
  // Issue #56: Besteuerungsmodell. CODE-Default = regelbesteuert (false) → Netto-EK
  // als Wareneinsatz. Ein neuer Mandant startet damit konservativ; der konkrete
  // Betreiber setzt für sich Kleinunternehmer=true (per Override/Seed).
  kleinunternehmerAktiv: false,
  // Fallback-MwSt für unbekannte Kategorien (für die Brutto-Kostenbasis bei KU).
  defaultMwstPct: 19,
  // Kategorie-Stammdaten: key (= produktart in products.category) → Label + Marge
  // + MwSt-Satz (Quelle der Brutto-EK-Aufrechnung bei Kleinunternehmer).
  categories: {
    getraenk: { label: 'Getränke', marginPct: 43, mwstPct: 19 },
    snack: { label: 'Snacks', marginPct: 52, mwstPct: 7 },
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
    mhdRiskDays: Math.max(1, num(o.mhdRiskDays, defaults.mhdRiskDays)),
    rennerFactor: num(o.rennerFactor, defaults.rennerFactor),
    langsamFactor: num(o.langsamFactor, defaults.langsamFactor),
    defaultMarginPct: num(o.defaultMarginPct, defaults.defaultMarginPct),
    kleinunternehmerAktiv: typeof o.kleinunternehmerAktiv === 'boolean'
      ? o.kleinunternehmerAktiv
      : defaults.kleinunternehmerAktiv,
    defaultMwstPct: num(o.defaultMwstPct, defaults.defaultMwstPct),
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
      mwstPct: num(ovr.mwstPct, num(base.mwstPct, merged.defaultMwstPct)),
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
  const fallbackMwst = num(config.defaultMwstPct, 19);
  if (cat) {
    return {
      key, label: cat.label, marginPct: cat.marginPct,
      mwstPct: num(cat.mwstPct, fallbackMwst), known: true,
    };
  }
  return {
    key, label: key || 'Unbekannt', marginPct: config.defaultMarginPct,
    mwstPct: fallbackMwst, known: false,
  };
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

// Frische DBs bekommen die Tabelle direkt mit der angeglichenen Spalte `tenant_id`
// (#96). Bestehende DBs vor dem Deploy von Migration 0009 tragen noch `mandant_id`
// — CREATE IF NOT EXISTS ist dort ein No-Op, und tenantColumn() unten erkennt den
// realen Spaltennamen. So bleibt der Code gegen beide Schema-Zustände korrekt,
// ohne die Produktions-DB anzufassen.
const CREATE_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS automatenlager.classification_settings (
    tenant_id text PRIMARY KEY,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

// Übergangsbrücke (#96): liefert den real existierenden Mandanten-Spaltennamen.
// Ziel ist `tenant_id`; `mandant_id` ist der Legacy-Name bis Migration 0009
// deployt ist. Strikt auf diese zwei Whitelist-Werte beschränkt (keine Injection).
// Nach dem Deploy liefert die Funktion immer 'tenant_id' — der Fallback ist dann
// toter Code und kann in einer Folgestufe entfernt werden.
async function tenantColumn(client) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'automatenlager' AND table_name = 'classification_settings'
        AND column_name IN ('tenant_id', 'mandant_id')
      ORDER BY (column_name = 'tenant_id') DESC
      LIMIT 1`,
  );
  return (res.rows[0] && res.rows[0].column_name) === 'mandant_id' ? 'mandant_id' : 'tenant_id';
}

/**
 * Liest den rohen Override eines Mandanten (leeres Objekt, wenn keiner existiert).
 * Mandant-Isolation: liest exakt die Zeile dieses Mandanten, nie eine fremde.
 */
async function readOverride(client, mandantId = DEFAULT_MANDANT) {
  const col = await tenantColumn(client);
  const res = await client.query(
    `SELECT config FROM automatenlager.classification_settings WHERE ${col} = $1`,
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
  const col = await tenantColumn(client);
  await client.query(
    `INSERT INTO automatenlager.classification_settings (${col}, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (${col}) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
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
    'ladenhueterDays', 'mhdRiskDays', 'rennerFactor', 'langsamFactor', 'defaultMarginPct', 'defaultMwstPct'];
  for (const k of numKeys) {
    if (o[k] != null && Number.isFinite(Number(o[k]))) out[k] = Number(o[k]);
  }
  // Besteuerungsmodell (#56): boolean oder String 'true'/'false' akzeptieren.
  if (typeof o.kleinunternehmerAktiv === 'boolean') {
    out.kleinunternehmerAktiv = o.kleinunternehmerAktiv;
  } else if (typeof o.kleinunternehmerAktiv === 'string') {
    const s = o.kleinunternehmerAktiv.trim().toLowerCase();
    if (s === 'true' || s === 'false') out.kleinunternehmerAktiv = s === 'true';
  }
  if (isPlainObject(o.categories)) {
    out.categories = {};
    for (const [rawKey, val] of Object.entries(o.categories)) {
      const key = normalizeCategoryKey(rawKey);
      if (!key || !isPlainObject(val)) continue;
      const cat = {};
      if (val.label != null && String(val.label).trim()) cat.label = String(val.label).trim();
      if (val.marginPct != null && Number.isFinite(Number(val.marginPct))) cat.marginPct = Number(val.marginPct);
      if (val.mwstPct != null && Number.isFinite(Number(val.mwstPct))) cat.mwstPct = Number(val.mwstPct);
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
  tenantColumn,
};
