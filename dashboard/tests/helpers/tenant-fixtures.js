'use strict';

/**
 * acme/globex-Fixtures (Issue #122, Stufe 3) — beidseitige, FK-konsistente
 * Test-Mandanten für die Lese-Isolationstests der Slices #123ff.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md §"Testing Decisions"
 *
 * NUR im #94-Sandbox-Harness verwenden (inSandbox/withRollback): JEDE Mutation
 * läuft in einer Transaktion mit garantiertem ROLLBACK — echte Faltrix-Daten
 * bleiben unberührt. Geschäftsschlüssel sind mit dem (synthetischen) Mandanten
 * präfixiert, damit sie weder untereinander noch mit echten Daten kollidieren
 * (tenant-unique business keys, Migration 0012) und mandanten-treu sind
 * (Composite-FKs, Migration 0013): jede Kind-Zeile referenziert Eltern desselben
 * Mandanten.
 *
 * Kette je Mandant: location → machine → product → stock_batch
 *                   → sales_transaction → guv_daily → warning.
 */

// Die Kern-Lesetabellen, in denen jeder synthetische Mandant Daten trägt.
const READ_PATH_TABLES = Object.freeze([
  'locations', 'machines', 'products', 'stock_batches', 'sales_transactions', 'guv_daily', 'warnings',
]);

// Mandanten-Tür über EINEN Sandbox-Client. Die Door-Konsumenten nutzen z. T.
// Promise.all (mehrere Reads gleichzeitig) — ein einzelner pg-Client kann aber
// keine parallelen Queries fahren (Produktion nutzt einen Pool). Daher hier
// serialisieren: jede Query wartet auf die vorherige. Reines Test-Hilfsmittel.
function doorForClient(client) {
  const { createTenantDb } = require('../../lib/tenant-db.js');
  let tail = Promise.resolve();
  const query = (sql, params) => {
    const result = tail.then(() => client.query(sql, params));
    tail = result.catch(() => {}); // Kette auch nach Fehler am Leben halten
    return result;
  };
  return createTenantDb({ query });
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Legt für EINEN Mandanten eine vollständige, unterscheidbare Lesepfad-Kette an.
 * @param {import('pg').Client} client  Sandbox-Client (in einer Rollback-Transaktion)
 * @param {string} tenantId             z. B. 'acme'
 * @param {object} [opts]
 * @param {number} [opts.revenueBase]   Brutto-Basisbetrag (macht Aggregate unterscheidbar)
 * @returns {Promise<object>}           erzeugte IDs/Marker für Assertions
 */
// Gemeinsamer Advisory-Lock-Schlüssel (eine Quelle: migration-sandbox.js). Serialisiert
// Fixture-DML mit Migrations-DDL über konkurrierende Sandbox-Transaktionen (node --test
// fährt Dateien parallel) — sonst DDL(ALTER)-vs-DML(INSERT)-Deadlock. ROLLBACK gibt frei.
const { SANDBOX_LOCK_KEY } = require('./migration-sandbox.js');

async function seedTenant(client, tenantId, opts = {}) {
  if (!tenantId) throw new Error('seedTenant: tenantId erforderlich');
  const tid = String(tenantId);

  // Konkurrierende Sandbox-Transaktionen (DDL + DML) serialisieren (Deadlock-Schutz).
  await client.query('SELECT pg_advisory_xact_lock($1)', [SANDBOX_LOCK_KEY]);
  const base = Number.isFinite(opts.revenueBase) ? opts.revenueBase : 100;
  const vat = 19;
  const gross = round2(base);
  const net = round2(gross / (1 + vat / 100));
  const vatAmount = round2(gross - net);
  const cost = round2(gross * 0.5);
  const grossProfit = round2(gross - cost);
  const productName = `Cola ${tid}`;

  // 1) Mandant (FK-Ziel aller operativen Tabellen). Idempotent.
  await client.query(
    `INSERT INTO automatenlager.tenants (tenant_id, name)
       VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [tid, `Test-Mandant ${tid}`],
  );

  // 2) Standort
  const loc = await client.query(
    `INSERT INTO automatenlager.locations (location_key, name, location_type, tenant_id)
       VALUES ($1, $2, 'automat', $3) RETURNING location_id`,
    [`loc_${tid}`, `Standort ${tid}`, tid],
  );
  const locationId = loc.rows[0].location_id;

  // 3) Automat (mandanten-treu: Standort desselben Mandanten)
  const mch = await client.query(
    `INSERT INTO automatenlager.machines (machine_key, name, location_id, tenant_id)
       VALUES ($1, $2, $3, $4) RETURNING machine_id`,
    [`vm_${tid}`, `Automat ${tid}`, locationId, tid],
  );
  const machineId = mch.rows[0].machine_id;

  // 4) Produkt
  const prd = await client.query(
    `INSERT INTO automatenlager.products (product_key, name, category, vat_rate_pct, tenant_id)
       VALUES ($1, $2, 'snack', $3, $4) RETURNING product_id`,
    [`p_${tid}`, productName, vat, tid],
  );
  const productId = prd.rows[0].product_id;

  // 5) Lagercharge (FIFO-Basis)
  await client.query(
    `INSERT INTO automatenlager.stock_batches
       (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, tenant_id)
       VALUES ($1, $2, 50, 30, $3, 'active', '2026-05-01', $4)`,
    [`b_${tid}`, productId, round2(cost / 10), tid],
  );

  // 6) Verkaufstransaktion (Live-/Provisional-Lesepfad)
  await client.query(
    `INSERT INTO automatenlager.sales_transactions
       (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
        gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1, $2, $3, $4, 10, $5, $6, $7, '2026-05-15T10:00:00Z', 'matched', $8)`,
    [`tx_${tid}`, machineId, productId, productName, gross, net, vatAmount, tid],
  );

  // 7) GuV-Tagesposten (Finanz-Aggregat-Lesepfad)
  await client.query(
    `INSERT INTO automatenlager.guv_daily
       (guv_key, posting_date, machine_id, product_id, quantity_sold,
        revenue_gross, revenue_net, cost_of_goods, gross_profit, source, tenant_id)
       VALUES ($1, '2026-05-15', $2, $3, 10, $4, $5, $6, $7, 'wf8_daily', $8)`,
    [`guv_${tid}_20260515`, machineId, productId, gross, net, cost, grossProfit, tid],
  );

  // 8) Warnung (Monitoring/Alert-Lesepfad). Typ WORKFLOW_ERROR ⇒ überlebt den
  // liveWarningReconcileSql-Self-Healing-Filter (ELSE TRUE), damit Monitoring-
  // Isolationstests nicht-vakuös sind (kein Slot-Fixture nötig).
  await client.query(
    `INSERT INTO automatenlager.warnings
       (warning_key, warning_type, message, source_workflow, machine_id, product_id, tenant_id)
       VALUES ($1, 'WORKFLOW_ERROR', $2, 'wf5', $3, $4, $5)`,
    [`warn_${tid}`, `Test-Warnung ${tid}`, machineId, productId, tid],
  );

  return { tenantId: tid, locationId, machineId, productId, productName, revenueGross: gross };
}

/**
 * Standard-Paar acme/globex mit UNTERSCHEIDBAREN Daten (verschiedene Umsätze),
 * damit Isolations- und Aggregat-Tests nicht-vakuös sind.
 */
async function seedAcmeGlobex(client) {
  const acme = await seedTenant(client, 'acme', { revenueBase: 100 });
  const globex = await seedTenant(client, 'globex', { revenueBase: 250 });
  return { acme, globex };
}

module.exports = { seedTenant, seedAcmeGlobex, READ_PATH_TABLES, doorForClient };
