'use strict';

/**
 * WF3 Nayax-Verkäufe (FIFO Lagerbestand) — In-Process-Port (Issue #163, Stufe 6 Slice 3).
 *
 * Datenkritische Ingestion: Verkäufe von Nayax holen → FIFO-Abbuchung über
 * stock_batches (nach MHD) → sales_transactions + stock_movements + Warnungen →
 * Watermark (workflow_state). Verhaltensgetreu aus der authoritativen Mini-WF3
 * portiert ("Normalize Sales", "Code - FIFO berechnen", "Prepare PGW - sale",
 * "Prepare PGW - stock_movement", Watermark "letzter Verkaufsworkflow").
 *
 * Aufbau (wie picklist.js / alert-digest.js — reine Logik von I/O getrennt):
 *   - normalizeSales / computeFifoPlan : REIN, kein I/O, unit-getestet.
 *   - applyNayaxSales(db, tenant, opts): durch die Mandanten-Tür (db.tx, RLS-GUC).
 *   - runNayaxSalesShadow(...)         : compute-only, vergleicht gegen n8n-Ist.
 *
 * EVENT-SEMANTIK (verifiziert aus dem Pre-Flight-Dump,
 * docs/data-model/pgw-write-und-workflow-runs-preflight.md):
 *   sale           → sales_transactions  ON CONFLICT (nayax_transaction_id) DO NOTHING
 *   stock_movement → stock_movements     ON CONFLICT (movement_key)         DO NOTHING
 * Im Port mit gesetztem GUC + tenant_id (RLS-Backstop) statt mandantenblind.
 */

const { isAvailableBatchStatus, availableBatchStatusSqlList } = require('../stock-status.js');
const { diffWrites, sampleDiff } = require('./shadow-harness.js');
const { toAllowedWarningType } = require('../warning-types.js');
const { withTimeout } = require('../fetch-timeout.js');

const NAYAX_SALES_JOB_KEY = 'wf3-nayax-fifo';
const WORKFLOW_STATE_KEY = 'WF3_NAYAX_FIFO';
const DEPLETED_BATCH_STATUS = 'leer'; // Markierung bei remaining ≤ 0 (vgl. apply_stock_movement-Trigger)

// ─────────────────────────────────────────────────────────────────────────────
// Reine Helfer (verhaltensgetreu aus WF3 "Code - FIFO berechnen")
// ─────────────────────────────────────────────────────────────────────────────

function clean(value) {
  return String(value == null ? '' : value).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ungültige Datumswerte dürfen den Lauf nicht killen (WF3-Crash 2026-06-05).
function safeDate(value, fallback) {
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) return d;
  return fallback instanceof Date ? fallback : new Date(fallback || 0);
}

function firstNonEmpty(...values) {
  return values.map(clean).find((value) => value !== '') || '';
}

function normalizeName(value) {
  return clean(value).toLowerCase()
    .replace(/&/g, 'und')
    .replace(/\+/g, 'plus')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

function generateProductKey(name) {
  const base = clean(name).toUpperCase()
    .replace(/Ä/g, 'AE')
    .replace(/Ö/g, 'OE')
    .replace(/Ü/g, 'UE')
    .replace(/ẞ/g, 'SS')
    .replace(/ß/g, 'SS')
    .replace(/&/g, 'UND')
    .replace(/\+/g, 'PLUS')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `SKU_${base || 'UNBEKANNT'}`;
}

function parseProductName(raw) {
  const text = clean(raw);
  const match = text.match(/^(.*?)\s*\((\d+)\s*(?:=|\s+)\s*([0-9]+(?:[.,][0-9]+)?)\s*\)/);
  return {
    raw,
    label: match ? clean(match[1]) : text,
    mdb_code: match ? String(match[2]) : '',
    price: match ? String(match[3]).replace(',', '.') : '',
  };
}

function productName(product) {
  return clean(product.nayax_product_name || product.internal_product_name || product.product_key);
}

function namesMatch(a, b) {
  const aa = normalizeName(a);
  const bb = normalizeName(b);
  if (!aa || !bb) return false;
  if (aa === bb) return true;
  if (aa.length >= 8 && bb.includes(aa)) return true;
  if (bb.length >= 8 && aa.includes(bb)) return true;
  return false;
}

function isActiveProduct(p) {
  return clean(p.active).toUpperCase() === 'TRUE' && !clean(p.valid_to) && !clean(p.valid_to_datetime);
}

// product_slot_id Format: PS_<mainMachineId>_<mdb>_<sku>_<ts>
function getMainMachineFromSlot(p) {
  const m = clean(p.product_slot_id).match(/^PS_(\d+)_/);
  return m ? m[1] : '';
}

function saleDate(sale) {
  return safeDate(sale.SettlementDateTimeGMT || sale.MachineAuthorizationTime || sale.AuthorizationDateTimeGMT || 0, 0);
}

function saleDatetime(sale) {
  return clean(sale.SettlementDateTimeGMT || sale.MachineAuthorizationTime || sale.AuthorizationDateTimeGMT || '');
}

function getMdbCode(sale, parsed) {
  return firstNonEmpty(
    sale.mdb_code_extracted, sale.mdb_code, sale.MDBCode, sale.MdbCode,
    sale.MDB_CODE, sale.MDB, sale.ProductMDBCode, sale.ProductMdbCode, parsed.mdb_code,
  );
}

function getSoldQty(sale, config) {
  const multivendQty = Number(sale.MultivendNumverOfProducts ?? sale.MultivendNumberOfProducts ?? 0);
  return multivendQty > 0 ? multivendQty : Number(config.default_quantity_per_sale ?? 1);
}

function sortByMhd(a, b) {
  const aDate = clean(a.mhd) ? new Date(a.mhd) : new Date('9999-12-31');
  const bDate = clean(b.mhd) ? new Date(b.mhd) : new Date('9999-12-31');
  return aDate - bDate;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeSales — WF3 "Normalize Sales": Array / {body:[…]} / Einzelobjekt → flach
// ─────────────────────────────────────────────────────────────────────────────
function normalizeSales(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const sales = [];
  for (const raw of items) {
    const data = raw && raw.json !== undefined ? raw.json : raw;
    if (Array.isArray(data)) sales.push(...data);
    else if (data && Array.isArray(data.body)) sales.push(...data.body);
    else if (data != null) sales.push(data);
  }
  return sales;
}

// ─────────────────────────────────────────────────────────────────────────────
// computeFifoPlan — Kern (REIN). Bekommt alles injiziert, schreibt NICHTS.
// Liefert die BEABSICHTIGTEN Writes (sale + stock_movement), Warnungen,
// Charge-/Slot-Updates, Produktwechsel-Vorschläge, Watermark, Summary.
// ─────────────────────────────────────────────────────────────────────────────
function computeFifoPlan({ sales = [], products = [], batches = [], processedTxIds = [], workflowState = null, config = {}, nowIso } = {}) {
  const now = nowIso || new Date().toISOString();
  const cfg = config || {};
  const cutoverDate = safeDate(cfg.inventory_cutover_datetime, '2026-05-02T10:00:00.000Z');
  const warningDays = Number(cfg.mhd_warning_days ?? 14);

  const processed = new Set((processedTxIds || []).map((id) => clean(id)).filter(Boolean));
  const batchMap = new Map((batches || []).map((b) => [String(b.batch_id), { ...b }]));
  const originalBatches = (batches || []).map((b) => ({ ...b }));
  const productQtyUpdates = new Map();
  const transactionLogs = [];
  const warnings = [];
  const productChangeSuggestions = [];

  const lastSuccessfulSaleDate = safeDate(
    clean(workflowState && workflowState.last_inventory_review_at)
      || cfg.inventory_cutover_datetime
      || '1970-01-01T00:00:00.000Z',
    cutoverDate,
  );
  let maxProcessedSaleDate = lastSuccessfulSaleDate;

  function activeProductsForMachine(machineId) {
    const target = clean(machineId);
    return products.filter((p) => {
      if (!isActiveProduct(p)) return false;
      const productMachine = clean(p.machine_id);
      return getMainMachineFromSlot(p) === target || productMachine === target || productMachine === '';
    });
  }

  function findProductByName(machineId, label, mdbCode) {
    const candidates = activeProductsForMachine(machineId).filter((p) => namesMatch(productName(p), label));
    if (!candidates.length) return null;
    const exactNorm = normalizeName(label);
    const exact = candidates.filter((p) => normalizeName(productName(p)) === exactNorm);
    const pool = exact.length ? exact : candidates;
    if (mdbCode) {
      const sameMdb = pool.find((p) => clean(p.mdb_code) === clean(mdbCode));
      if (sameMdb) return sameMdb;
    }
    return pool[0];
  }

  function getProductForSale(sale) {
    const parsed = parseProductName(sale.ProductName);
    const machineId = clean(sale.MachineID || cfg.machine_id);
    const mdbCode = getMdbCode(sale, parsed);
    const product = findProductByName(machineId, parsed.label, mdbCode);
    if (!product) return { product: null, parsed, mdbCode, expectedMdb: '', reason: 'UNKNOWN_PRODUCT' };
    const expectedMdb = clean(product.mdb_code);
    if (!mdbCode) return { product, parsed, mdbCode, expectedMdb, reason: 'MDB_CODE_MISSING_CONTROL' };
    if (!expectedMdb) return { product, parsed, mdbCode, expectedMdb, reason: 'MDB_EXPECTED_CODE_MISSING' };
    if (expectedMdb !== mdbCode) {
      const productOnActualMdb = activeProductsForMachine(machineId).find((p) => clean(p.mdb_code) === mdbCode);
      const sameProductOnActualMdb = productOnActualMdb && clean(productOnActualMdb.product_key) === clean(product.product_key);
      if (sameProductOnActualMdb) {
        return { product: productOnActualMdb, parsed, mdbCode, expectedMdb, productOnActualMdb, reason: 'OK' };
      }
      const differentProductOnActualMdb = productOnActualMdb && clean(productOnActualMdb.product_key) !== clean(product.product_key);
      return {
        product, parsed, mdbCode, expectedMdb, productOnActualMdb,
        reason: differentProductOnActualMdb ? 'MDB_PRODUCT_MAPPING_MISMATCH' : 'MDB_CODE_CHANGED_FOR_PRODUCT',
      };
    }
    return { product, parsed, mdbCode, expectedMdb, reason: 'OK' };
  }

  function queueProductQtyDeduction(product, machineId, mdbCode, soldQty, lagerRemaining) {
    const key = clean(product.product_slot_id)
      || [clean(machineId), clean(mdbCode || product.mdb_code), clean(product.product_key)].join('|');
    let currentQty = Number(String(product.current_machine_qty ?? '').replace(',', '.'));
    if (!Number.isFinite(currentQty)) {
      warnings.push({
        created_at: now, type: 'CURRENT_MACHINE_QTY_MISSING', severity: 'warning',
        machine_id: machineId, product_key: clean(product.product_key), nayax_product_name: productName(product),
        message: `current_machine_qty fehlt oder ist ungueltig fuer ${productName(product)}. Maschinenbestand wurde nicht aktualisiert.`,
        resolved: 'FALSE',
      });
      return;
    }
    const existing = productQtyUpdates.get(key);
    const capacity = Number(product.machine_capacity) || 0;
    const lagerR = Number(lagerRemaining ?? 0);
    let autoRefillApplied = false;
    if (!existing && currentQty <= 0 && capacity > 0 && lagerR > 0) {
      currentQty = Math.min(capacity, lagerR);
      autoRefillApplied = true;
      warnings.push({
        created_at: now, type: 'AUTO_REFILL_SLOT', severity: 'info',
        machine_id: machineId, product_key: clean(product.product_key), nayax_product_name: productName(product),
        message: `Auto-Refill: Slot war leer aber Sale empfangen. current_machine_qty auf ${currentQty} gesetzt (capacity=${capacity}, lager=${lagerR}).`,
        resolved: 'FALSE',
      });
    }
    if (existing) {
      existing.deduct_qty += soldQty;
      existing.current_machine_qty = Math.max(0, currentQty - existing.deduct_qty);
      return;
    }
    productQtyUpdates.set(key, {
      product_slot_id: clean(product.product_slot_id),
      product_key: clean(product.product_key),
      machine_id: clean(machineId),
      mdb_code: clean(mdbCode || product.mdb_code),
      old_current_machine_qty: Number(String(product.current_machine_qty ?? '').replace(',', '.')) || 0,
      deduct_qty: soldQty,
      current_machine_qty: Math.max(0, currentQty - soldQty),
      last_stock_update_at: now,
      last_stock_update_source: autoRefillApplied ? 'WF3_AUTO_REFILL' : 'WF3_NAYAX_LAST_SALES',
    });
  }

  function addMdbWarning(sale, match) {
    if (!['MDB_CODE_CHANGED_FOR_PRODUCT', 'MDB_PRODUCT_MAPPING_MISMATCH', 'MDB_CODE_MISSING_CONTROL', 'MDB_EXPECTED_CODE_MISSING'].includes(match.reason)) return;
    const machineId = clean(sale.MachineID || cfg.machine_id);
    warnings.push({
      created_at: now, type: match.reason, severity: 'warning',
      machine_id: machineId, product_key: match.product ? clean(match.product.product_key) : '', nayax_product_name: clean(sale.ProductName),
      message: `MDB-Kontrolle fuer ${clean(sale.ProductName)}: erwartet ${match.expectedMdb || 'leer'}, Nayax meldet ${match.mdbCode || 'leer'}. Verkauf wird weiter verarbeitet.`,
      resolved: 'FALSE',
    });
  }

  // ── MHD-Überwachung über alle aktiven Chargen (vor der Verkaufsschleife) ──
  for (const batch of originalBatches) {
    if (!isAvailableBatchStatus(batch.status)) continue;
    const remainingQty = Number(batch.remaining_qty);
    if (!Number.isFinite(remainingQty) || remainingQty <= 0) continue;
    if (!clean(batch.mhd)) {
      warnings.push({ created_at: now, type: 'MHD_MISSING', severity: 'warning', machine_id: cfg.machine_id, product_key: batch.product_key, nayax_product_name: '', message: `Aktive Charge ${batch.batch_id} hat kein MHD.`, resolved: 'FALSE' });
      continue;
    }
    const daysLeft = Math.ceil((new Date(batch.mhd) - safeDate(now, 0)) / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) {
      warnings.push({ created_at: now, type: 'MHD_EXPIRED', severity: 'error', machine_id: cfg.machine_id, product_key: batch.product_key, nayax_product_name: '', message: `Charge ${batch.batch_id} ist abgelaufen. MHD: ${batch.mhd}.`, resolved: 'FALSE' });
    } else if (daysLeft <= warningDays) {
      warnings.push({ created_at: now, type: 'MHD_WARNING', severity: 'warning', machine_id: cfg.machine_id, product_key: batch.product_key, nayax_product_name: '', message: `Charge ${batch.batch_id} laeuft in ${daysLeft} Tagen ab. MHD: ${batch.mhd}.`, resolved: 'FALSE' });
    }
  }

  // ── Verkaufsschleife (FIFO) ──
  for (const sale of sales) {
    const transactionId = clean(sale.TransactionID);
    const machineId = clean(sale.MachineID || cfg.machine_id);
    const rawProductName = clean(sale.ProductName);
    const sDate = saleDate(sale);

    if (!transactionId) {
      warnings.push({ created_at: now, type: 'MISSING_TRANSACTION_ID', severity: 'error', machine_id: machineId, product_key: '', nayax_product_name: rawProductName, message: 'Verkauf ohne TransactionID erhalten. Nicht verarbeitet.', resolved: 'FALSE' });
      continue;
    }
    if (sDate <= lastSuccessfulSaleDate) continue;
    if (sDate < cutoverDate) continue;
    if (processed.has(transactionId)) continue;
    processed.add(transactionId);

    // Null-Wert-Transaktionen (Prepaid, Storno, Test): kein Log, keine Abbuchung — aber Watermark darf vor.
    const settlementValue = Number(sale.SettlementValue);
    if (!Number.isFinite(settlementValue) || settlementValue <= 0) {
      if (sDate > maxProcessedSaleDate) maxProcessedSaleDate = sDate;
      continue;
    }
    const vkPreisBrutto = settlementValue;
    const mdbExtracted = clean(sale.mdb_code_extracted || '');

    if (!rawProductName) {
      transactionLogs.push({ transaction_id: transactionId, machine_id: machineId, nayax_product_name: '', product_key: '', quantity: getSoldQty(sale, cfg), settlement_datetime_gmt: saleDatetime(sale), processed_at: now, status: 'MISSING_PRODUCT_NAME', notes: 'Transaktion ohne Produktname erhalten. Nicht abgebucht.', vk_preis_brutto: vkPreisBrutto, umsatz_brutto: 0, mdb_code_extracted: mdbExtracted, batch_id_abgebucht: '' });
      warnings.push({ created_at: now, type: 'MISSING_PRODUCT_NAME', severity: 'error', machine_id: machineId, product_key: '', nayax_product_name: '', message: `Transaktion ${transactionId} enthaelt keinen Produktnamen.`, resolved: 'FALSE' });
      if (sDate > maxProcessedSaleDate) maxProcessedSaleDate = sDate;
      continue;
    }

    const match = getProductForSale(sale);
    const { product, parsed, mdbCode, expectedMdb, reason } = match;
    const soldQty = getSoldQty(sale, cfg);

    if (!product) {
      transactionLogs.push({ transaction_id: transactionId, machine_id: machineId, nayax_product_name: rawProductName, product_key: '', quantity: soldQty, settlement_datetime_gmt: saleDatetime(sale), processed_at: now, status: reason, notes: `Keine gueltige Produktzuordnung ueber ProductName gefunden. MDB: ${mdbCode || 'leer'}`, vk_preis_brutto: vkPreisBrutto, umsatz_brutto: 0, mdb_code_extracted: mdbExtracted, batch_id_abgebucht: '' });
      const suggestedKey = generateProductKey(parsed.label);
      warnings.push({ created_at: now, type: reason, severity: 'error', machine_id: machineId, product_key: suggestedKey, nayax_product_name: parsed.label || rawProductName, message: `Neues Produkt erkannt: "${parsed.label || rawProductName}" | MDB: ${mdbCode || 'leer'} | Preis: ${parsed.price || 'unbekannt'} EUR | Vorgeschlagener product_key: ${suggestedKey} | Bitte in Produkte-Tab anlegen.`, resolved: 'FALSE' });
      productChangeSuggestions.push({ created_at: now, source: 'WF3_NAYAX_LAST_SALES', change_type: 'NEW_PRODUCT', machine_id: machineId, actual_mdb_code: mdbCode, transaction_id: transactionId, raw_product_name: rawProductName, nayax_product_name: parsed.label, suggested_product_key: suggestedKey });
      if (sDate > maxProcessedSaleDate) maxProcessedSaleDate = sDate;
      continue;
    }

    addMdbWarning(sale, match);

    let remainingToDeduct = soldQty;
    const productBatches = [...batchMap.values()]
      .filter((b) => clean(b.product_key) === clean(product.product_key) && isAvailableBatchStatus(b.status) && Number(b.remaining_qty) > 0)
      .sort(sortByMhd);
    const deductedBatches = [];
    for (const batch of productBatches) {
      if (remainingToDeduct <= 0) break;
      const available = Number(batch.remaining_qty);
      const deduct = Math.min(available, remainingToDeduct);
      batch.remaining_qty = available - deduct;
      remainingToDeduct -= deduct;
      if (batch.remaining_qty <= 0) batch.status = DEPLETED_BATCH_STATUS;
      batchMap.set(String(batch.batch_id), batch);
      deductedBatches.push(String(batch.batch_id));
    }

    const transactionStatus = remainingToDeduct > 0 ? 'INSUFFICIENT_BATCH_STOCK' : 'OK';
    const mdbNote = reason === 'OK' ? `MDB ${mdbCode || 'leer'} bestaetigt.` : `MDB-Kontrolle ${reason}: erwartet ${expectedMdb || 'leer'}, Nayax meldet ${mdbCode || 'leer'}.`;
    transactionLogs.push({
      transaction_id: transactionId, machine_id: machineId, nayax_product_name: rawProductName, product_key: product.product_key,
      quantity: soldQty, settlement_datetime_gmt: saleDatetime(sale), processed_at: now, status: transactionStatus,
      notes: remainingToDeduct > 0 ? `Nicht genug aktiver Lagerbestand. Fehlmenge: ${remainingToDeduct}. ${mdbNote}` : `Abgebucht ueber product_key ${product.product_key}. ${mdbNote}`,
      vk_preis_brutto: vkPreisBrutto, umsatz_brutto: soldQty * vkPreisBrutto, mdb_code_extracted: mdbExtracted, batch_id_abgebucht: deductedBatches.join(', '),
      product_slot_id: clean(product.product_slot_id),
    });

    if (transactionStatus === 'OK') {
      const totalLagerRemainingBeforeDeduct = [...batchMap.values()]
        .filter((b) => clean(b.product_key) === clean(product.product_key) && isAvailableBatchStatus(b.status))
        .reduce((s, b) => s + (Number(b.remaining_qty) || 0), 0) + soldQty;
      queueProductQtyDeduction(product, machineId, mdbCode, soldQty, totalLagerRemainingBeforeDeduct);
    }
    if (remainingToDeduct > 0) {
      warnings.push({ created_at: now, type: 'INSUFFICIENT_BATCH_STOCK', severity: 'error', machine_id: machineId, product_key: product.product_key, nayax_product_name: rawProductName, message: `Nicht genug aktiver Lagerbestand. Fehlmenge: ${remainingToDeduct}`, resolved: 'FALSE' });
    }
    if (sDate > maxProcessedSaleDate) maxProcessedSaleDate = sDate;
  }

  // Geänderte Chargen (remaining_qty / status)
  const batchUpdates = [...batchMap.values()].filter((nb) => {
    const ob = originalBatches.find((b) => String(b.batch_id) === String(nb.batch_id));
    return ob && (String(ob.remaining_qty) !== String(nb.remaining_qty) || String(ob.status) !== String(nb.status));
  });

  const watermark = {
    workflow_key: WORKFLOW_STATE_KEY,
    last_inventory_review_at: maxProcessedSaleDate.toISOString(),
    previous_last_inventory_review_at: lastSuccessfulSaleDate.toISOString(),
    should_update: maxProcessedSaleDate > lastSuccessfulSaleDate,
  };

  const salesTransactions = buildSaleEvents(transactionLogs);
  const stockMovements = buildStockMovementEvents(batchUpdates, originalBatches, now);

  return {
    salesTransactions,
    stockMovements,
    warnings,
    batchUpdates,
    slotQtyUpdates: [...productQtyUpdates.values()],
    productChangeSuggestions,
    watermark,
    summary: {
      sales_received: sales.length,
      processed_transaction_logs: transactionLogs.length,
      batch_updates: batchUpdates.length,
      warnings: warnings.length,
      product_change_suggestions: productChangeSuggestions.length,
      product_qty_updates: productQtyUpdates.size,
      processed_at: now,
      previous_last_inventory_review_at: lastSuccessfulSaleDate.toISOString(),
      last_successful_sale_datetime_gmt: maxProcessedSaleDate.toISOString(),
      should_update_watermark: maxProcessedSaleDate > lastSuccessfulSaleDate,
    },
  };
}

function batchRunIdFor(nowIso) {
  return `wf3_${(nowIso || new Date().toISOString()).slice(0, 10)}`;
}

// Bewegungsschlüssel ohne Run-Datum-Suffix (für Shadow-Vergleich: Port läuft heute,
// n8n schrieb gestern — gleicher fachlicher Schlüssel, unterschiedliches Datum).
function movementBaseKey(r) {
  return String(r.movement_key || '').replace(/_wf3_\d{4}-\d{2}-\d{2}$/, '');
}

// transactionLogs → sale-Events (WF3 "Prepare PGW - sale"): verlangt tx + machine.
function buildSaleEvents(transactionLogs) {
  return (transactionLogs || [])
    .filter((tx) => {
      const tid = String(tx.transaction_id);
      const mid = String(tx.machine_id);
      return tx.transaction_id != null && tid !== 'undefined' && tid !== '' && tx.machine_id != null && mid !== 'undefined' && mid !== '';
    })
    .map((tx) => {
      const gross = Number(tx.umsatz_brutto) || 0;
      return {
        nayax_transaction_id: String(tx.transaction_id),
        machine_key: String(tx.machine_id),
        mdb_code: tx.mdb_code_extracted || null,
        product_key: tx.product_key || null,
        product_slot_key: tx.product_slot_id || null,
        product_name_raw: tx.nayax_product_name || '',
        quantity: Number(tx.quantity) || 1,
        gross_amount: gross,
        net_amount: gross,
        vat_amount: 0,
        settlement_at: tx.settlement_datetime_gmt,
        processing_status: tx.status || 'UNKNOWN',
        processing_note: tx.notes || null,
        source: 'nayax_lastSales',
      };
    });
}

// batchUpdates → stock_movement-Events (WF3 "Prepare PGW - stock_movement"): delta ≠ 0.
function buildStockMovementEvents(batchUpdates, originalBatches, nowIso) {
  const at = nowIso || new Date().toISOString();
  const batchRunId = batchRunIdFor(at);
  const originalMap = new Map((originalBatches || []).map((b) => [String(b.batch_id), b]));
  const out = [];
  for (const updated of batchUpdates || []) {
    const batchKey = String(updated.batch_id);
    const original = originalMap.get(batchKey);
    if (!original) continue;
    const delta = (Number(updated.remaining_qty) || 0) - (Number(original.remaining_qty) || 0);
    if (delta === 0) continue;
    out.push({
      movement_key: `wf3_sale_${batchKey}_${batchRunId}`,
      batch_key: batchKey,
      movement_type: 'sale',
      quantity_delta_total: delta,
      quantity_delta_slot: 0,
      reason: 'WF3 FIFO Nayax sale deduction',
      source: 'wf3_nayax_last_sales',
      occurred_at: at,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O-Schicht — alles durch die Mandanten-Tür (db.tx / db.forTenant), RLS-GUC,
// explizites tenant_id. Verhaltensgetreu zur pgw_write()-Semantik (Pre-Flight-Dump):
//   sale           → sales_transactions   (FK-Auflösung machine/product/slot aus Keys)
//   stock_movement → stock_movements      (Trigger apply_stock_movement pflegt remaining_qty!)
//   Watermark      → workflow_state        (direkter postgres-Schreibknoten in WF3)
//   Warnungen      → warnings              (Sheets ist tot → AC „Auto-Korrektur-Warnungen")
// WICHTIG: stock_batches.remaining_qty wird NICHT manuell geupdatet — der
// AFTER-INSERT-Trigger auf stock_movements erledigt das (sonst Doppel-Dekrement).
// ─────────────────────────────────────────────────────────────────────────────

// Aktive Slots in der WF3-Produktform (machine_id = Nayax-Maschinennummer = machines.machine_key).
const PRODUCT_READ_SQL = `
  SELECT sa.product_slot_key AS product_slot_id,
         m.machine_key       AS machine_id,
         sa.mdb_code::text    AS mdb_code,
         p.product_key,
         sa.current_machine_qty, sa.machine_capacity,
         'TRUE' AS active, '' AS valid_to, '' AS valid_to_datetime,
         COALESCE(na.alias, '') AS nayax_product_name,
         p.name AS internal_product_name
    FROM automatenlager.slot_assignments sa
    JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
    JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
    LEFT JOIN LATERAL (
      SELECT pa.alias FROM automatenlager.product_aliases pa
       WHERE pa.product_id = p.product_id AND pa.tenant_id = sa.tenant_id
         AND pa.source = 'nayax' AND pa.is_primary = TRUE
       ORDER BY pa.alias LIMIT 1) na ON TRUE
   WHERE sa.tenant_id = $1 AND sa.active = TRUE`;

// Chargen in WF3-Form (batch_id ← batch_key, mhd ← mhd_date). Status-Filter macht computeFifoPlan.
function batchReadSql() {
  return `
  SELECT sb.batch_key AS batch_id, p.product_key, sb.remaining_qty,
         to_char(sb.mhd_date, 'YYYY-MM-DD') AS mhd, sb.status
    FROM automatenlager.stock_batches sb
    JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
   WHERE sb.tenant_id = $1 AND sb.status IN (${availableBatchStatusSqlList()}) AND sb.remaining_qty > 0`;
}

const WORKFLOW_STATE_READ_SQL = `
  SELECT workflow_key, last_inventory_review_at
    FROM automatenlager.workflow_state
   WHERE tenant_id = $1 AND workflow_key = $2`;

// Bereits verarbeitete Transaktions-IDs (Fenster ab Puffer) — Idempotenz beim Rechnen.
const PROCESSED_READ_SQL = `
  SELECT nayax_transaction_id
    FROM automatenlager.sales_transactions
   WHERE tenant_id = $1 AND settlement_at >= $2::timestamptz`;

const SALE_INSERT_SQL = `
  INSERT INTO automatenlager.sales_transactions
    (nayax_transaction_id, machine_id, product_id, slot_assignment_id, mdb_code,
     product_name_raw, quantity, gross_amount, net_amount, vat_amount,
     settlement_at, processing_status, processing_note, source, tenant_id)
  SELECT $2, m.machine_id, p.product_id, sa.slot_assignment_id, $5::integer,
         $6, $7::integer, $8::numeric, $9::numeric, $10::numeric,
         $11::timestamptz, $12, $13, $14, $1
    FROM automatenlager.machines m
    LEFT JOIN automatenlager.products p ON p.product_key = $4 AND p.tenant_id = $1
    LEFT JOIN automatenlager.slot_assignments sa ON sa.product_slot_key = $15 AND sa.tenant_id = $1
   WHERE m.machine_key = $3 AND m.tenant_id = $1
   LIMIT 1
  ON CONFLICT (tenant_id, provider, nayax_transaction_id) DO NOTHING`;

const MOVEMENT_INSERT_SQL = `
  INSERT INTO automatenlager.stock_movements
    (movement_key, batch_id, slot_assignment_id, movement_type,
     quantity_delta_total, quantity_delta_slot, reason, source, occurred_at, tenant_id)
  SELECT $2, sb.batch_id, sa.slot_assignment_id, $4, $5::integer, $6::integer, $7, $8, $9::timestamptz, $1
    FROM automatenlager.stock_batches sb
    LEFT JOIN automatenlager.slot_assignments sa ON sa.product_slot_key = $3 AND sa.tenant_id = $1
   WHERE sb.batch_key = $10 AND sb.tenant_id = $1
   LIMIT 1
  ON CONFLICT (tenant_id, movement_key) DO NOTHING`;

const WARNING_INSERT_SQL = `
  INSERT INTO automatenlager.warnings
    (warning_key, warning_type, severity, machine_id, product_id, message, source_workflow, tenant_id)
  SELECT $2, $3, $4, m.machine_id, p.product_id, $7, 'wf3', $1
    FROM (SELECT 1) x
    LEFT JOIN automatenlager.machines m ON m.machine_key = $5 AND m.tenant_id = $1
    LEFT JOIN automatenlager.products p ON p.product_key = $6 AND p.tenant_id = $1
  ON CONFLICT (tenant_id, warning_key) DO NOTHING`;

// Watermark-Upsert auf der mandanten-PK (tenant_id, workflow_key). Seit #111 (0031)
// ist der Watermark per Mandant geschlüsselt — der globale (workflow_key)-PK ist weg.
// Schreibweg läuft durch die Tür (RLS); die WHERE-Klausel bleibt als Defense-in-depth.
const WATERMARK_UPSERT_SQL = `
  INSERT INTO automatenlager.workflow_state (workflow_key, last_inventory_review_at, updated_at, tenant_id)
  VALUES ($2, $3::timestamptz, now(), $1)
  ON CONFLICT (tenant_id, workflow_key) DO UPDATE
    SET last_inventory_review_at = EXCLUDED.last_inventory_review_at, updated_at = now()
    WHERE workflow_state.tenant_id = $1`;

function sanitizeKey(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// computeFifoPlan-Warnungen → warnings-Zeilen mit deterministischem warning_key
// (idempotent pro Lauftag). Nur Typen der DB-Taxonomie (CHECK) — Sheets-Ära-Typen
// werden gemappt ODER (kein Mapping) übersprungen. Leere FK ⇒ NULL (erlaubt).
function buildWarningRows(warnings, nowIso) {
  const dateStr = (nowIso || new Date().toISOString()).slice(0, 10);
  const out = [];
  let idx = 0;
  for (const w of warnings || []) {
    const allowed = toAllowedWarningType(w.type);
    if (!allowed) continue; // kein PG-Warnungstyp (z. B. MHD_MISSING, AUTO_REFILL_SLOT)
    out.push({
      warning_key: ['WF3', sanitizeKey(allowed), sanitizeKey(w.machine_id), sanitizeKey(w.product_key || 'NA'), sanitizeKey(dateStr), String(idx++)].join('_'),
      warning_type: allowed,
      severity: clean(w.severity) || 'info',
      machine_key: clean(w.machine_id),
      product_key: clean(w.product_key),
      message: clean(w.message),
    });
  }
  return out;
}

/**
 * WF3-Verkäufe durch die Tür anwenden: sales_transactions + stock_movements
 * (Trigger pflegt remaining_qty) + Warnungen + Watermark — alles in EINER db.tx.
 * @param {object} db      Mandanten-Tür (lib/tenant-db.js)
 * @param {string} tenant  expliziter Mandant
 * @param {object} opts     { sales, config, nowIso }
 */
async function applyNayaxSales(db, tenant, { sales = [], config = {}, nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const cfg = config || {};
  return db.tx(tenant, async (door) => {
    // Sequenziell (Sandbox teilt einen Client — kein Promise.all).
    const wsRes = await door.read({ tables: ['workflow_state'], text: WORKFLOW_STATE_READ_SQL, params: [WORKFLOW_STATE_KEY] });
    const workflowState = wsRes.rows[0] || null;
    const wmIso = (workflowState && workflowState.last_inventory_review_at)
      ? new Date(workflowState.last_inventory_review_at).toISOString()
      : (cfg.inventory_cutover_datetime || '1970-01-01T00:00:00.000Z');
    const bufferIso = new Date(new Date(wmIso).getTime() - 2 * 86400000).toISOString();
    const procRes = await door.read({ tables: ['sales_transactions'], text: PROCESSED_READ_SQL, params: [bufferIso] });
    const prodRes = await door.read({ tables: ['slot_assignments', 'products', 'machines', 'product_aliases'], text: PRODUCT_READ_SQL });
    const batchRes = await door.read({ tables: ['stock_batches', 'products'], text: batchReadSql() });

    const plan = computeFifoPlan({
      sales,
      products: prodRes.rows,
      batches: batchRes.rows,
      processedTxIds: procRes.rows.map((r) => r.nayax_transaction_id),
      workflowState,
      config: cfg,
      nowIso: at,
    });

    let salesWritten = 0; let movementsWritten = 0; let warningsWritten = 0;
    for (const s of plan.salesTransactions) {
      const r = await door.write({
        tables: ['sales_transactions', 'machines', 'products', 'slot_assignments'],
        text: SALE_INSERT_SQL,
        params: [s.nayax_transaction_id, s.machine_key, s.product_key, s.mdb_code, s.product_name_raw,
          s.quantity, s.gross_amount, s.net_amount, s.vat_amount, s.settlement_at,
          s.processing_status, s.processing_note, s.source, s.product_slot_key],
      });
      salesWritten += (r.rowCount || 0);
    }
    for (const m of plan.stockMovements) {
      const r = await door.write({
        tables: ['stock_movements', 'stock_batches', 'slot_assignments'],
        text: MOVEMENT_INSERT_SQL,
        params: [m.movement_key, m.product_slot_key || null, m.movement_type,
          m.quantity_delta_total, m.quantity_delta_slot, m.reason, m.source, m.occurred_at, m.batch_key],
      });
      movementsWritten += (r.rowCount || 0);
    }
    for (const w of buildWarningRows(plan.warnings, at)) {
      const r = await door.write({
        tables: ['warnings', 'machines', 'products'],
        text: WARNING_INSERT_SQL,
        params: [w.warning_key, w.warning_type, w.severity, w.machine_key, w.product_key, w.message],
      });
      warningsWritten += (r.rowCount || 0);
    }
    if (plan.watermark.should_update) {
      await door.write({
        tables: ['workflow_state'],
        text: WATERMARK_UPSERT_SQL,
        params: [plan.watermark.workflow_key, plan.watermark.last_inventory_review_at],
      });
    }
    return { salesWritten, movementsWritten, warningsWritten, watermark: plan.watermark, summary: plan.summary };
  });
}

// Ist-Stand-Reads für den Schatten-Vergleich (was n8n tatsächlich nach PG schrieb).
const ACTUAL_SALES_READ_SQL = `
  SELECT nayax_transaction_id, processing_status, quantity
    FROM automatenlager.sales_transactions
   WHERE tenant_id = $1 AND settlement_at >= $2::timestamptz`;
const ACTUAL_MOVEMENTS_READ_SQL = `
  SELECT movement_key, quantity_delta_total
    FROM automatenlager.stock_movements
   WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz`;

/**
 * Schattenbetrieb (Slice 3, Kern): rechnet die BEABSICHTIGTEN Writes (schreibt
 * NICHT) und vergleicht sie strukturell gegen den n8n-Ist-Stand. Erst bei
 * Deckungsgleichheit (equal === true) Cutover. Liest read-only durch die Tür.
 * @returns {{equal:boolean, salesDiff:object, movementsDiff:object, plan:object}}
 */
async function runNayaxSalesShadow(db, tenant, { sales = [], config = {}, nowIso, windowStartIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const cfg = config || {};
  const door = db.forTenant(tenant);
  const wsRes = await door.read({ tables: ['workflow_state'], text: WORKFLOW_STATE_READ_SQL, params: [WORKFLOW_STATE_KEY] });
  const workflowState = wsRes.rows[0] || null;
  const wmIso = (workflowState && workflowState.last_inventory_review_at)
    ? new Date(workflowState.last_inventory_review_at).toISOString()
    : (cfg.inventory_cutover_datetime || '1970-01-01T00:00:00.000Z');
  // Vergleichsfenster: früheste Transaktion in der aktuellen Sales-Charge, damit nur
  // Movements verglichen werden die aus DIESEN Transaktionen entstanden sein könnten.
  // Alte n8n-Läufe (> sales-Fenster) polluten sonst onlyActual → equal=false obwohl korrekt.
  const salesEarliest = sales.length > 0
    ? sales.reduce((min, s) => { const d = saleDate(s); return d < min ? d : min; }, saleDate(sales[0]))
    : null;
  const validSalesEarliest = salesEarliest && salesEarliest.getTime() > new Date('2020-01-01').getTime();
  const winStart = windowStartIso
    || (validSalesEarliest ? salesEarliest.toISOString() : new Date(new Date(wmIso).getTime() - 2 * 86400000).toISOString());
  const prodRes = await door.read({ tables: ['slot_assignments', 'products', 'machines', 'product_aliases'], text: PRODUCT_READ_SQL });
  const batchRes = await door.read({ tables: ['stock_batches', 'products'], text: batchReadSql() });

  // COMPUTE-ONLY: kein Schreibpfad. Für den Vergleich „was hätte der Port für DIESES
  // Fenster geschrieben" wird die VOLLE beabsichtigte Menge gerechnet (Fenster-Watermark
  // statt Live-Watermark, keine processedTxIds-Dedup) — sonst wäre „intended" durch n8ns
  // bereits gesetzte Watermark leer und der Vergleich vakuös.
  const plan = computeFifoPlan({
    sales, products: prodRes.rows, batches: batchRes.rows,
    processedTxIds: [],
    workflowState: { workflow_key: WORKFLOW_STATE_KEY, last_inventory_review_at: winStart },
    config: cfg, nowIso: at,
  });

  const actualSales = await door.read({ tables: ['sales_transactions'], text: ACTUAL_SALES_READ_SQL, params: [winStart] });
  const actualMovements = await door.read({ tables: ['stock_movements'], text: ACTUAL_MOVEMENTS_READ_SQL, params: [winStart] });

  const salesDiff = diffWrites(plan.salesTransactions, actualSales.rows, {
    keyOf: (r) => String(r.nayax_transaction_id),
    fields: ['quantity'],
  });
  const movementsDiff = diffWrites(plan.stockMovements, actualMovements.rows, {
    // movement_key enthält das Run-Datum (_wf3_YYYY-MM-DD) → fachlichen Prefix
    // vergleichen, damit Port-Lauf von heute gegen n8n-Schrieb von gestern passt.
    keyOf: movementBaseKey,
    fields: ['quantity_delta_total'],
  });
  // onlyIntended=OK: neue Transaktionen seit n8ns letztem Lauf (Port sieht frischere
  // Daten). Cutover ist sicher solange n8n nichts schreibt, was der Port vermissen würde.
  const equal = salesDiff.onlyActual.length === 0 && salesDiff.mismatched.length === 0
             && movementsDiff.onlyActual.length === 0 && movementsDiff.mismatched.length === 0;
  return { equal, salesDiff, movementsDiff, plan };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nayax-Fetch + Worker-Factory. Default = SCHATTENBETRIEB (compute+compare, kein
// Schreiben) bis die Deckungsgleichheit bewiesen ist; Cutover per WF3_CUTOVER=1.
// ─────────────────────────────────────────────────────────────────────────────
const { normalizeAuthValue, resolveNayaxTenant } = require('./nayax-devices-sync.js');

const NAYAX_DEFAULT_BASE_URL = 'https://lynx.nayax.com';
const NAYAX_DEFAULT_MACHINE_ID = '457107528';
const NAYAX_DEFAULT_CUTOVER = '2026-05-02T10:10:00.000Z';

/** Config aus der Env (Defaults = WF3-„Config"-Knoten). */
function configFromEnv(env = process.env) {
  return {
    machine_id: (env.NAYAX_MACHINE_ID && String(env.NAYAX_MACHINE_ID).trim()) || NAYAX_DEFAULT_MACHINE_ID,
    nayax_base_url: (env.NAYAX_BASE_URL && String(env.NAYAX_BASE_URL).trim()) || NAYAX_DEFAULT_BASE_URL,
    inventory_cutover_datetime: (env.WF3_INVENTORY_CUTOVER && String(env.WF3_INVENTORY_CUTOVER).trim()) || NAYAX_DEFAULT_CUTOVER,
    mhd_warning_days: Number(env.WF3_MHD_WARNING_DAYS) || 30,
    default_quantity_per_sale: Number(env.WF3_DEFAULT_QTY) || 1,
  };
}

/** WF3 „Nayax - Last Sales": GET {base}/operational/v1/machines/{machineId}/lastSales. */
async function fetchNayaxLastSales({ token, headerName = 'Authorization', baseUrl = NAYAX_DEFAULT_BASE_URL, machineId, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new TypeError('nayax-sales: kein fetch verfügbar — fetchImpl injizieren');
  if (!machineId) throw new TypeError('nayax-sales: machineId erforderlich');
  const url = `${baseUrl}/operational/v1/machines/${encodeURIComponent(machineId)}/lastSales`;
  const res = await doFetch(url, withTimeout({ method: 'GET', headers: { [headerName]: token, accept: 'application/json' } }));
  if (!res.ok) throw new Error(`nayax-sales: Nayax HTTP ${res.status}`);
  return normalizeSales([await res.json()]);
}

function isCutover(env) {
  const v = String((env && env.WF3_CUTOVER) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Worker-Factory (WF3, n8n: täglich 01:00). Holt Nayax-Verkäufe und läuft im
 * SCHATTENBETRIEB (Default — rechnet + vergleicht, schreibt NICHT) bzw. nach
 * Cutover (WF3_CUTOVER=1) im Schreibmodus durch die Tür. Ein Token = ein Mandant.
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createNayaxSalesJob({ db, directory, env = process.env, fetchImpl } = {}) {
  if (!db) throw new TypeError('nayax-sales: db (Mandanten-Tür) erforderlich');
  return {
    key: NAYAX_SALES_JOB_KEY,
    run: async () => {
      const token = normalizeAuthValue(env.NAYAX_API_TOKEN);
      if (!token) return { skipped: 'kein NAYAX_API_TOKEN in der Env' };
      const tenant = resolveNayaxTenant(env, directory);
      if (!tenant) return { skipped: 'kein eindeutiger Nayax-Mandant (NAYAX_TENANT_ID setzen)' };
      const config = configFromEnv(env);
      const sales = await fetchNayaxLastSales({
        token,
        headerName: (env.NAYAX_HEADER_NAME && String(env.NAYAX_HEADER_NAME).trim()) || 'Authorization',
        baseUrl: config.nayax_base_url,
        machineId: config.machine_id,
        fetchImpl,
      });
      if (!isCutover(env)) {
        // SCHATTEN (Default): rechnet die beabsichtigten Writes + vergleicht gegen n8n-Ist.
        const shadow = await runNayaxSalesShadow(db, tenant, { sales, config });
        return {
          mode: 'shadow', tenant, fetched: sales.length, equal: shadow.equal,
          diffSample: {
            sales: sampleDiff(shadow.salesDiff, { keyOf: (r) => String(r.nayax_transaction_id) }),
            movements: sampleDiff(shadow.movementsDiff, { keyOf: movementBaseKey }),
          },
        };
      }
      const res = await applyNayaxSales(db, tenant, { sales, config });
      return { mode: 'cutover', tenant, fetched: sales.length, ...res };
    },
  };
}

module.exports = {
  NAYAX_SALES_JOB_KEY,
  WORKFLOW_STATE_KEY,
  configFromEnv,
  fetchNayaxLastSales,
  createNayaxSalesJob,
  normalizeSales,
  computeFifoPlan,
  buildSaleEvents,
  buildStockMovementEvents,
  buildWarningRows,
  applyNayaxSales,
  runNayaxSalesShadow,
  // SQL-Bausteine (für gezielte Tests / Wiederverwendung)
  PRODUCT_READ_SQL,
  batchReadSql,
  // interne reine Helfer (für gezielte Unit-Tests / Wiederverwendung)
  parseProductName,
  normalizeName,
  generateProductKey,
};
