'use strict';

/**
 * Schema-/Daten-Vertrag für die Produktkategorie (`produktart`) — Issue #62.
 * ------------------------------------------------------------------------
 * Hintergrund: Die Produktkategorie (`getraenk` / `snack`) war historisch nur in
 * Google Sheets gepflegt und floss ausschließlich über den Sheet-Lesepfad ein.
 * Beim Abschalten der Sheets (#9) ginge sie verloren. Sie ist jetzt eine echte
 * SQL-Spalte: `automatenlager.products.category` (single source of truth).
 *
 * Dieser Guard sichert beides ab — analog zur Schema-Contract-Linie
 * (`lib/db-schema.js`), aber auf Daten-Ebene:
 *   1. Die Spalte existiert.
 *   2. Sie ist für JEDES Produkt gefüllt (kein Sheet-only-Feld mehr).
 *   3. Die Werte sind kanonisch (lowercase, getrimmt) — keine Casing-Drift wie
 *      „Snack" vs. „snack", die zwei Kategorien aus einer machen würde.
 *
 * Überspringt sauber, wenn PG offline ist (wie der Drift-Guard).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT_DIR = path.join(__dirname, '..'); // dashboard/

function resolvePgUrlForTest() {
  const fromEnv = process.env.DASHBOARD_V2_PG_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [path.join(ROOT_DIR, '..', '.env.local'), path.join(ROOT_DIR, '.env.local')];
  let merged = {};
  for (const fp of files) {
    let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      merged[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return (merged.DASHBOARD_V2_PG_URL || merged.POSTGRES_URL || merged.DATABASE_URL || '').trim();
}

async function withPg(t, fn) {
  const pgUrl = resolvePgUrlForTest();
  if (!pgUrl) { t.skip('Kein DASHBOARD_V2_PG_URL — produktart-Vertrag übersprungen.'); return; }
  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return; }
  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    t.skip(`PG nicht erreichbar (${err.code || err.message}) — übersprungen.`);
    return;
  }
  try { await fn(client); } finally { await client.end(); }
}

test('LIVE #62: products.category existiert als echte Spalte', async (t) => {
  await withPg(t, async (client) => {
    const res = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'automatenlager' AND table_name = 'products' AND column_name = 'category'`,
    );
    assert.equal(res.rows.length, 1, 'products.category muss als Spalte existieren (produktart in SQL)');
  });
});

test('LIVE #62: jedes Produkt hat eine produktart (kein NULL/leer)', async (t) => {
  await withPg(t, async (client) => {
    const res = await client.query(
      `SELECT COUNT(*)::int AS n FROM automatenlager.products
        WHERE category IS NULL OR btrim(category) = ''`,
    );
    assert.equal(res.rows[0].n, 0,
      'Jedes Produkt braucht eine produktart in der DB — sonst ginge sie bei Sheets-Abschaltung verloren.');
  });
});

test('LIVE #62: produktart-Werte sind kanonisch (lowercase, getrimmt) — keine Casing-Drift', async (t) => {
  await withPg(t, async (client) => {
    const res = await client.query(
      `SELECT DISTINCT category FROM automatenlager.products
        WHERE category IS NOT NULL AND category <> lower(btrim(category))`,
    );
    assert.equal(res.rows.length, 0,
      `Nicht-kanonische produktart-Werte gefunden (z.B. "Snack" statt "snack"): `
      + JSON.stringify(res.rows.map((r) => r.category)));
  });
});
