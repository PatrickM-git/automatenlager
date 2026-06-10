'use strict';

/**
 * WF1/WF2 Rechnungseingang — In-Process-Port (Issue #163, Stufe 6 Slice 3).
 *
 * WF1: PDF (Drive) → Claude (claude-sonnet-4-6) Rechnungsextraktion → Vorschläge
 *      (product_change_proposals) + Rechnungskopf/-positionen (invoice + invoice_item).
 * WF2: Mensch-im-Loop-Freigabe (Dashboard-Endpunkt) → products / product_aliases /
 *      stock_batches anlegen.
 *
 * Alles **per Mandant durch die Mandanten-Tür** (db.tx, RLS-GUC, explizites tenant_id),
 * faithful zur pgw_write()-Semantik (Pre-Flight-Dump):
 *   invoice       → suppliers (ON CONFLICT supplier_key DO NOTHING) + invoices (ON CONFLICT invoice_key)
 *   invoice_item  → invoice_items (ON CONFLICT (invoice_id, line_number) DO NOTHING)
 *   product       → products (ON CONFLICT product_key DO NOTHING)
 *   product_alias → product_aliases (ON CONFLICT (alias, source) DO NOTHING)
 *   stock_batch   → stock_batches (ON CONFLICT batch_key) + invoice_items-Verlinkung (product_id)
 *
 * Aufbau wie picklist/nayax-sales: reine Builder + apply…() durch die Tür + Schatten-Diff.
 * Externe Grenzen (Drive, Anthropic) injiziert. Trägt KEIN rohes pg (#107-rein).
 */

const { diffWrites, sampleDiff } = require('./shadow-harness.js');
const { inferProductCategory } = require('../product-category.js');

const INVOICE_EXTRACTION_MODEL = 'claude-sonnet-4-6';
const INVOICE_INTAKE_JOB_KEY = 'wf1-invoice-intake';

function clean(v) { return String(v == null ? '' : v).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(); }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function toInvoiceKey(id) {
  return `INV_${String(id || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}
function toSupplierKey(name) {
  return `SUP_${String(name || 'UNKNOWN').toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ẞ/g, 'SS').replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

// ── Reine Logik: Claude-Extraktion (WF1 „Code - Claude Input vorbereiten") ────
const INVOICE_EXTRACTION_PROMPT = [
  'Du bist ein Rechnungsparser für ein Automatenlager. Extrahiere aus der Rechnung ausschliesslich valides JSON. Keine Markdown-Codebloecke, keine Erklaerung.',
  '',
  'Schema:',
  '{"invoice_id":"","supplier":"","purchase_date":"YYYY-MM-DD","invoice_lines":[{"source_item":"","quantity":0,"pack_size":1,"mhd":"YYYY-MM-DD oder leer","unit_cost":0,"mwst_satz":0,"nayax_product_name":"","mdb_code":"","sale_price_eur":""}]}',
  '',
  'Regeln:',
  'purchase_date ist das Rechnungsdatum oder Lieferdatum, wenn kein Rechnungsdatum erkennbar ist.',
  'quantity ist die Anzahl gekaufter verkaufbarer Einheiten/Verkaufspackungen, nicht einzelne Stueck innerhalb einer Packung.',
  'Wenn eine Positionsbezeichnung mehrere Zahlen mit "x" enthaelt, ist die erste Zahl vor dem ersten "x" die quantity.',
  'pack_size ist die Anzahl einzelner Stueck innerhalb einer Verkaufspackung.',
].join('\n');

function buildInvoiceExtractionRequest(fileBase64, mimeType = 'application/pdf') {
  return {
    model: INVOICE_EXTRACTION_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
        { type: 'text', text: INVOICE_EXTRACTION_PROMPT },
      ],
    }],
  };
}

function parseInvoiceExtraction(claudeResponse) {
  const text = ((claudeResponse && claudeResponse.content && claudeResponse.content[0] && claudeResponse.content[0].text) || '').trim();
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); } catch { throw new Error(`Claude lieferte kein gueltiges JSON: ${text.slice(0, 200)}`); }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.invoice_lines)) {
    throw new Error('Rechnungsextraktion ohne invoice_lines-Array');
  }
  return obj;
}

// ── Reine Logik: WF1 „Prepare PGW - Invoice+Items" ───────────────────────────
function buildInvoiceEvents(invoice, { nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const invKey = toInvoiceKey(invoice.invoice_id);
  const supKey = toSupplierKey(invoice.supplier);
  const lines = invoice.invoice_lines || [];
  const totalNet = lines.reduce((s, l) => s + (Number(l.unit_cost) || 0) * (Number(l.quantity) || 0), 0);
  const vatRate = lines[0] ? (Number(lines[0].mwst_satz) || 7) : 7;
  const totalVat = r2(totalNet * vatRate / 100);
  const totalGross = r2(totalNet + totalVat);

  const events = [{
    event_type: 'invoice',
    data: {
      invoice_key: invKey,
      supplier_key: supKey,
      supplier_name: invoice.supplier || '',
      invoice_number: invoice.invoice_id || '',
      invoice_date: invoice.purchase_date || at.slice(0, 10),
      total_gross: totalGross,
      total_net: r2(totalNet),
      vat_total: totalVat,
      source_pdf_path: invoice.drive_file_name || null,
      claude_extraction_json: invoice,
    },
  }];
  lines.forEach((line, idx) => {
    const unitCost = Number(line.unit_cost) || 0;
    const qty = Number(line.quantity) || 1;
    events.push({
      event_type: 'invoice_item',
      data: {
        invoice_key: invKey,
        line_number: idx + 1,
        description_raw: line.source_item || line.nayax_product_name || '',
        quantity: qty,
        unit_price_net: unitCost,
        total_net: r2(unitCost * qty),
        vat_rate_pct: Number(line.mwst_satz) || 7,
        mhd_date: line.mhd || null,
      },
    });
  });
  return events;
}

// ── Reine Logik: WF2 „Prepare PGW - Product+Batch" (Freigabe-Entscheidung) ────
function buildProductBatchEvents(decision = {}) {
  const events = [];
  if (decision.is_new_product) {
    events.push({
      event_type: 'product',
      data: {
        product_key: decision.product_key,
        name: decision.internal_product_name || decision.nayax_product_name || decision.product_name || decision.product_key,
        category: inferProductCategory(decision.internal_product_name, decision.nayax_product_name, decision.product_name, decision.alias_name),
        vat_rate_pct: Number(decision.mwst_satz) || 7,
        unit_of_measure: 'stück',
      },
    });
  }
  if (decision.alias_name) {
    events.push({
      event_type: 'product_alias',
      data: { product_key: decision.product_key, alias: decision.alias_name, source: 'Rechnungseingang_Smart_Selection', is_primary: false },
    });
  }
  events.push({
    event_type: 'stock_batch',
    data: {
      batch_key: decision.batch_id,
      product_key: decision.product_key,
      invoice_key: decision.source_invoice ? toInvoiceKey(decision.source_invoice) : null,
      initial_qty: Number(decision.initial_qty) || 0,
      remaining_qty: Number(decision.remaining_qty) || 0,
      unit_cost_net: Number(decision.unit_cost) || 0,
      mhd_date: decision.mhd || null,
      status: 'active',
      received_at: decision.purchase_date || new Date().toISOString().slice(0, 10),
      purchase_date: decision.purchase_date || null,
    },
  });
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O durch die Tür (faithful zu pgw_write). tenant_id explizit, RLS-GUC.
// ─────────────────────────────────────────────────────────────────────────────
const SUPPLIER_UPSERT_SQL = `
  INSERT INTO automatenlager.suppliers (supplier_key, name, notes, tenant_id)
  VALUES ($2, $3, $4, $1) ON CONFLICT (tenant_id, supplier_key) DO NOTHING`;
const INVOICE_INSERT_SQL = `
  INSERT INTO automatenlager.invoices
    (invoice_key, supplier_id, invoice_number, invoice_date, total_gross, total_net, vat_total, source_pdf_path, claude_extraction_json, tenant_id)
  SELECT $2, s.supplier_id, $4, $5::date, $6::numeric, $7::numeric, $8::numeric, $9, $10::jsonb, $1
    FROM automatenlager.suppliers s WHERE s.supplier_key = $3 AND s.tenant_id = $1 LIMIT 1
  ON CONFLICT (tenant_id, invoice_key) DO NOTHING`;
const INVOICE_ITEM_INSERT_SQL = `
  INSERT INTO automatenlager.invoice_items
    (invoice_id, line_number, description_raw, quantity, unit_price_net, total_net, vat_rate_pct, mhd_date, tenant_id)
  SELECT inv.invoice_id, $3::integer, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::date, $1
    FROM automatenlager.invoices inv WHERE inv.invoice_key = $2 AND inv.tenant_id = $1 LIMIT 1
  ON CONFLICT (tenant_id, invoice_id, line_number) DO NOTHING`;
const PRODUCT_INSERT_SQL = `
  INSERT INTO automatenlager.products (product_key, name, category, vat_rate_pct, unit_of_measure, tenant_id)
  VALUES ($2, $3, $4, $5::numeric, $6, $1) ON CONFLICT (tenant_id, product_key) DO NOTHING`;
const PRODUCT_ALIAS_INSERT_SQL = `
  INSERT INTO automatenlager.product_aliases (product_id, alias, source, is_primary, tenant_id)
  SELECT p.product_id, $3, $4, COALESCE($5::boolean, FALSE), $1
    FROM automatenlager.products p WHERE p.product_key = $2 AND p.tenant_id = $1 LIMIT 1
  ON CONFLICT (tenant_id, alias, source) DO NOTHING`;
const STOCK_BATCH_INSERT_SQL = `
  INSERT INTO automatenlager.stock_batches
    (batch_key, product_id, invoice_item_id, initial_qty, remaining_qty, unit_cost_net, mhd_date, status, received_at, tenant_id)
  SELECT $2, p.product_id, $4::bigint, $5::integer, $6::integer, $7::numeric, $8::date, $9, $10::date, $1
    FROM automatenlager.products p WHERE p.product_key = $3 AND p.tenant_id = $1 LIMIT 1
  ON CONFLICT (tenant_id, batch_key) DO NOTHING`;

/** WF1: Rechnungskopf + Positionen durch die Tür (supplier→invoice→items). */
async function applyInvoiceEvents(db, tenant, { invoice, events, nowIso } = {}) {
  const evs = events || buildInvoiceEvents(invoice, { nowIso });
  return db.tx(tenant, async (door) => {
    let invoices = 0; let items = 0;
    for (const ev of evs) {
      const d = ev.data;
      if (ev.event_type === 'invoice') {
        await door.write({ tables: ['suppliers'], text: SUPPLIER_UPSERT_SQL, params: [d.supplier_key, d.supplier_name, null] });
        const r = await door.write({
          tables: ['invoices', 'suppliers'], text: INVOICE_INSERT_SQL,
          params: [d.invoice_key, d.supplier_key, d.invoice_number, d.invoice_date, d.total_gross, d.total_net, d.vat_total, d.source_pdf_path, JSON.stringify(d.claude_extraction_json || {})],
        });
        invoices += (r.rowCount || 0);
      } else if (ev.event_type === 'invoice_item') {
        const r = await door.write({
          tables: ['invoice_items', 'invoices'], text: INVOICE_ITEM_INSERT_SQL,
          params: [d.invoice_key, d.line_number, d.description_raw, d.quantity, d.unit_price_net, d.total_net, d.vat_rate_pct, d.mhd_date],
        });
        items += (r.rowCount || 0);
      }
    }
    return { invoices, items };
  });
}

/** WF2-Freigabe: Produkt (optional) + Alias + Lagercharge durch die Tür. */
async function applyProductBatch(db, tenant, { decision, events, nowIso } = {}) {
  const evs = events || buildProductBatchEvents(decision);
  return db.tx(tenant, async (door) => {
    let products = 0; let aliases = 0; let batches = 0;
    for (const ev of evs) {
      const d = ev.data;
      if (ev.event_type === 'product') {
        const r = await door.write({ tables: ['products'], text: PRODUCT_INSERT_SQL, params: [d.product_key, d.name, d.category, d.vat_rate_pct, d.unit_of_measure] });
        products += (r.rowCount || 0);
      } else if (ev.event_type === 'product_alias') {
        const r = await door.write({ tables: ['product_aliases', 'products'], text: PRODUCT_ALIAS_INSERT_SQL, params: [d.product_key, d.alias, d.source, d.is_primary] });
        aliases += (r.rowCount || 0);
      } else if (ev.event_type === 'stock_batch') {
        // invoice_item-Verlinkung (faithful zu pgw): erste unverlinkte Zeile der Rechnung
        // → product_id setzen; sonst NULL. Sequenziell (ein tx-Client).
        let invoiceItemId = null;
        if (d.invoice_key) {
          const link = await door.read({
            tables: ['invoice_items', 'invoices'],
            text: `SELECT ii.invoice_item_id FROM automatenlager.invoice_items ii
                     JOIN automatenlager.invoices inv ON ii.invoice_id = inv.invoice_id AND inv.tenant_id = $1
                    WHERE inv.invoice_key = $2 AND ii.tenant_id = $1 AND ii.product_id IS NULL
                    ORDER BY ii.line_number LIMIT 1`,
            params: [d.invoice_key],
          });
          invoiceItemId = link.rows[0] ? link.rows[0].invoice_item_id : null;
          if (invoiceItemId) {
            await door.write({
              tables: ['invoice_items', 'products'],
              text: `UPDATE automatenlager.invoice_items ii
                        SET product_id = p.product_id
                       FROM automatenlager.products p
                      WHERE ii.invoice_item_id = $2 AND ii.tenant_id = $1 AND ii.product_id IS NULL
                        AND p.product_key = $3 AND p.tenant_id = $1`,
              params: [invoiceItemId, d.product_key],
            });
          }
        }
        const r = await door.write({
          tables: ['stock_batches', 'products'], text: STOCK_BATCH_INSERT_SQL,
          params: [d.batch_key, d.product_key, invoiceItemId, d.initial_qty, d.remaining_qty, d.unit_cost_net, d.mhd_date, d.status, d.received_at],
        });
        batches += (r.rowCount || 0);
      }
    }
    return { products, aliases, batches };
  });
}

// ── Schattenbetrieb: beabsichtigte invoice_item-Writes vs. n8n-Ist ───────────
const ACTUAL_INVOICE_ITEMS_SQL = `
  SELECT inv.invoice_key, ii.line_number, ii.quantity
    FROM automatenlager.invoice_items ii
    JOIN automatenlager.invoices inv ON ii.invoice_id = inv.invoice_id AND inv.tenant_id = $1
   WHERE ii.tenant_id = $1 AND inv.invoice_key = $2`;

async function runInvoiceIntakeShadow(db, tenant, { invoice, nowIso } = {}) {
  const events = buildInvoiceEvents(invoice, { nowIso });
  const invKey = toInvoiceKey(invoice.invoice_id);
  const intendedItems = events.filter((e) => e.event_type === 'invoice_item')
    .map((e) => ({ invoice_key: e.data.invoice_key, line_number: e.data.line_number, quantity: e.data.quantity }));
  const door = db.forTenant(tenant);
  const actual = await door.read({ tables: ['invoice_items', 'invoices'], text: ACTUAL_INVOICE_ITEMS_SQL, params: [invKey] });
  // quantity ist NUMERIC (pg liefert String) → für den strukturellen Vergleich auf Zahl normalisieren.
  const actualItems = actual.rows.map((r) => ({ invoice_key: r.invoice_key, line_number: Number(r.line_number), quantity: Number(r.quantity) }));
  const itemsDiff = diffWrites(intendedItems, actualItems, {
    keyOf: (r) => `${r.invoice_key}#${r.line_number}`,
    fields: ['quantity'],
  });
  return { equal: itemsDiff.equal, itemsDiff, intendedItems, events };
}

function isCutover(env) {
  const v = String((env && env.WF1_CUTOVER) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * WF1-Worker-Factory (Drive-getrieben, wie WF9). Pollt neue Rechnungs-PDFs,
 * extrahiert via Claude, und läuft DEFAULT im Schattenbetrieb (rechnet invoice_items,
 * vergleicht gegen Ist, schreibt NICHT). Cutover via WF1_CUTOVER=1 (dann durch die Tür).
 * Ohne Drive/Anthropic ⇒ disabled (bricht nichts). Ein Drive-Account = ein Mandant.
 * @returns {{key:string, disabled:boolean, run:()=>Promise<any>}}
 */
function createInvoiceIntakeJob({ db, drive, anthropic, env = process.env } = {}) {
  if (!db || !drive || !anthropic) {
    return { key: INVOICE_INTAKE_JOB_KEY, disabled: true, run: async () => ({ skipped: 'no_drive_or_anthropic' }) };
  }
  return {
    key: INVOICE_INTAKE_JOB_KEY,
    disabled: false,
    run: async () => {
      const tenant = clean(env.WF1_TENANT_ID || env.NAYAX_TENANT_ID);
      if (!tenant) return { skipped: 'kein eindeutiger Mandant (WF1_TENANT_ID setzen)' };
      const files = (typeof drive.listNew === 'function') ? await drive.listNew() : [];
      const cutover = isCutover(env);
      let processed = 0; const results = [];
      let allEqual = true; let firstDiffSample = null; // Aggregat für den Cutover-Wächter
      for (const f of files) {
        const { base64, mimeType } = await drive.download(f.id);
        const resp = await anthropic.createMessage(buildInvoiceExtractionRequest(base64, mimeType));
        const invoice = parseInvoiceExtraction(resp);
        invoice.drive_file_name = invoice.drive_file_name || f.name;
        if (cutover) {
          const r = await applyInvoiceEvents(db, tenant, { invoice });
          if (typeof drive.move === 'function') await drive.move(f.id);
          results.push({ mode: 'cutover', file: f.name, ...r });
        } else {
          const shadow = await runInvoiceIntakeShadow(db, tenant, { invoice });
          if (!shadow.equal) {
            allEqual = false;
            if (!firstDiffSample) firstDiffSample = { file: f.name, items: sampleDiff(shadow.itemsDiff, { keyOf: (r) => `${r.invoice_key}#${r.line_number}` }) };
          }
          results.push({ mode: 'shadow', file: f.name, equal: shadow.equal });
        }
        processed += 1;
      }
      if (cutover) return { mode: 'cutover', tenant, processed, results };
      // Schatten-Aggregat: equal nur wenn ALLE Dateien deckungsgleich; processed=0 ⇒ keine Aktivität.
      return { mode: 'shadow', tenant, processed, equal: allEqual, diffSample: firstDiffSample ? { items: firstDiffSample.items, file: firstDiffSample.file } : null, results };
    },
  };
}

module.exports = {
  INVOICE_EXTRACTION_MODEL,
  INVOICE_INTAKE_JOB_KEY,
  createInvoiceIntakeJob,
  toInvoiceKey,
  toSupplierKey,
  buildInvoiceExtractionRequest,
  parseInvoiceExtraction,
  buildInvoiceEvents,
  buildProductBatchEvents,
  applyInvoiceEvents,
  applyProductBatch,
  runInvoiceIntakeShadow,
};
