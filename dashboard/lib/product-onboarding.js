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

// #128 (Stufe 3): mandantengetrennt durch die Mandanten-Tür (Lesepfad). Mandant = $1.
async function queryProductOnboardingPg(db, tenant) {
  const [productsRes, invoicesRes, orphansRes, invoiceCountRes] = await Promise.all([
    db.read({ tenant, tables: ['products', 'product_aliases', 'slot_assignments'], params: [], text: `
        SELECT
          p.product_id,
          p.product_key,
          p.name,
          COUNT(pa.alias_id)::int                                                     AS alias_count,
          COUNT(pa.alias_id) FILTER (WHERE pa.source = 'nayax')::int                 AS nayax_alias_count,
          COUNT(sa.slot_assignment_id) FILTER (WHERE sa.active = true)::int          AS active_slots
        FROM automatenlager.products p
        LEFT JOIN automatenlager.product_aliases pa ON pa.product_id = p.product_id AND pa.tenant_id = p.tenant_id
        LEFT JOIN automatenlager.slot_assignments sa ON sa.product_id = p.product_id AND sa.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1
        GROUP BY p.product_id, p.product_key, p.name
        ORDER BY p.name
      ` }),
    db.read({ tenant, tables: ['invoice_items', 'invoices', 'suppliers'], params: [], text: `
        SELECT
          i.invoice_key,
          i.invoice_number,
          s.name   AS supplier_name,
          i.invoice_date::text AS invoice_date,
          ii.product_id,
          ii.line_number
        FROM automatenlager.invoice_items ii
        JOIN automatenlager.invoices i ON i.invoice_id = ii.invoice_id AND i.tenant_id = ii.tenant_id
        JOIN automatenlager.suppliers s ON s.supplier_id = i.supplier_id AND s.tenant_id = i.tenant_id
        WHERE ii.tenant_id = $1
        ORDER BY i.invoice_date DESC, i.invoice_key, ii.line_number
      ` }),
    // Unbekannte (nicht zugeordnete) Verkäufe: Roh-Produktname in product_name_raw.
    db.read({ tenant, tables: ['sales_transactions'], params: [], text: `
        SELECT
          st.product_name_raw AS product_key,
          COUNT(*)::int AS tx_count
        FROM automatenlager.sales_transactions st
        WHERE st.tenant_id = $1
          AND st.product_id IS NULL
          AND st.product_name_raw IS NOT NULL
          AND st.product_name_raw <> ''
        GROUP BY st.product_name_raw
        ORDER BY tx_count DESC
      ` }),
    db.read({ tenant, tables: ['invoices'], params: [], text: 'SELECT COUNT(*)::int AS total FROM automatenlager.invoices WHERE tenant_id = $1' }),
  ]);

  return {
    productRows: productsRes.rows,
    invoiceRows: invoicesRes.rows,
    orphanRows: orphansRes.rows,
    totalInvoices: invoiceCountRes.rows[0]?.total ?? 0,
  };
}

module.exports = {
  deriveProductStatus,
  buildPendingApprovals,
  buildUnknownProducts,
  buildProductOnboardingData,
  queryProductOnboardingPg,
};
