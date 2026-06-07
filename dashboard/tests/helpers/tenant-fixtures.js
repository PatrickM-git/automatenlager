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

// Die Schreib-Zielrelationen der Stufe-4-Schreibpfade (#131): jede trägt nach
// seedTenant für BEIDE Mandanten Zeilen, damit jeder folgende Isolationstest
// (#135–#138) NICHT-VAKUÖS ist — der jeweils andere Mandant hat in der Ziel-
// relation wirklich Zeilen, die der Viewer nicht anfassen darf.
//   locations          ← location-profiles (#135)
//   machines/machine_profiles ← machine-create/-profiles (#136)
//   settings_thresholds ← settings-thresholds (#137)
//   stock_batches/warnings    ← write-off (#138)
const WRITE_PATH_TABLES = Object.freeze([
  'locations', 'machines', 'machine_profiles', 'settings_thresholds', 'stock_batches', 'warnings',
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

// Pool-Attrappe für db.tx() IM #94-Sandbox-Harness (#131): Der Sandbox-Client
// läuft bereits in einer äußeren BEGIN…ROLLBACK-Transaktion. Würde db.tx ein
// echtes BEGIN/COMMIT auf ihm fahren, committete es die ÄUSSERE Transaktion und
// bräche die Rollback-Garantie (echte DB-Mutation!). Daher bildet dieser Pool
// die Transaktions-Primitive auf SAVEPOINTs ab: BEGIN→SAVEPOINT, COMMIT→RELEASE,
// ROLLBACK→ROLLBACK TO SAVEPOINT. So bleibt alles in der äußeren Transaktion,
// die Rollback-Semantik von db.tx ist trotzdem nicht-vakuös beweisbar, und der
// abschließende äußere ROLLBACK verwirft garantiert alles. Reines Test-Hilfsmittel.
function sandboxTxPool(client) {
  let counter = 0;
  return {
    query: (sql, params) => client.query(sql, params),
    connect: async () => {
      const sp = `tenant_db_tx_${++counter}`;
      let opened = false;
      return {
        query: async (sql, params) => {
          const s = String(sql).trim().toUpperCase();
          if (s === 'BEGIN') { opened = true; return client.query(`SAVEPOINT ${sp}`); }
          if (s === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${sp}`);
          if (s === 'ROLLBACK') return opened ? client.query(`ROLLBACK TO SAVEPOINT ${sp}`) : { rows: [], rowCount: 0 };
          return client.query(sql, params);
        },
        release: () => {},
      };
    },
  };
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

  // 9) Aktive Slot-Zuordnung (Sortiment-Lesepfad: assortment-slots liest FROM
  // slot_assignments). Mandanten-treu: Automat/Produkt desselben Mandanten.
  await client.query(
    `INSERT INTO automatenlager.slot_assignments
       (product_slot_key, machine_id, mdb_code, product_id, valid_from, active, current_machine_qty, tenant_id)
       VALUES ($1, $2, 10, $3, '2026-01-01', TRUE, 5, $4)`,
    [`slot_${tid}`, machineId, productId, tid],
  );

  // 10) Automaten-Profil (Lesepfad machine-profiles, #127). machine_id = machine_key.
  await client.query(
    `INSERT INTO automatenlager.machine_profiles (machine_id, area, nickname, tenant_id)
       VALUES ($1, $2, $3, $4)`,
    [`vm_${tid}`, `Bereich ${tid}`, `Automat ${tid}`, tid],
  );

  // 11) Nayax-Gerät (Lesepfad nayax-devices, #127). Nutzersichtbare Zuordnung.
  await client.query(
    `INSERT INTO automatenlager.nayax_devices (nayax_machine_id, machine_number, machine_name, tenant_id)
       VALUES ($1, $2, $3, $4)`,
    [`nx_${tid}`, `${tid}-1`, `Gerät ${tid}`, tid],
  );

  // 12) Schwellwert (Schreib-Zielrelation settings_thresholds, #137). Mandanten-
  // Ebene (machine_id NULL). Wert je Mandant UNTERSCHEIDBAR (= base), damit
  // Side-Effects-/Isolationstests nicht-vakuös sind und ein Cross-Tenant-Leak
  // sichtbar würde. Constraint UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id, key).
  await client.query(
    `INSERT INTO automatenlager.settings_thresholds (tenant_id, machine_id, key, value, updated_at)
       VALUES ($1, NULL, 'ladenhueterDays', $2::jsonb, now())`,
    [tid, JSON.stringify(base)],
  );

  return { tenantId: tid, locationId, machineId, productId, productName, revenueGross: gross, slotKey: `slot_${tid}`, thresholdValue: base };
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

module.exports = { seedTenant, seedAcmeGlobex, READ_PATH_TABLES, WRITE_PATH_TABLES, doorForClient, sandboxTxPool };
