'use strict';

/**
 * WF9 Pickliste — In-Process-Port (Issue #162, Stufe 6 Slice 2).
 *
 * Drive→Claude-OCR→Slot-Verteilung→Warnungen→stock_movement. Im Kern wie WF7,
 * aber: mehrere Produkte aus einer OCR'ten PDF, Match über `nayax_product_name`,
 * Backstock-begrenzte Verteilung über aktive Slots (Kapazitäts-Cap), Movement-Typ
 * `pick` mit `quantity_delta_total = -delta` (Pick reduziert den Gesamtbestand —
 * verhaltensgetreu zur Mini-WF9, abweichend vom WF7-Refill mit delta_total 0).
 *
 * Externe Grenzen (Drive, Anthropic) werden injiziert (Tests faken sie). Der
 * Schreibpfad läuft durch die Mandanten-Tür (db.tx, explizites tenant_id, RLS-sauber).
 * Idempotenz primär über den Drive-„verarbeitet"-Move + ON CONFLICT(movement_key).
 */

const { isAvailableBatchStatus, availableBatchStatusSqlList } = require('../stock-status.js');

const PICKLIST_OCR_MODEL = 'claude-haiku-4-5-20251001';
const PICKLIST_JOB_KEY = 'wf9-pickliste';
const RESOLVABLE_WARNING_TYPES = ['EMPTY_BATCH', 'LOW_STOCK', 'INSUFFICIENT_BATCH_STOCK', 'LOW_BATCH'];

function clean(v) { return String(v == null ? '' : v).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(); }
function num(v) { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function sanitize(v) { return clean(v).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

/** FIFO-Charge (WF9-Shape: batch_id/mhd) für einen product_key. */
function fifoBatch(batches, productKey) {
  const pk = clean(productKey);
  return (batches || [])
    .filter((b) => clean(b.product_key) === pk)
    .filter((b) => isAvailableBatchStatus(b.status))
    .filter((b) => (num(b.remaining_qty) ?? 0) > 0)
    .sort((a, b) => clean(a.mhd).localeCompare(clean(b.mhd)) || clean(a.batch_id).localeCompare(clean(b.batch_id)))[0] || null;
}

/** Reine Logik: Claude-OCR-Antwort → Items-Array [{name, pick}]. */
function parsePicklistItems(claudeResponse) {
  const text = ((claudeResponse && claudeResponse.content && claudeResponse.content[0] && claudeResponse.content[0].text) || '').trim();
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let items;
  try { items = JSON.parse(cleaned); } catch { throw new Error(`Claude lieferte kein gueltiges JSON: ${text.slice(0, 200)}`); }
  if (!Array.isArray(items)) throw new Error('Keine Array-Antwort von Claude');
  return items;
}

/** Reine Logik: Anthropic-Request-Body für die PDF-OCR. */
function buildPicklistOcrRequest(fileBase64, mimeType = 'application/pdf') {
  return {
    model: PICKLIST_OCR_MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
        { type: 'text', text: 'Extrahiere die Pickliste als JSON-Array [{"name": <Produktname>, "pick": <Menge als Zahl>}]. Antworte AUSSCHLIESSLICH mit dem JSON-Array, ohne Erklaerung, ohne Markdown.' },
      ],
    }],
  };
}

/**
 * Reine Logik: aus OCR-Items + Produkten (mit nayax_product_name) + Chargen den
 * Schreibplan ableiten. Backstock-begrenzt, Kapazitäts-Cap, Verteilung über Slots.
 */
function computePickPlan({ items = [], products = [], batches = [], nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const dateStr = at.slice(0, 10);

  const remainingByKey = {};
  for (const b of batches) {
    if (!isAvailableBatchStatus(b.status)) continue;
    const qty = num(b.remaining_qty);
    if (!qty || qty <= 0) continue;
    const pk = clean(b.product_key);
    remainingByKey[pk] = (remainingByKey[pk] || 0) + qty;
  }

  const slotUpdates = []; const stockMovements = []; const resolve = new Set(); const notFound = [];
  let movSeq = 0;
  for (const item of items) {
    const name = clean(item.name); const pickQty = num(item.pick);
    if (!name || !pickQty || pickQty <= 0) continue;
    const slots = products.filter((p) => clean(p.nayax_product_name) === name);
    if (!slots.length) { notFound.push(name); continue; }
    const pk = clean(slots[0].product_key);
    const totalRemaining = remainingByKey[pk] || 0;
    const currentInMachine = slots.reduce((s, x) => s + (num(x.current_machine_qty) || 0), 0);
    const availableFill = Math.max(0, totalRemaining - currentInMachine);
    let effective = Math.min(pickQty, availableFill);
    const batch = fifoBatch(batches, pk);
    for (const slot of slots) {
      if (effective <= 0) break;
      const slotCurrent = num(slot.current_machine_qty) || 0;
      const capacity = num(slot.machine_capacity) || 999;
      const room = Math.max(0, capacity - slotCurrent);
      const fill = Math.min(room, effective);
      if (fill <= 0) continue;
      effective -= fill;
      const slotKey = clean(slot.product_slot_id);
      slotUpdates.push({ product_slot_key: slotKey, current_machine_qty: slotCurrent + fill, product_key: pk });
      if (batch) {
        const movementKey = ['MOV', 'PICK', slotKey, batch.batch_id, dateStr, fill, movSeq++].map(sanitize).join('_');
        stockMovements.push({
          event_type: 'stock_movement',
          batch_run_id: `wf9_${dateStr}`,
          data: {
            movement_key: movementKey,
            batch_key: clean(batch.batch_id),
            product_slot_key: slotKey,
            movement_type: 'pick',
            quantity_delta_total: -fill,
            quantity_delta_slot: fill,
            reason: 'Pickliste verarbeitet',
            source: 'wf9_pickliste',
            occurred_at: at,
          },
        });
      }
      resolve.add(pk);
    }
  }
  return { slotUpdates, stockMovements, resolveProductKeys: [...resolve], notFound };
}

const PRODUCT_READ_SQL = `
  SELECT sa.product_slot_key AS product_slot_id, sa.current_machine_qty, sa.machine_capacity,
         p.product_key, sa.product_id, COALESCE(na.alias, '') AS nayax_product_name
    FROM automatenlager.slot_assignments sa
    JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
    LEFT JOIN LATERAL (
      SELECT pa.alias FROM automatenlager.product_aliases pa
       WHERE pa.product_id = p.product_id AND pa.tenant_id = sa.tenant_id
         AND pa.source = 'nayax' AND pa.is_primary = TRUE
       ORDER BY pa.alias LIMIT 1) na ON TRUE
   WHERE sa.tenant_id = $1 AND sa.active = TRUE`;

function batchReadSql() {
  return `
  SELECT sb.batch_key AS batch_id, p.product_key, sb.remaining_qty,
         to_char(sb.mhd_date, 'YYYY-MM-DD') AS mhd, sb.status
    FROM automatenlager.stock_batches sb
    JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
   WHERE sb.tenant_id = $1 AND sb.status IN (${availableBatchStatusSqlList()}) AND sb.remaining_qty > 0`;
}

/** Pickliste-Items durch die Tür anwenden (Slot-Updates + pick-Movements + Warnungen-resolve). */
async function applyPicklist(db, tenant, { items = [], fileName = '', nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  return db.tx(tenant, async (door) => {
    // Sequenziell (Sandbox teilt einen Client — kein Promise.all).
    const prod = await door.read({ tables: ['slot_assignments', 'products', 'product_aliases'], text: PRODUCT_READ_SQL });
    const batch = await door.read({ tables: ['stock_batches', 'products'], text: batchReadSql() });
    const plan = computePickPlan({ items, products: prod.rows, batches: batch.rows, nowIso: at });

    for (const u of plan.slotUpdates) {
      await door.write({
        tables: ['slot_assignments'],
        text: `UPDATE automatenlager.slot_assignments SET current_machine_qty = $2 WHERE tenant_id = $1 AND product_slot_key = $3`,
        params: [u.current_machine_qty, u.product_slot_key],
      });
    }
    let movements = 0;
    for (const m of plan.stockMovements) {
      const d = m.data;
      const r = await door.write({
        tables: ['stock_movements'],
        text: `INSERT INTO automatenlager.stock_movements
                 (movement_key, batch_id, slot_assignment_id, movement_type,
                  quantity_delta_total, quantity_delta_slot, reason, source, occurred_at, tenant_id)
               SELECT $2, sb.batch_id, sa.slot_assignment_id, $5, $6::integer, $7::integer, $8, $9, $10::timestamptz, $1
                 FROM automatenlager.stock_batches sb
                 LEFT JOIN automatenlager.slot_assignments sa ON sa.product_slot_key = $4 AND sa.tenant_id = $1
                WHERE sb.batch_key = $3 AND sb.tenant_id = $1
                LIMIT 1
               ON CONFLICT (movement_key) DO NOTHING`,
        params: [d.movement_key, d.batch_key, d.product_slot_key, d.movement_type,
          d.quantity_delta_total, d.quantity_delta_slot, d.reason, d.source, d.occurred_at],
      });
      movements += (r.rowCount || 0);
    }
    if (plan.resolveProductKeys.length) {
      await door.write({
        tables: ['warnings', 'products'],
        text: `UPDATE automatenlager.warnings
                  SET resolved = TRUE, resolved_at = NOW(), resolved_by = 'wf9'
                WHERE tenant_id = $1 AND resolved = FALSE AND warning_type = ANY($2)
                  AND product_id IN (SELECT product_id FROM automatenlager.products
                                      WHERE tenant_id = $1 AND product_key = ANY($3))`,
        params: [RESOLVABLE_WARNING_TYPES, plan.resolveProductKeys],
      });
    }
    return { slots_updated: plan.slotUpdates.length, movements, not_found: plan.notFound };
  });
}

/** Orchestrierung: eine Drive-Datei OCR'en + anwenden + (nach Erfolg) verschieben. */
async function processPicklistFile(db, tenant, { fileId, fileName, drive, anthropic, nowIso, applyImpl } = {}) {
  if (!drive || typeof drive.download !== 'function' || !anthropic || typeof anthropic.createMessage !== 'function') {
    return { ok: false, skipped: 'no_drive_or_anthropic' };
  }
  const { base64, mimeType } = await drive.download(fileId);
  const resp = await anthropic.createMessage(buildPicklistOcrRequest(base64, mimeType));
  const items = parsePicklistItems(resp);
  const apply = typeof applyImpl === 'function' ? applyImpl : applyPicklist;
  const result = await apply(db, tenant, { items, fileName, nowIso });
  if (typeof drive.move === 'function') await drive.move(fileId); // Idempotenz: in „verarbeitet" verschieben
  return { ok: true, fileId, fileName, items: items.length, ...result };
}

/**
 * Worker-Factory. WF9 ist Drive-getrieben; ohne Drive-Client (kein OAuth in .env.local)
 * ⇒ disabled (Job läuft nicht, bricht aber nichts). Mit Drive: pollt neue Dateien.
 */
function createPicklistPollJob({ tenantRunner, drive, anthropic, env = process.env } = {}) {
  if (!drive || !anthropic) {
    return { key: PICKLIST_JOB_KEY, disabled: true, run: async () => ({ skipped: 'no_drive' }) };
  }
  return {
    key: PICKLIST_JOB_KEY,
    disabled: false,
    run: async () => {
      const files = (typeof drive.listNew === 'function') ? await drive.listNew() : [];
      let processed = 0;
      for (const f of files) {
        // Mandanten-Auflösung (Drive-Ordner→Mandant) ist deploy-spezifisch; Default: NAYAX_TENANT_ID.
        const tenant = clean(env.WF9_TENANT_ID || env.NAYAX_TENANT_ID);
        if (!tenant) continue;
        await processPicklistFile(tenantRunner ? tenantRunner.db : null, tenant, { fileId: f.id, fileName: f.name, drive, anthropic });
        processed += 1;
      }
      return { processed };
    },
  };
}

module.exports = {
  PICKLIST_OCR_MODEL,
  PICKLIST_JOB_KEY,
  RESOLVABLE_WARNING_TYPES,
  parsePicklistItems,
  buildPicklistOcrRequest,
  computePickPlan,
  applyPicklist,
  processPicklistFile,
  createPicklistPollJob,
};
