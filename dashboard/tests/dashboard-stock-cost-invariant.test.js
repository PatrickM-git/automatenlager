'use strict';

// Guard für das Einkaufspreis-Invariant der Lagerchargen:
//
//   "Jede bestandswirksame Charge (status ∈ {aktiv, active, reserve} oder leer)
//    MUSS unit_cost_net > 0 haben."
//
// Hintergrund + vollständige Begründung: lib/stock-cost-invariant.js.
// Kurz: WF2 setzt den EK mit `Number(item.unit_cost) || 0` — fehlt der Preis,
// landet still 0 in der DB und Verkäufe aus der Charge buchen Wareneinsatz 0
// (scheinbar 100 % Marge). Dieser Live-Guard schlägt an, sobald wieder eine
// bestandswirksame Charge ohne EK auftaucht. Überspringt sauber, wenn PG offline
// ist (gleiches Muster wie tests/dashboard-db-schema.test.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { runStockCostCheck } = require('../lib/stock-cost-invariant.js');

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

test('LIVE: keine bestandswirksame Charge ohne Einkaufspreis (skip wenn PG offline)', async (t) => {
  const pgUrl = resolvePgUrlForTest();
  if (!pgUrl) { t.skip('Kein DASHBOARD_V2_PG_URL — EK-Invariant-Check übersprungen.'); return; }

  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return; }

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    t.skip(`PG nicht erreichbar (${err.code || err.message}) — EK-Invariant-Check übersprungen.`);
    return;
  }

  try {
    const report = await runStockCostCheck(client);
    const detail = report.offenders
      .map((o) => `  batch ${o.batchId} (product ${o.productId}, ${o.batchKey}, status=${o.status}, rest=${o.remainingQty})`)
      .join('\n');
    assert.equal(
      report.healthy,
      true,
      `Bestandswirksame Charge(n) ohne Einkaufspreis (unit_cost_net <= 0) gefunden — `
        + `FIFO-Verkäufe daraus buchen Wareneinsatz 0 (scheinbar 100 % Marge). `
        + `EK aus der zugehörigen Rechnung/dem Lagerchargen-Sheet ergänzen:\n${detail}`,
    );
  } finally {
    await client.end();
  }
});
