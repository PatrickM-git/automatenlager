'use strict';

function clean(value) {
  return String(value ?? '').trim();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildProposalCase(p) {
  const payload = p.payload ?? {};
  const report = clean(p.reason) || `${clean(p.proposal_type)} an MDB ${p.mdb_code}`;
  return {
    case_id: `proposal_${p.proposal_id ?? p.proposal_key}`,
    case_type: 'mdb_proposal',
    created_at: p.created_at ?? null,
    machine_id: p.machine_id ?? null,
    mdb_code: p.mdb_code ?? null,
    product_id: p.product_id ?? null,
    slot_assignment_id: p.slot_assignment_id ?? null,
    nayax_report: report,
    expected_product: p.product_name ?? null,
    affected_tx_count: toNum(p.affected_tx_count),
    message: report,
    wf4_auto_start: payload.wf4_auto_start === true,
    proposal_key: p.proposal_key ?? null,
    proposal_type: p.proposal_type ?? null,
    suggested_product_id: payload.suggested_product_id ?? null,
    suggested_product_name: payload.suggested_product_name ?? null,
  };
}

function buildUnknownTxCase(g) {
  const report = `Unbekanntes Nayax-Produkt: ${clean(g.product_name_raw || g.product_key)} (MDB ${g.mdb_code ?? '?'})`;
  return {
    case_id: `unknown_${clean(g.product_key).replace(/\s+/g, '_')}`,
    case_type: 'unknown_product',
    created_at: g.first_seen_at ?? null,
    machine_id: g.machine_id ?? null,
    mdb_code: g.mdb_code ?? null,
    product_id: null,
    slot_assignment_id: null,
    nayax_report: report,
    expected_product: null,
    affected_tx_count: toNum(g.tx_count),
    message: report,
    wf4_auto_start: false,
    product_key: g.product_key ?? null,
    last_seen_at: g.last_seen_at ?? null,
  };
}

function buildWarningCase(w) {
  const report = clean(w.message) || `${clean(w.warning_type)} an MDB ${w.mdb_code ?? '?'}`;
  return {
    case_id: `warning_${w.warning_id ?? w.warning_key}`,
    case_type: 'correction_warning',
    created_at: w.created_at ?? null,
    machine_id: w.machine_id ?? null,
    mdb_code: w.mdb_code ?? null,
    product_id: w.product_id ?? null,
    slot_assignment_id: w.slot_assignment_id ?? null,
    nayax_report: report,
    expected_product: null,
    affected_tx_count: 0,
    message: report,
    wf4_auto_start: false,
    warning_type: w.warning_type ?? null,
    warning_key: w.warning_key ?? null,
  };
}

function buildCorrectionCases({ proposals = [], unknownTxGroups = [], correctionWarnings = [] } = {}) {
  const openProposals = proposals.filter((p) => clean(p.status) === 'open');

  const cases = [
    ...openProposals.map(buildProposalCase),
    ...unknownTxGroups.map(buildUnknownTxCase),
    ...correctionWarnings.map(buildWarningCase),
  ];

  return {
    cases,
    counts: {
      mdb_proposals: openProposals.length,
      unknown_products: unknownTxGroups.length,
      correction_warnings: correctionWarnings.length,
      total: cases.length,
    },
  };
}

async function queryCorrectionCasesPg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const [proposalsRes, unknownTxRes, warningsRes] = await Promise.all([
      client.query(`
        SELECT
          pcp.proposal_id,
          pcp.proposal_key,
          pcp.proposal_type,
          pcp.machine_id,
          pcp.mdb_code,
          pcp.product_id,
          p.name AS product_name,
          pcp.reason,
          pcp.status,
          pcp.payload,
          pcp.created_at::text AS created_at
        FROM automatenlager.product_change_proposals pcp
        LEFT JOIN automatenlager.products p ON p.product_id = pcp.product_id
        WHERE pcp.status = 'open'
          AND pcp.proposal_type IN ('MDB_PRODUCT_MAPPING_MISMATCH', 'MDB_CODE_CHANGED_FOR_PRODUCT')
        ORDER BY pcp.created_at DESC
        LIMIT 100
      `),
      client.query(`
        SELECT
          st.product_key,
          MAX(st.product_name_raw) AS product_name_raw,
          MAX(st.machine_id)       AS machine_id,
          MAX(st.mdb_code)         AS mdb_code,
          COUNT(*)::int            AS tx_count,
          MIN(st.settlement_at)::text AS first_seen_at,
          MAX(st.settlement_at)::text AS last_seen_at
        FROM automatenlager.sales_transactions st
        WHERE st.product_id IS NULL
          AND st.product_key IS NOT NULL
          AND st.product_key <> ''
        GROUP BY st.product_key
        ORDER BY tx_count DESC
        LIMIT 100
      `),
      client.query(`
        SELECT
          w.warning_id,
          w.warning_key,
          w.warning_type,
          w.severity,
          w.product_id,
          w.machine_id,
          w.mdb_code,
          w.slot_assignment_id,
          w.message,
          w.created_at::text AS created_at
        FROM automatenlager.warnings w
        WHERE w.resolved = FALSE
          AND w.warning_type IN ('MDB_CODE_CHANGED_FOR_PRODUCT', 'UNMATCHED_PRODUCT')
        ORDER BY w.created_at DESC
        LIMIT 100
      `),
    ]);

    return {
      proposals: proposalsRes.rows,
      unknownTxGroups: unknownTxRes.rows,
      correctionWarnings: warningsRes.rows,
    };
  } finally {
    await client.end();
  }
}

module.exports = {
  buildCorrectionCases,
  queryCorrectionCasesPg,
};
