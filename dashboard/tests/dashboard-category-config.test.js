'use strict';

/**
 * Kategorie- & Schwellwert-Fundament (Issue #63).
 * Testet externes Verhalten: Defaults, effektive Config (Merge), Latten-Ableitung
 * aus dem Branchen-Anker, Mandant-Isolation. Keine Tests gegen Interna.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_CONFIG,
  DEFAULT_MANDANT,
  mergeConfig,
  resolveCategory,
  lattenForCategory,
  buildEffectiveConfig,
  sanitizeOverride,
  normalizeCategoryKey,
} = require('../lib/category-config.js');

// ── Defaults / Onboarding ─────────────────────────────────────────────────────

test('#63 Defaults: Branchen-Margen 43/52 %, Fallback 50 %, Schon-/Ladenhüter-Tage', () => {
  assert.equal(DEFAULT_CONFIG.categories.getraenk.marginPct, 43);
  assert.equal(DEFAULT_CONFIG.categories.snack.marginPct, 52);
  assert.equal(DEFAULT_CONFIG.defaultMarginPct, 50);
  assert.equal(DEFAULT_CONFIG.graceDays, 14);
  assert.equal(DEFAULT_CONFIG.ladenhueterDays, 30);
});

test('#63 Onboarding: leere Config liefert vollständige effektive Config mit Latten', () => {
  const cfg = buildEffectiveConfig({});
  assert.ok(cfg.latten.getraenk && cfg.latten.snack, 'beide Default-Kategorien haben Latten');
  assert.ok(cfg.latten[DEFAULT_MANDANT], 'Fallback-Latte für unbekannte Kategorien existiert');
  assert.ok(cfg.latten.snack.rennerThreshold > cfg.latten.snack.langsamThreshold,
    'Renner-Latte liegt über Langsam-Latte');
});

// ── Latten-Ableitung (Branchen-Anker) ─────────────────────────────────────────

test('#63 Latte = (Umsatz-Norm/Slots/Wochen) × Marge × Faktor', () => {
  const cfg = buildEffectiveConfig({});
  const umsatzPerSlotWeek = 800 / 30 / 4.33;
  const expectedSnack = umsatzPerSlotWeek * 0.52;
  const l = lattenForCategory(cfg, 'snack');
  assert.ok(Math.abs(l.expectedDbPerSlotWeek - Math.round(expectedSnack * 100) / 100) < 0.011);
  assert.ok(Math.abs(l.rennerThreshold - Math.round(expectedSnack * 1.3 * 100) / 100) < 0.011);
  assert.ok(Math.abs(l.langsamThreshold - Math.round(expectedSnack * 0.6 * 100) / 100) < 0.011);
});

test('#63 Kategorie-eigene Latten: höhere Marge → höhere Latte (snack > getraenk)', () => {
  const cfg = buildEffectiveConfig({});
  // Snack 52 % vs Getränk 43 % → bei gleicher Umsatz-Norm liegt die Snack-Latte höher.
  assert.ok(cfg.latten.snack.expectedDbPerSlotWeek > cfg.latten.getraenk.expectedDbPerSlotWeek);
});

// ── Unbekannte Kategorie → Fallback-Marge ─────────────────────────────────────

test('#63 unbekannte Kategorie nutzt Fallback-Marge, key bleibt erhalten', () => {
  const cfg = buildEffectiveConfig({});
  const r = resolveCategory(cfg, 'spielzeug');
  assert.equal(r.marginPct, 50);
  assert.equal(r.key, 'spielzeug');
  assert.equal(r.known, false);
});

// ── Override greift, ohne Override Default ─────────────────────────────────────

test('#63 Override greift: eigene Marge + eigene graceDays', () => {
  const cfg = buildEffectiveConfig({
    graceDays: 7,
    categories: { snack: { marginPct: 60 } },
  });
  assert.equal(cfg.graceDays, 7);
  assert.equal(cfg.categories.snack.marginPct, 60);
  assert.equal(cfg.categories.getraenk.marginPct, 43, 'nicht überschriebene Kategorie bleibt Default');
});

test('#63 ohne Override fällt jedes Feld auf Default zurück', () => {
  const cfg = buildEffectiveConfig({ umsatzNormMonth: 'kaputt', graceDays: null });
  assert.equal(cfg.umsatzNormMonth, 800);
  assert.equal(cfg.graceDays, 14);
});

test('#63 eigene Kategorie anlegen (Mandant erweitert Kategorienraum)', () => {
  const cfg = buildEffectiveConfig({
    categories: { spielzeug: { label: 'Spielzeug', marginPct: 65 } },
  });
  assert.equal(cfg.categories.spielzeug.marginPct, 65);
  assert.ok(cfg.latten.spielzeug, 'neue Kategorie bekommt eine eigene Latte');
});

// ── Editier-Sicherung ─────────────────────────────────────────────────────────

test('#63 widersprüchliche Faktoren (langsam > renner) fallen auf Defaults zurück', () => {
  const cfg = buildEffectiveConfig({ langsamFactor: 2.0, rennerFactor: 1.1 });
  assert.equal(cfg.langsamFactor, DEFAULT_CONFIG.langsamFactor);
  assert.equal(cfg.rennerFactor, DEFAULT_CONFIG.rennerFactor);
});

// ── Mandant-Isolation (Konstruktions-Spalt) ───────────────────────────────────

test('#63 Mandant-A-Override leckt nicht zu Mandant-B', () => {
  const a = buildEffectiveConfig({ categories: { snack: { marginPct: 99 } } });
  const b = buildEffectiveConfig({});
  assert.equal(a.categories.snack.marginPct, 99);
  assert.equal(b.categories.snack.marginPct, 52, 'B sieht den A-Override nicht');
  assert.equal(DEFAULT_CONFIG.categories.snack.marginPct, 52, 'Defaults bleiben unmutiert');
});

// ── sanitizeOverride: nur erlaubte Felder, normalisierte keys ──────────────────

test('#63 sanitizeOverride wirft Fremdfelder weg, normalisiert Kategorie-keys', () => {
  const clean = sanitizeOverride({
    graceDays: 10,
    evil: 'DROP TABLE',
    categories: { '  Snack ': { marginPct: 55, label: 'Snacks' }, bad: 'x' },
  });
  assert.equal(clean.graceDays, 10);
  assert.ok(!('evil' in clean));
  assert.ok(clean.categories.snack, 'key wurde zu lowercase/getrimmt normalisiert');
  assert.ok(!('bad' in clean.categories), 'Nicht-Objekt-Kategorie verworfen');
});

test('#63 normalizeCategoryKey deckungsgleich zu produktart (lowercase/getrimmt)', () => {
  assert.equal(normalizeCategoryKey('  Getraenk '), 'getraenk');
  assert.equal(normalizeCategoryKey('SNACK'), 'snack');
});
