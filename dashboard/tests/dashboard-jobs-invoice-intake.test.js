'use strict';

/**
 * WF1/WF2 Rechnungseingang — In-Process-Port (Issue #163, Stufe 6 Slice 3).
 * WF1: PDF→Claude→invoice+invoice_item. WF2: Freigabe→product/alias/stock_batch.
 * Alles durch die Mandanten-Tür (db.tx), faithful zur pgw_write-Semantik.
 *
 * Ebenen: (1) reine Builder (Claude-Request/Parse, invoice/product-batch-Events);
 * (2) Live applyInvoiceEvents/applyProductBatch durch die Tür (acme/globex-Isolation,
 * invoice_item-Verlinkung); (3) Schatten-Diff invoice_items vs. n8n-Ist.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const ii = require('../lib/jobs/invoice-intake.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T08:00:00.000Z';

function sampleInvoice(extra = {}) {
  return {
    invoice_id: 'R-2026-001',
    supplier: 'Großhandel Müller',
    purchase_date: '2026-06-01',
    invoice_lines: [
      { source_item: '24x36g M&M CRISPY', quantity: 24, unit_cost: 0.5, mwst_satz: 7, mhd: '2027-01-01' },
      { source_item: '12x0,5L Cola', quantity: 12, unit_cost: 0.8, mwst_satz: 19, mhd: '' },
    ],
    ...extra,
  };
}

// ── Ebene 1: Claude-Request + Parse ──────────────────────────────────────────
test('#163 buildInvoiceExtractionRequest: claude-sonnet-4-6, Document-Block + Extraktions-Prompt', () => {
  const body = ii.buildInvoiceExtractionRequest('B64PDF', 'application/pdf');
  assert.equal(body.model, 'claude-sonnet-4-6');
  const doc = body.messages[0].content.find((c) => c.type === 'document');
  assert.equal(doc.source.data, 'B64PDF');
  assert.match(body.messages[0].content.find((c) => c.type === 'text').text, /Rechnungsparser/);
});

test('#163 parseInvoiceExtraction: strippt Fences, verlangt invoice_lines-Array', () => {
  const ok = ii.parseInvoiceExtraction({ content: [{ text: '```json\n{"invoice_id":"R1","invoice_lines":[]}\n```' }] });
  assert.equal(ok.invoice_id, 'R1');
  assert.throws(() => ii.parseInvoiceExtraction({ content: [{ text: 'kein json' }] }), /JSON/);
  assert.throws(() => ii.parseInvoiceExtraction({ content: [{ text: '{"invoice_id":"x"}' }] }), /invoice_lines/);
});

// ── Ebene 1: buildInvoiceEvents ──────────────────────────────────────────────
test('#163 buildInvoiceEvents: invoice-Event + je Zeile invoice_item, Schlüssel + Summen', () => {
  const events = ii.buildInvoiceEvents(sampleInvoice(), { nowIso: NOW });
  const inv = events.find((e) => e.event_type === 'invoice');
  assert.equal(inv.data.invoice_key, 'INV_R_2026_001');
  assert.equal(inv.data.supplier_key, 'SUP_GROSSHANDEL_MUELLER');
  // total_net = 24*0.5 + 12*0.8 = 12 + 9.6 = 21.6
  assert.equal(inv.data.total_net, 21.6);
  const items = events.filter((e) => e.event_type === 'invoice_item');
  assert.equal(items.length, 2);
  assert.equal(items[0].data.line_number, 1);
  assert.equal(items[0].data.total_net, 12); // 24 * 0.5
  assert.equal(items[1].data.mhd_date, null); // leeres mhd → null
});

// ── Ebene 1: buildProductBatchEvents ─────────────────────────────────────────
test('#163 buildProductBatchEvents: neues Produkt ⇒ product + alias + stock_batch; Kategorie abgeleitet', () => {
  const events = ii.buildProductBatchEvents({
    is_new_product: true, product_key: 'SKU_NEU_COLA', internal_product_name: 'Neu Cola',
    alias_name: 'Neu Cola Alias', mwst_satz: 19, batch_id: 'B_NEU', source_invoice: 'R1',
    initial_qty: 50, remaining_qty: 50, unit_cost: 0.5, mhd: '2027-01-01', purchase_date: '2026-06-01',
  });
  assert.equal(events.find((e) => e.event_type === 'product').data.category, 'getraenk');
  assert.ok(events.find((e) => e.event_type === 'product_alias'));
  const batch = events.find((e) => e.event_type === 'stock_batch');
  assert.equal(batch.data.invoice_key, 'INV_R1');
  assert.equal(batch.data.status, 'active');
});

// ── Ebene 2: Live applyInvoiceEvents (supplier→invoice→items) ────────────────
test('#163 applyInvoiceEvents LIVE: Lieferant + Rechnung + Positionen durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const res = await ii.applyInvoiceEvents(db, 'acme', { invoice: sampleInvoice(), nowIso: NOW });
    assert.equal(res.invoices, 1, 'eine Rechnung');
    assert.equal(res.items, 2, 'zwei Positionen');

    const inv = await db.read({
      tenant: 'acme', tables: ['invoices'],
      text: `SELECT invoice_key, total_net FROM automatenlager.invoices WHERE tenant_id = $1 AND invoice_key = 'INV_R_2026_001'`,
    });
    assert.equal(inv.rows.length, 1);
    assert.equal(Number(inv.rows[0].total_net), 21.6);

    // ISOLATION: globex sieht die Rechnung nicht
    const g = await db.read({
      tenant: 'globex', tables: ['invoices'],
      text: `SELECT count(*)::int AS n FROM automatenlager.invoices WHERE tenant_id = $1 AND invoice_key = 'INV_R_2026_001'`,
    });
    assert.equal(g.rows[0].n, 0, 'globex isoliert');
  });
});

// ── Ebene 2: Live applyProductBatch + invoice_item-Verlinkung ────────────────
test('#163 applyProductBatch LIVE: neues Produkt + Alias + Charge; verlinkt invoice_item.product_id; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // erst Rechnung+Position anlegen (Linking-Ziel)
    await ii.applyInvoiceEvents(db, 'acme', { invoice: sampleInvoice({ invoice_id: 'R-LINK', invoice_lines: [{ source_item: 'X', quantity: 1, unit_cost: 1, mwst_satz: 7 }] }), nowIso: NOW });

    const res = await ii.applyProductBatch(db, 'acme', {
      decision: {
        is_new_product: true, product_key: 'SKU_WF2_ACME', internal_product_name: 'WF2 Neu acme',
        alias_name: 'WF2 Alias acme', mwst_satz: 7, batch_id: 'B_WF2_ACME', source_invoice: 'R-LINK',
        initial_qty: 50, remaining_qty: 50, unit_cost: 0.5, mhd: '2027-01-01', purchase_date: '2026-06-01',
      },
      nowIso: NOW,
    });
    assert.equal(res.products, 1, 'Produkt angelegt');
    assert.equal(res.aliases, 1, 'Alias angelegt');
    assert.equal(res.batches, 1, 'Charge angelegt');

    // Produkt + Charge vorhanden, FK aufgelöst
    const batch = await db.read({
      tenant: 'acme', tables: ['stock_batches', 'products'],
      text: `SELECT sb.remaining_qty, p.product_key FROM automatenlager.stock_batches sb
               JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
              WHERE sb.tenant_id = $1 AND sb.batch_key = 'B_WF2_ACME'`,
    });
    assert.equal(batch.rows.length, 1);
    assert.equal(batch.rows[0].product_key, 'SKU_WF2_ACME');

    // invoice_item der R-LINK-Rechnung wurde verlinkt (product_id gesetzt)
    const linked = await db.read({
      tenant: 'acme', tables: ['invoice_items', 'invoices'],
      text: `SELECT ii.product_id FROM automatenlager.invoice_items ii
               JOIN automatenlager.invoices inv ON inv.invoice_id = ii.invoice_id AND inv.tenant_id = $1
              WHERE ii.tenant_id = $1 AND inv.invoice_key = 'INV_R_LINK'`,
    });
    assert.ok(linked.rows[0].product_id, 'invoice_item.product_id verlinkt');

    // ISOLATION
    const g = await db.read({
      tenant: 'globex', tables: ['products'],
      text: `SELECT count(*)::int AS n FROM automatenlager.products WHERE tenant_id = $1 AND product_key = 'SKU_WF2_ACME'`,
    });
    assert.equal(g.rows[0].n, 0, 'globex sieht das neue Produkt nicht');
  });
});

// ── Ebene 3: Schattenbetrieb invoice_items vs. n8n-Ist ───────────────────────
test('#163 runInvoiceIntakeShadow: Deckungsgleichheit vs. Ist → equal; fehlende Position → ungleich', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // n8n-Ist: Rechnung mit 2 Positionen liegt schon vor.
    await ii.applyInvoiceEvents(db, 'acme', { invoice: sampleInvoice(), nowIso: NOW });

    const same = await ii.runInvoiceIntakeShadow(db, 'acme', { invoice: sampleInvoice(), nowIso: NOW });
    assert.equal(same.equal, true, 'deckungsgleich');

    // Port würde eine 3. Position rechnen, die n8n nicht schrieb → ungleich
    const threeLines = sampleInvoice();
    threeLines.invoice_lines.push({ source_item: 'Extra', quantity: 5, unit_cost: 1, mwst_satz: 7 });
    const diff = await ii.runInvoiceIntakeShadow(db, 'acme', { invoice: threeLines, nowIso: NOW });
    assert.equal(diff.equal, false, 'Diskrepanz erkannt');
    assert.equal(diff.itemsDiff.onlyIntended.length, 1);
  });
});
