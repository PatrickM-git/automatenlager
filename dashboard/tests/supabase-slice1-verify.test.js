'use strict';

/**
 * Supabase Slice 1 (Cloud-Migration Phase B, Issue #214) — Verifikationssuite.
 * ---------------------------------------------------------------------------
 * Beweist gegen die ECHTE Supabase-DB (Projekt Faltrix, eu-central-1), dass der
 * DB-Port vollständig ist: Rollen-Split ohne Custom-BYPASSRLS, Migrationen
 * 0001–0036 angewendet, RLS aktiv, fail-closed GUC-Verhalten (42704) und die
 * migrierten Faltrix-Daten plausibel.
 *
 * Verbindet über SUPABASE_PG_URL_SESSION (Session-Pooler, Port 5432) aus der
 * Prozess-Umgebung oder .env.local — ohne die URL skippt die Suite sauber
 * (CI/offline). Alle Mutationen laufen in einer ROLLBACK-Transaktion.
 *
 * Bewusste Abweichung von der SPEC (dokumentiert im Runbook
 * docs/cloud-migration/slice-1-db-supabase-runbook.md): KEINE DB-weite
 * GUC-Vorregistrierung via `ALTER DATABASE … SET automatenlager.current_tenant`,
 * weil ein registrierter Leerwert das fail-closed-Verhalten (42704 bei fehlendem
 * Mandanten, Test 0034) aufweichen würde. `set_config(..., true)` funktioniert
 * auf Supabase auch ohne Vorregistrierung (live verifiziert).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_ROOT = path.join(__dirname, '..');

// Repräsentative RLS-Tabellen je Policy-Gruppe (identisch zur Negativ-Matrix
// in dashboard-mt-rls-isolation.test.js).
const RLS_TABLES = [
  'products', 'locations', 'stock_batches',
  'guv_daily', 'warnings',
  'sales_transactions', 'nayax_devices',
  'settings_thresholds',
];

function resolveSupabaseUrl() {
  const fromEnv = process.env.SUPABASE_PG_URL_SESSION;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [path.join(DASHBOARD_ROOT, '..', '.env.local'), path.join(DASHBOARD_ROOT, '.env.local')];
  for (const fp of files) {
    let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      if (t.slice(0, i).trim() === 'SUPABASE_PG_URL_SESSION') {
        const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (v) return v;
      }
    }
  }
  return '';
}

async function connectOrSkip(t, timeoutMs = 8000) {
  const url = resolveSupabaseUrl();
  if (!url) { t.skip('Kein SUPABASE_PG_URL_SESSION — Supabase-Verifikation übersprungen.'); return null; }
  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return null; }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
  try { await client.connect(); } catch (err) { t.skip(`Supabase nicht erreichbar (${err.code || err.message}).`); return null; }
  return client;
}

test('#214 Rollen-Split: app_reader/app_writer/automatenlager_app vorhanden, App-Rolle ohne RLS-Umgehung', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    const roles = await client.query(`
      SELECT rolname, rolcanlogin, rolbypassrls, rolsuper
        FROM pg_roles
       WHERE rolname IN ('app_reader','app_writer','automatenlager_app','n8n_app')`);
    const byName = Object.fromEntries(roles.rows.map((r) => [r.rolname, r]));

    assert.ok(byName.app_reader, 'out-of-band Rolle app_reader existiert');
    assert.ok(byName.app_writer, 'out-of-band Rolle app_writer existiert');
    assert.ok(byName.automatenlager_app, 'App-Rolle automatenlager_app existiert');
    assert.equal(byName.automatenlager_app.rolcanlogin, true, 'App-Rolle kann sich verbinden (App-Pool)');
    assert.equal(byName.automatenlager_app.rolbypassrls, false, 'App-Rolle umgeht RLS NICHT (kein BYPASSRLS)');
    assert.equal(byName.automatenlager_app.rolsuper, false, 'App-Rolle ist kein Superuser');
    assert.equal(byName.n8n_app, undefined, 'n8n_app existiert auf Supabase bewusst NICHT (Migration 0033 skippt)');

    // search_path der App-Rolle greift (0022): beginnt mit automatenlager.
    const sp = await client.query(`
      SELECT s.setconfig
        FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
       WHERE r.rolname = 'automatenlager_app'`);
    const cfg = (sp.rows[0] && sp.rows[0].setconfig || []).join(';');
    assert.match(cfg, /search_path=automatenlager/, 'ALTER ROLE … SET search_path = automatenlager,… ist gesetzt');

    // Infra-Pool (postgres auf Supabase) darf RLS umgehen — Äquivalent zur Mini-Eigentümerrolle.
    const infra = await client.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    assert.equal(infra.rows[0].rolbypassrls, true, 'Infra-Verbindung (Session-Pool) umgeht RLS (Bootstrap/Migrationen/Refresh)');
  } finally { await client.end(); }
});

test('#214 Migrationen 0001–0036 angewendet: Marker-Objekte vorhanden, RLS aktiv mit Policies', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    // Marker später Migrationen (0032/0035/0036) — wenn die da sind, lief die Kette durch.
    const markers = await client.query(`
      SELECT to_regclass('audit.access_log')                 AS m0035,
             to_regclass('audit.sales_reconciliation_log')   AS m0036,
             to_regclass('automatenlager.classification_settings') AS m_cs`);
    assert.ok(markers.rows[0].m0035, 'audit.access_log (Migration 0035) existiert');
    assert.ok(markers.rows[0].m0036, 'audit.sales_reconciliation_log (Migration 0036) existiert');
    assert.ok(markers.rows[0].m_cs, 'automatenlager.classification_settings existiert');

    const col = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='automatenlager' AND table_name='classification_settings' AND column_name='tenant_id'`);
    assert.equal(col.rowCount, 1, 'classification_settings.tenant_id (Migration 0032) existiert');

    // RLS: jede repräsentative Tabelle hat relrowsecurity + mindestens eine Policy.
    for (const tbl of RLS_TABLES) {
      const rls = await client.query(`
        SELECT c.relrowsecurity,
               (SELECT count(*)::int FROM pg_policies p
                 WHERE p.schemaname='automatenlager' AND p.tablename=$1) AS policies
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='automatenlager' AND c.relname=$1`, [tbl]);
      assert.equal(rls.rowCount, 1, `${tbl} existiert`);
      assert.equal(rls.rows[0].relrowsecurity, true, `${tbl}: ROW LEVEL SECURITY ist aktiviert`);
      assert.ok(rls.rows[0].policies >= 1, `${tbl}: mindestens eine RLS-Policy vorhanden`);
    }
  } finally { await client.end(); }
});

test('#214 fail-closed: App-Rolle ohne GUC ⇒ 42704 oder keine Tenant-Zeilen, mit set_config normal', async (t) => {
  // Fail-closed hat hinter dem Supavisor-Pooler ZWEI dichte Formen (AC #214:
  // "Fehler 42704 / keine Zeilen"): frisches Backend ⇒ current_setting kracht
  // (42704); recyceltes Backend (GUC-Platzhalter je definiert, DISCARD ALL
  // setzt ihn auf '') ⇒ einarmige Policies matchen nichts, die Vereinigungs-
  // Policy zeigt hoechstens __default__. Ein Cross-Tenant-Leak faellt in
  // beiden Zweigen durch.
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await client.query('SET ROLE automatenlager_app');
    let gucValue = null;
    try {
      const probe = await client.query("SELECT current_setting('automatenlager.current_tenant') AS v");
      gucValue = probe.rows[0].v;
    } catch { /* 42704 — frisches Backend */ }
    if (gucValue === null) {
      await assert.rejects(
        () => client.query('SELECT tenant_id FROM automatenlager.classification_settings'),
        /unrecognized configuration parameter|current_tenant/i,
        'fehlender Mandanten-GUC muss fail-closed krachen (42704), nicht still liefern',
      );
    } else {
      assert.equal(gucValue, '', 'recyceltes Pooler-Backend: GUC-Platzhalter ist LEER (kein Alt-Mandant klebt)');
      const silent = await client.query('SELECT tenant_id FROM automatenlager.classification_settings');
      assert.ok(silent.rows.every((r) => r.tenant_id === '__default__'),
        'ohne Mandant hoechstens __default__-Vorlage — NIE Tenant-Zeilen');
      const prod = await client.query('SELECT count(*)::int AS n FROM automatenlager.products');
      assert.equal(prod.rows[0].n, 0, 'einarmige Policy ohne Mandant: 0 Zeilen (kein Leck)');
    }
  } finally { await client.end(); }

  // Zweite frische Verbindung: die Tür darf den GUC transaktionslokal setzen.
  const client2 = await connectOrSkip(t); if (!client2) return;
  try {
    await client2.query('SET ROLE automatenlager_app');
    await client2.query('BEGIN');
    await client2.query("SELECT set_config('automatenlager.current_tenant', 't_faltrix', true)");
    const r = await client2.query('SELECT count(*)::int AS n FROM automatenlager.products');
    assert.ok(r.rows[0].n >= 1, 'mit GUC=t_faltrix liefert products Zeilen (Tür funktioniert)');
    await client2.query('ROLLBACK');
  } finally { await client2.end(); }
});

test('#214 Faltrix-Daten migriert und plausibel (Zeilenzahlen, keine Dubletten/negativen Bestände)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    const tenants = await client.query('SELECT tenant_id FROM automatenlager.tenants ORDER BY 1');
    const ids = tenants.rows.map((r) => r.tenant_id);
    assert.ok(ids.includes('t_faltrix'), 'Mandant t_faltrix existiert');

    // Kerntabellen tragen Daten (Infra-Sicht, RLS-Bypass — Gesamtbestand).
    for (const tbl of ['products', 'locations', 'machines', 'stock_batches', 'sales_transactions', 'guv_daily']) {
      const r = await client.query(`SELECT count(*)::int AS n FROM automatenlager.${tbl}`);
      assert.ok(r.rows[0].n >= 1, `${tbl}: migrierte Zeilen vorhanden (ist ${r.rows[0].n})`);
    }

    const neg = await client.query(
      'SELECT count(*)::int AS n FROM automatenlager.stock_batches WHERE remaining_qty < 0');
    assert.equal(neg.rows[0].n, 0, 'keine negativen Restbestände in stock_batches');

    const dup = await client.query(`
      SELECT count(*)::int AS n FROM (
        SELECT tenant_id, product_key FROM automatenlager.products
         GROUP BY tenant_id, product_key HAVING count(*) > 1) d`);
    assert.equal(dup.rows[0].n, 0, 'keine doppelten Business-Keys (tenant_id, product_key) in products');
  } finally { await client.end(); }
});
