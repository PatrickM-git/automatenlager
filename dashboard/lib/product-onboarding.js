'use strict';

function deriveProductStatus(product) {
  if (Number(product.active_slots) > 0) return 'verkaufsbereit';
  if (Number(product.nayax_alias_count) > 0) return 'slot_offen';
  if (Number(product.alias_count) > 0) return 'bereit_fur_moma';
  return 'intern_erstellt';
}

function buildPendingApprovals(rows) {
  const invoiceMap = new Map();
  for (const row of rows) {
    if (row.product_id != null) continue;
    if (!invoiceMap.has(row.invoice_key)) {
      invoiceMap.set(row.invoice_key, {
        invoice_key: row.invoice_key,
        invoice_number: row.invoice_number,
        supplier_name: row.supplier_name,
        invoice_date: row.invoice_date,
        open_items: 0,
      });
    }
    invoiceMap.get(row.invoice_key).open_items += 1;
  }
  return [...invoiceMap.values()];
}

function buildUnknownProducts(rows) {
  return [...rows].sort((a, b) => Number(b.tx_count) - Number(a.tx_count));
}

function buildProductOnboardingData({ productRows, invoiceRows, orphanRows, totalInvoices }) {
  const statusGroups = { intern_erstellt: [], bereit_fur_moma: [], slot_offen: [], verkaufsbereit: [] };
  for (const row of productRows) {
    const status = deriveProductStatus(row);
    statusGroups[status].push({ product_id: row.product_id, product_key: row.product_key, name: row.name });
  }
  return {
    total_invoices: totalInvoices ?? 0,
    pending_approvals: buildPendingApprovals(invoiceRows),
    unknown_products: buildUnknownProducts(orphanRows),
    products_by_status: statusGroups,
  };
}

async function queryProductOnboardingPg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    const [productsRes, invoicesRes, orphansRes, invoiceCountRes] = await Promise.all([
      client.query(`
        SELECT
          p.product_id,
          p.product_key,
          p.name,
          COUNT(pa.alias_id)::int                                                     AS alias_count,
          COUNT(pa.alias_id) FILTER (WHERE pa.source = 'nayax')::int                 AS nayax_alias_count,
          COUNT(sa.slot_assignment_id) FILTER (WHERE sa.active = true)::int          AS active_slots
        FROM automatenlager.products p
        LEFT JOIN automatenlager.product_aliases pa ON pa.product_id = p.product_id
        LEFT JOIN automatenlager.slot_assignments sa ON sa.product_id = p.product_id
        GROUP BY p.product_id, p.product_key, p.name
        ORDER BY p.name
      `),
      client.query(`
        SELECT
          i.invoice_key,
          i.invoice_number,
          s.name   AS supplier_name,
          i.invoice_date::text AS invoice_date,
          ii.product_id,
          ii.line_number
        FROM automatenlager.invoice_items ii
        JOIN automatenlager.invoices i ON i.invoice_id = ii.invoice_id
        JOIN automatenlager.suppliers s ON s.supplier_id = i.supplier_id
        ORDER BY i.invoice_date DESC, i.invoice_key, ii.line_number
      `),
      // Unbekannte (nicht zugeordnete) Verkäufe: in sales_transactions gibt es
      // KEINE Spalte product_key — der Roh-Produktname steht in product_name_raw.
      // Wir liefern ihn als product_key, damit das Onboarding (Nayax-Produktname)
      // unverändert weiterarbeitet.
      client.query(`
        SELECT
          st.product_name_raw AS product_key,
          COUNT(*)::int AS tx_count
        FROM automatenlager.sales_transactions st
        WHERE st.product_id IS NULL
          AND st.product_name_raw IS NOT NULL
          AND st.product_name_raw <> ''
        GROUP BY st.product_name_raw
        ORDER BY tx_count DESC
      `),
      client.query('SELECT COUNT(*)::int AS total FROM automatenlager.invoices'),
    ]);

    return {
      productRows: productsRes.rows,
      invoiceRows: invoicesRes.rows,
      orphanRows: orphansRes.rows,
      totalInvoices: invoiceCountRes.rows[0]?.total ?? 0,
    };
  } finally {
    await client.end();
  }
}

module.exports = {
  deriveProductStatus,
  buildPendingApprovals,
  buildUnknownProducts,
  buildProductOnboardingData,
  queryProductOnboardingPg,
};
