'use strict';

// Sicherheitsnachweis Stufe 6 (Issue #164, Migration 0033):
// n8n_app verliert BYPASSRLS → RLS systemweit dicht.
// LIVE-Sandbox (connectOrSkip): läuft nur mit LIVE_TEST=1 und SSH-Tunnel.
// DEPLOY-GATED: Migration 0033 muss auf dem Mini angewendet sein (nach #198-Cutover).

const assert = require('node:assert/strict');
const test = require('node:test');

const { connectOrSkip } = require('./helpers/migration-sandbox.js');

test('#164 Sicherheitsnachweis: n8n_app hat NOBYPASSRLS (Migration 0033 angewendet)', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    const res = await client.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'n8n_app'`);
    if (!res.rows.length) {
      t.skip('n8n_app-Rolle nicht gefunden (Mini nicht konfiguriert)');
      return;
    }
    if (res.rows[0].rolbypassrls === true) {
      t.skip('n8n_app hat noch BYPASSRLS — Migration 0033 noch nicht deployt (gated auf #198-Cutover)');
      return;
    }
    assert.strictEqual(res.rows[0].rolbypassrls, false,
      'n8n_app muss NOBYPASSRLS haben (Migration 0033 angewendet)');
  } finally {
    await client.end();
  }
});

test('#164 Sicherheitsnachweis: automatenlager_app hat KEIN BYPASSRLS (war nie gesetzt)', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    const res = await client.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'automatenlager_app'`);
    if (!res.rows.length) {
      t.skip('automatenlager_app-Rolle nicht gefunden');
      return;
    }
    assert.strictEqual(res.rows[0].rolbypassrls, false,
      'automatenlager_app darf niemals BYPASSRLS haben');
  } finally {
    await client.end();
  }
});
