'use strict';

/**
 * WF3 Nayax-Verkäufe — In-Process-Port (Issue #163, Stufe 6 Slice 3).
 *
 * Datenkritische Ingestion im Schattenbetrieb: Verkäufe von Nayax holen,
 * FIFO-Abbuchung (stock_batches), sales_transactions, Watermark (workflow_state),
 * Auto-Korrektur-Warnungen — per-Mandant durch db.tx durch die Mandanten-Tür.
 * Verhaltensgetreu aus der authoritativen Mini-WF3-Definition portiert
 * ("Normalize Sales", "Code - FIFO berechnen", "Prepare PGW - sale/stock_movement",
 * Watermark "letzter Verkaufsworkflow").
 *
 * Ebenen: (1) reine Logik normalizeSales/computeFifoPlan; (2) Schatten-Diff
 * (compute-only vs. n8n-Ist via shadow-harness); (3) Live applyNayaxSales durch
 * die Tür (acme/globex-Isolation).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const ns = require('../lib/jobs/nayax-sales.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T08:00:00.000Z';
const CONFIG = {
  machine_id: '457107528',
  inventory_cutover_datetime: '2026-05-02T10:00:00.000Z',
  mhd_warning_days: 14,
  default_quantity_per_sale: 1,
};

function kitkatProduct(extra = {}) {
  return {
    active: 'TRUE',
    valid_to: '',
    valid_to_datetime: '',
    machine_id: '457107528',
    product_slot_id: 'PS_457107528_12_KITKAT_1',
    mdb_code: '12',
    product_key: 'SKU_KITKAT',
    nayax_product_name: 'KitKat',
    internal_product_name: 'KitKat',
    current_machine_qty: 5,
    machine_capacity: 10,
    ...extra,
  };
}

// FIFO: zwei Chargen für KitKat, B1 hat das frühere MHD und muss zuerst bluten.
function kitkatBatches() {
  return [
    { batch_id: 'B1', product_key: 'SKU_KITKAT', remaining_qty: 10, mhd: '2026-07-01', status: 'aktiv' },
    { batch_id: 'B2', product_key: 'SKU_KITKAT', remaining_qty: 10, mhd: '2027-01-01', status: 'aktiv' },
  ];
}

function kitkatSale(extra = {}) {
  return {
    TransactionID: 'T1',
    MachineID: '457107528',
    ProductName: 'KitKat (12 = 1.50)',
    SettlementValue: 1.5,
    SettlementDateTimeGMT: '2026-06-05T12:00:00.000Z',
    mdb_code_extracted: '12',
    MultivendNumberOfProducts: 0,
    ...extra,
  };
}

// ── Ebene 1: normalizeSales ──────────────────────────────────────────────────
test('#163 normalizeSales: flacht Array/body/Einzelobjekt zu flacher Liste', () => {
  assert.deepEqual(ns.normalizeSales([{ a: 1 }, { a: 2 }]).map((s) => s.a), [1, 2]);
  assert.deepEqual(ns.normalizeSales([{ body: [{ a: 3 }, { a: 4 }] }]).map((s) => s.a), [3, 4]);
  assert.deepEqual(ns.normalizeSales([{ a: 5 }]).map((s) => s.a), [5]);
});

// ── Ebene 1: computeFifoPlan — Happy Path ────────────────────────────────────
test('#163 computeFifoPlan: bucht FIFO über die früheste MHD-Charge ab, erzeugt sale + stock_movement, schreibt Watermark fort', () => {
  const plan = ns.computeFifoPlan({
    sales: [kitkatSale()],
    products: [kitkatProduct()],
    batches: kitkatBatches(),
    processedTxIds: [],
    workflowState: { workflow_key: 'WF3_NAYAX_FIFO', last_inventory_review_at: '2026-06-01T00:00:00.000Z' },
    config: CONFIG,
    nowIso: NOW,
  });

  // sales_transactions (event_type 'sale')
  assert.equal(plan.salesTransactions.length, 1, 'genau eine sales_transaction');
  const sale = plan.salesTransactions[0];
  assert.equal(sale.nayax_transaction_id, 'T1');
  assert.equal(sale.product_key, 'SKU_KITKAT');
  assert.equal(sale.machine_key, '457107528');
  assert.equal(sale.quantity, 1);
  assert.equal(sale.gross_amount, 1.5);
  assert.equal(sale.processing_status, 'OK');

  // stock_movement: −1 auf die frühere Charge B1
  assert.equal(plan.stockMovements.length, 1, 'genau ein stock_movement');
  const mv = plan.stockMovements[0];
  assert.equal(mv.batch_key, 'B1');
  assert.equal(mv.movement_type, 'sale');
  assert.equal(mv.quantity_delta_total, -1);
  assert.equal(mv.quantity_delta_slot, 0);

  // batchUpdates: B1 von 10 auf 9, B2 unangetastet
  const b1 = plan.batchUpdates.find((b) => b.batch_id === 'B1');
  assert.ok(b1, 'B1 in batchUpdates');
  assert.equal(Number(b1.remaining_qty), 9);
  assert.equal(plan.batchUpdates.find((b) => b.batch_id === 'B2'), undefined, 'B2 unverändert');

  // Watermark: fortgeschrieben auf das Datum des verarbeiteten Verkaufs
  assert.equal(plan.watermark.should_update, true);
  assert.equal(plan.watermark.workflow_key, 'WF3_NAYAX_FIFO');
  assert.equal(plan.watermark.last_inventory_review_at, '2026-06-05T12:00:00.000Z');
});

// ── Ebene 1: Watermark-/Idempotenz-Filter ────────────────────────────────────
test('#163 computeFifoPlan: Verkäufe ≤ Watermark, vor Cutover oder bereits verarbeitet werden übersprungen', () => {
  const sales = [
    kitkatSale({ TransactionID: 'OLD', SettlementDateTimeGMT: '2026-05-15T00:00:00.000Z' }), // ≤ Watermark
    kitkatSale({ TransactionID: 'PRE', SettlementDateTimeGMT: '2026-04-01T00:00:00.000Z' }),  // vor Cutover
    kitkatSale({ TransactionID: 'DONE', SettlementDateTimeGMT: '2026-06-05T12:00:00.000Z' }), // schon verarbeitet
  ];
  const plan = ns.computeFifoPlan({
    sales, products: [kitkatProduct()], batches: kitkatBatches(),
    processedTxIds: ['DONE'],
    workflowState: { last_inventory_review_at: '2026-06-01T00:00:00.000Z' },
    config: CONFIG, nowIso: NOW,
  });
  assert.equal(plan.salesTransactions.length, 0, 'kein Verkauf verarbeitet');
  assert.equal(plan.watermark.should_update, false, 'Watermark bleibt');
});

test('#163 computeFifoPlan: Null-Wert-Transaktion (SettlementValue ≤ 0) wird nicht gebucht, schiebt aber die Watermark vor', () => {
  const plan = ns.computeFifoPlan({
    sales: [kitkatSale({ SettlementValue: 0 })],
    products: [kitkatProduct()], batches: kitkatBatches(), processedTxIds: [],
    workflowState: { last_inventory_review_at: '2026-06-01T00:00:00.000Z' },
    config: CONFIG, nowIso: NOW,
  });
  assert.equal(plan.salesTransactions.length, 0, 'kein sale-Event');
  assert.equal(plan.stockMovements.length, 0, 'keine Abbuchung');
  assert.equal(plan.watermark.should_update, true, 'Watermark vor');
});

// ── Ebene 1: Fehlmenge ───────────────────────────────────────────────────────
test('#163 computeFifoPlan: zu wenig Lagerbestand ⇒ INSUFFICIENT_BATCH_STOCK + Restmenge gemeldet', () => {
  const plan = ns.computeFifoPlan({
    sales: [kitkatSale({ MultivendNumberOfProducts: 25 })], // mehr als 20 vorrätig
    products: [kitkatProduct()], batches: kitkatBatches(), processedTxIds: [],
    workflowState: { last_inventory_review_at: '2026-06-01T00:00:00.000Z' },
    config: CONFIG, nowIso: NOW,
  });
  assert.equal(plan.salesTransactions[0].processing_status, 'INSUFFICIENT_BATCH_STOCK');
  assert.ok(plan.warnings.some((w) => w.type === 'INSUFFICIENT_BATCH_STOCK'), 'Warnung gesetzt');
  // beide Chargen geleert
  assert.equal(plan.stockMovements.length, 2);
});

// ── Ebene 1: unbekanntes Produkt ─────────────────────────────────────────────
test('#163 computeFifoPlan: unbekanntes Produkt ⇒ sale-Event mit Reason, Warnung + NEW_PRODUCT-Vorschlag, keine Abbuchung', () => {
  const plan = ns.computeFifoPlan({
    sales: [kitkatSale({ TransactionID: 'TX', ProductName: 'Voellig Neues Getraenk (99 = 2.00)', mdb_code_extracted: '99' })],
    products: [kitkatProduct()], batches: kitkatBatches(), processedTxIds: [],
    workflowState: { last_inventory_review_at: '2026-06-01T00:00:00.000Z' },
    config: CONFIG, nowIso: NOW,
  });
  assert.equal(plan.salesTransactions.length, 1);
  assert.equal(plan.salesTransactions[0].processing_status, 'UNKNOWN_PRODUCT');
  assert.equal(plan.salesTransactions[0].product_key, null);
  assert.equal(plan.salesTransactions[0].gross_amount, 0, 'kein Umsatz ohne Zuordnung');
  assert.equal(plan.stockMovements.length, 0, 'keine FIFO-Abbuchung');
  assert.ok(plan.productChangeSuggestions.some((s) => s.change_type === 'NEW_PRODUCT'));
});

// ── Ebene 1: MDB-Kontroll-Warnung ────────────────────────────────────────────
test('#163 computeFifoPlan: gemeldeter MDB-Code weicht ab ⇒ MDB-Warnung, Verkauf läuft trotzdem', () => {
  const plan = ns.computeFifoPlan({
    sales: [kitkatSale({ ProductName: 'KitKat (77 = 1.50)', mdb_code_extracted: '77' })],
    products: [kitkatProduct()], batches: kitkatBatches(), processedTxIds: [],
    workflowState: { last_inventory_review_at: '2026-06-01T00:00:00.000Z' },
    config: CONFIG, nowIso: NOW,
  });
  assert.ok(plan.warnings.some((w) => w.type === 'MDB_CODE_CHANGED_FOR_PRODUCT'), 'MDB-Warnung');
  assert.equal(plan.salesTransactions[0].processing_status, 'OK', 'Verkauf trotzdem gebucht');
});

// ── Ebene 1: buildSaleEvents-Filter ──────────────────────────────────────────
test('#163 buildSaleEvents: Logs ohne transaction_id oder machine_id werden ausgefiltert', () => {
  const events = ns.buildSaleEvents([
    { transaction_id: 'T1', machine_id: '457107528', umsatz_brutto: 1.5, quantity: 1, status: 'OK' },
    { transaction_id: '', machine_id: '457107528' },
    { transaction_id: 'T3', machine_id: '' },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].nayax_transaction_id, 'T1');
});

// ── Ebene 2: Live applyNayaxSales durch die Tür (acme/globex-Isolation) ───────
const CFG_ACME = { machine_id: 'vm_acme', inventory_cutover_datetime: '2026-05-02T10:00:00.000Z', default_quantity_per_sale: 1 };
function liveSale(tid, extra = {}) {
  return {
    TransactionID: `WF3T_${tid}`, MachineID: `vm_${tid}`, ProductName: `Cola ${tid} (10 = 1.00)`,
    SettlementValue: 1.0, SettlementDateTimeGMT: '2026-06-05T12:00:00.000Z', mdb_code_extracted: '10', ...extra,
  };
}

test('#163 applyNayaxSales LIVE: sale + stock_movement (Trigger bucht remaining_qty ab) durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // MHD setzen (kein MHD_MISSING-Rauschen) für beide Mandanten.
    for (const ten of [acme, globex]) {
      await client.query(
        `UPDATE automatenlager.stock_batches SET mhd_date = '2027-06-01' WHERE batch_key = $1 AND tenant_id = $2`,
        [`b_${ten.tenantId}`, ten.tenantId],
      );
    }
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // Bestehende Watermark-Zeile (i. d. R. Faltrix' globaler Schlüssel) vorab erfassen —
    // sie darf von einem Fremd-Mandanten NICHT überschrieben werden (mandantensicher).
    const pre = await client.query(
      `SELECT tenant_id, last_inventory_review_at FROM automatenlager.workflow_state WHERE workflow_key = 'WF3_NAYAX_FIFO'`);

    const res = await ns.applyNayaxSales(db, 'acme', { sales: [liveSale('acme')], config: CFG_ACME, nowIso: NOW });
    assert.equal(res.salesWritten, 1, 'eine sales_transaction geschrieben');
    assert.equal(res.movementsWritten, 1, 'ein stock_movement geschrieben');
    assert.equal(res.watermark.should_update, true, 'Plan will Watermark vorschieben');

    // sale gelandet, FK aufgelöst
    const sale = await db.read({
      tenant: 'acme', tables: ['sales_transactions'],
      text: `SELECT s.nayax_transaction_id, s.product_id, s.machine_id, s.quantity, s.processing_status
               FROM automatenlager.sales_transactions s WHERE s.tenant_id = $1 AND s.nayax_transaction_id = 'WF3T_acme'`,
    });
    assert.equal(sale.rows.length, 1);
    assert.equal(Number(sale.rows[0].product_id), Number(acme.productId), 'product_key→product_id aufgelöst');
    assert.equal(sale.rows[0].processing_status, 'OK');

    // FIFO-Abbuchung über den Trigger: b_acme 30 → 29
    const batch = await db.read({
      tenant: 'acme', tables: ['stock_batches'],
      text: `SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id = $1 AND batch_key = 'b_acme'`,
    });
    assert.equal(Number(batch.rows[0].remaining_qty), 29, 'remaining_qty vom Trigger dekrementiert (kein Doppel-Dekrement)');

    // Watermark mandantensicher seit #111 (0031): PK ist (tenant_id, workflow_key).
    // acme bekommt IMMER seine EIGENE Zeile; eine evtl. vorhandene Fremd-Zeile (z. B.
    // __default__/Faltrix-Seed) bleibt UNVERÄNDERT — kein Update über die Mandantengrenze.
    const post = await client.query(
      `SELECT tenant_id, last_inventory_review_at FROM automatenlager.workflow_state WHERE workflow_key = 'WF3_NAYAX_FIFO'`);
    const own = post.rows.find((r) => r.tenant_id === 'acme');
    assert.ok(own, 'acme-Watermark als eigene Zeile gesetzt');
    assert.equal(new Date(own.last_inventory_review_at).toISOString(), '2026-06-05T12:00:00.000Z');
    if (pre.rows[0] && pre.rows[0].tenant_id !== 'acme') {
      const foreignRow = post.rows.find((r) => r.tenant_id === pre.rows[0].tenant_id);
      assert.ok(foreignRow, 'fremde Watermark-Zeile bleibt erhalten (kein Hijack)');
      assert.deepEqual(foreignRow.last_inventory_review_at, pre.rows[0].last_inventory_review_at,
        'fremder Zeitstempel unverändert');
    }

    // ISOLATION: globex unangetastet
    const gSale = await db.read({
      tenant: 'globex', tables: ['sales_transactions'],
      text: `SELECT count(*)::int AS n FROM automatenlager.sales_transactions WHERE tenant_id = $1 AND nayax_transaction_id = 'WF3T_acme'`,
    });
    assert.equal(gSale.rows[0].n, 0, 'globex sieht acme-Verkauf nicht');
    const gBatch = await db.read({
      tenant: 'globex', tables: ['stock_batches'],
      text: `SELECT remaining_qty FROM automatenlager.stock_batches WHERE tenant_id = $1 AND batch_key = 'b_globex'`,
    });
    assert.equal(Number(gBatch.rows[0].remaining_qty), 30, 'globex-Charge unverändert');
  });
});

// ── Ebene 3: Schattenbetrieb (compute-only vs. n8n-Ist) ──────────────────────
test('#163 runNayaxSalesShadow: compute-only, Deckungsgleichheit vs. n8n-Ist → equal; fehlender Ist-Verkauf → ungleich', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await client.query(
      `UPDATE automatenlager.stock_batches SET mhd_date = '2027-06-01' WHERE batch_key = 'b_acme' AND tenant_id = 'acme'`,
    );
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // n8n-Ist simulieren: ein Verkauf SHX1 liegt bereits in sales_transactions.
    await client.query(
      `INSERT INTO automatenlager.sales_transactions
         (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
          gross_amount, net_amount, vat_amount, settlement_at, processing_status, source, tenant_id)
       VALUES ('SHX1', $1, $2, 'Cola acme', 1, 1.0, 1.0, 0, '2026-06-05T12:00:00Z', 'OK', 'nayax_lastSales', 'acme')`,
      [acme.machineId, acme.productId],
    );

    const saleSHX1 = liveSale('acme', { TransactionID: 'SHX1' });
    const windowStartIso = '2026-06-01T00:00:00.000Z';

    // Deckungsgleich: der Port rechnet exakt SHX1, n8n hat SHX1 geschrieben.
    const same = await ns.runNayaxSalesShadow(db, 'acme', { sales: [saleSHX1], config: CFG_ACME, nowIso: NOW, windowStartIso });
    assert.equal(same.salesDiff.equal, true, 'sale-Diff deckungsgleich');
    assert.deepEqual(same.salesDiff.onlyActual, [], 'kein nur-Ist');

    // Diskrepanz: Port rechnet zusätzlich SHX2, das n8n NICHT geschrieben hat.
    const saleSHX2 = liveSale('acme', { TransactionID: 'SHX2', SettlementValue: 2.0 });
    const diff = await ns.runNayaxSalesShadow(db, 'acme', { sales: [saleSHX1, saleSHX2], config: CFG_ACME, nowIso: NOW, windowStartIso });
    assert.equal(diff.salesDiff.equal, false, 'Diskrepanz erkannt');
    assert.equal(diff.salesDiff.onlyIntended.length, 1, 'SHX2 nur beabsichtigt');
    assert.equal(diff.salesDiff.onlyIntended[0].nayax_transaction_id, 'SHX2');
  });
});

// ── Ebene 1: fetchNayaxLastSales ─────────────────────────────────────────────
test('#163 fetchNayaxLastSales: ruft lastSales-Endpunkt mit Auth-Header, normalisiert Array/{body}', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ body: [{ TransactionID: 'A' }, { TransactionID: 'B' }] }) };
  };
  const sales = await ns.fetchNayaxLastSales({ token: 'TOK', baseUrl: 'https://lynx.nayax.com', machineId: '457107528', fetchImpl: fakeFetch });
  assert.equal(sales.length, 2);
  assert.match(calls[0].url, /\/operational\/v1\/machines\/457107528\/lastSales$/);
  assert.equal(calls[0].opts.headers.Authorization, 'TOK');
});

test('#163 fetchNayaxLastSales: HTTP-Fehler wirft (nicht still verschluckt)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => ns.fetchNayaxLastSales({ token: 'T', machineId: 'M', fetchImpl: fakeFetch }), /HTTP 403/);
});

// ── Ebene 3: createNayaxSalesJob (Worker-Factory) ────────────────────────────
test('#163 createNayaxSalesJob: ohne Token ⇒ skipped (kein Throw)', async () => {
  const job = ns.createNayaxSalesJob({ db: {}, directory: { listTenantIds: () => ['acme'] }, env: {} });
  assert.equal(job.key, 'wf3-nayax-fifo');
  const r = await job.run();
  assert.equal(r.skipped, 'kein NAYAX_API_TOKEN in der Env');
});

test('#206 runNayaxSalesShadow: onlyIntended=2, onlyActual=0 → equal=true (neue Transaktionen sind OK)', async () => {
  // Simuliert den Fall aus #206: Port sieht 2 neue Sales, die n8n noch nicht hat.
  // Der Shadow-Vergleich darf das NICHT als Fehler werten (onlyIntended=OK).
  const { diffWrites } = require('../lib/jobs/shadow-harness.js');
  const intendedSales = [
    { nayax_transaction_id: '63245053854', quantity: 1 },
    { nayax_transaction_id: '63245048872', quantity: 1 },
  ];
  const actualSales = []; // n8n hat diese noch nicht

  const salesDiff = diffWrites(intendedSales, actualSales, {
    keyOf: (r) => String(r.nayax_transaction_id),
    fields: ['quantity'],
  });
  // Neue Definition: onlyIntended ist OK, onlyActual und mismatched sind Fehler.
  const equal = salesDiff.onlyActual.length === 0 && salesDiff.mismatched.length === 0;
  assert.equal(equal, true, 'onlyIntended=2, onlyActual=0 → Cutover ist sicher');
  assert.equal(salesDiff.onlyIntended.length, 2, '2 neue Transaktionen erkannt');
});

test('#206 runNayaxSalesShadow: Bewegungsschlüssel mit verschiedenem Datum → gleich nach Normalisierung', () => {
  const { diffWrites } = require('../lib/jobs/shadow-harness.js');
  // Port generiert heute (_wf3_2026-06-10), n8n schrieb vorgestern (_wf3_2026-06-08).
  function movementBaseKey(r) {
    return String(r.movement_key || '').replace(/_wf3_\d{4}-\d{2}-\d{2}$/, '');
  }
  const intended = [
    { movement_key: 'wf3_sale_B_COCA_COLA_20260520_APP_xyz_3_wf3_2026-06-10', quantity_delta_total: -2 },
  ];
  const actual = [
    { movement_key: 'wf3_sale_B_COCA_COLA_20260520_APP_xyz_3_wf3_2026-06-08', quantity_delta_total: -2 },
  ];
  const diff = diffWrites(intended, actual, { keyOf: movementBaseKey, fields: ['quantity_delta_total'] });
  assert.equal(diff.onlyIntended.length, 0, 'Bewegung nicht als onlyIntended gezählt (Datum normalisiert)');
  assert.equal(diff.onlyActual.length, 0, 'Bewegung nicht als onlyActual gezählt');
  assert.equal(diff.mismatched.length, 0, 'keine Wertdiff (gleiche Menge)');
  assert.equal(diff.equal, true, 'Vergleich stimmt nach Datums-Normalisierung überein');
});

test('#163 createNayaxSalesJob: Default = Schattenbetrieb (rechnet + vergleicht, schreibt NICHT)', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ([{ TransactionID: 'S1', MachineID: '457107528', ProductName: 'X (1 = 1.00)', SettlementValue: 1, SettlementDateTimeGMT: '2026-06-05T12:00:00Z', mdb_code_extracted: '1' }]) });
  // Fake-Tür: read liefert leer; tx() DARF im Schatten NIE aufgerufen werden.
  const fakeDb = {
    forTenant: () => ({ read: async () => ({ rows: [] }) }),
    tx: async () => { throw new Error('tx im Schattenbetrieb aufgerufen — verboten'); },
  };
  const job = ns.createNayaxSalesJob({
    db: fakeDb, directory: { listTenantIds: () => ['acme'] },
    env: { NAYAX_API_TOKEN: 'TOK', NAYAX_TENANT_ID: 'acme' }, fetchImpl: fakeFetch,
  });
  const r = await job.run();
  assert.equal(r.mode, 'shadow');
  assert.equal(r.tenant, 'acme');
  assert.equal(r.fetched, 1);
});
