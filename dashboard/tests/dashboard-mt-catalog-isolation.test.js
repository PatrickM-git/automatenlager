'use strict';

/**
 * Produkt-Katalog + Chargensuche Lese-Isolation (Issue #141, Stufe-3-Rest) — acme/globex.
 *
 * Zwei Endpunkte lasen bisher an der Mandanten-Tür vorbei:
 *   GET /api/v2/products/catalog        — kein tenant_id-Filter, kein getViewer
 *   GET /api/v2/inventory/batch-search  — viewer vorhanden, aber SQL ohne tenant_id-Filter
 *
 * Diese Tests beschreiben das Soll-Verhalten (Spezifikation + Regressions-Schutz):
 *   - acme sieht nur acme-Produkte/Chargen
 *   - globex sieht nur globex-Produkte/Chargen
 *   - kein Mandant (leere tenantId) ⇒ keine Ergebnisse (fail-closed)
 *
 * Getestet wird die SQL-Abfrage, die die fixierten Endpunkte verwenden (durch die Tür).
 * LIVE im #94-Sandbox-Harness (ROLLBACK). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');

// ── /api/v2/products/catalog ─────────────────────────────────────────────────

test('#141 catalog: acme-Viewer sieht nur acme-Produkte (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    const acme = (await db.read({
      tenant: 'acme',
      tables: ['products'],
      text: `SELECT p.product_id, p.product_key, p.name
             FROM automatenlager.products p
             WHERE p.tenant_id = $1
             ORDER BY p.name`,
      params: [],
    })).rows;

    const globex = (await db.read({
      tenant: 'globex',
      tables: ['products'],
      text: `SELECT p.product_id, p.product_key, p.name
             FROM automatenlager.products p
             WHERE p.tenant_id = $1
             ORDER BY p.name`,
      params: [],
    })).rows;

    assert.ok(acme.length >= 1, 'acme hat Produkte (nicht-vakuös)');
    assert.ok(globex.length >= 1, 'globex hat Produkte (nicht-vakuös)');
    assert.ok(acme.every((r) => /acme/.test(r.name)), 'acme sieht nur acme-Produkte');
    assert.ok(globex.every((r) => !/acme/.test(r.name)), 'globex sieht keine acme-Produkte');
    assert.ok(acme.every((r) => !/globex/.test(r.name)), 'acme sieht keine globex-Produkte');
  });
});

test('#141 catalog fail-closed: kein Mandant ⇒ keine Produkte', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    const none = (await db.read({
      tenant: '',
      tables: ['products'],
      text: `SELECT p.product_id FROM automatenlager.products p WHERE p.tenant_id = $1`,
      params: [],
    })).rows;

    assert.equal(none.length, 0, 'leere tenantId ⇒ keine Produkte (fail-closed)');
  });
});

// ── /api/v2/inventory/batch-search ──────────────────────────────────────────

test('#141 batch-search: acme-Viewer sieht nur acme-Chargen (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);

    const q = 'Cola';

    const acme = (await db.read({
      tenant: 'acme',
      tables: ['stock_batches', 'products'],
      text: `SELECT sb.batch_key, sb.remaining_qty, p.name AS product_name
             FROM automatenlager.stock_batches sb
             JOIN automatenlager.products p
               ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
             WHERE sb.tenant_id = $1
               AND p.name ILIKE $2
               AND sb.status <> 'ausgesondert'
             ORDER BY p.name, sb.received_at ASC
             LIMIT 50`,
      params: [`%${q}%`],
    })).rows;

    const globex = (await db.read({
      tenant: 'globex',
      tables: ['stock_batches', 'products'],
      text: `SELECT sb.batch_key, sb.remaining_qty, p.name AS product_name
             FROM automatenlager.stock_batches sb
             JOIN automatenlager.products p
               ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
             WHERE sb.tenant_id = $1
               AND p.name ILIKE $2
               AND sb.status <> 'ausgesondert'
             ORDER BY p.name, sb.received_at ASC
             LIMIT 50`,
      params: [`%${q}%`],
    })).rows;

    assert.ok(acme.length >= 1, 'acme hat Chargen für "Cola" (nicht-vakuös)');
    assert.ok(globex.length >= 1, 'globex hat Chargen für "Cola" (nicht-vakuös)');
    assert.ok(acme.every((r) => /acme/.test(r.product_name)), 'acme sieht nur acme-Chargen');
    assert.ok(globex.every((r) => !/acme/.test(r.product_name)), 'globex sieht keine acme-Chargen');
    assert.ok(acme.every((r) => !/globex/.test(r.product_name)), 'acme sieht keine globex-Chargen');
  });
});
