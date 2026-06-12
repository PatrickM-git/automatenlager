'use strict';

/**
 * Migration 0034 — classification_settings-RLS zurück auf fail-closed (Audit 2026-06-10).
 *
 * 0032 hatte bei der Policy-Neuerstellung versehentlich current_setting(..., true)
 * (missing_ok) eingeführt. 0034 stellt die 0026-Form wieder her: fehlender GUC ⇒
 * Fehler 42704 statt stiller Ergebnisse. LIVE-Sandbox (#94-Harness, ROLLBACK),
 * Verhaltensbeweis REAL als eingeengte App-Rolle (SET ROLE automatenlager_app).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  connectOrSkip, withRollback, applyMigration, expectReject, readMigration, SANDBOX_LOCK_KEY,
} = require('./helpers/migration-sandbox.js');

// ── DB-freier Contract-Test: 0034 selbst ist einarmig (kein missing_ok) ───────

test('0034 statisch: Policies nutzen einarmiges current_setting (kein missing_ok)', () => {
  // Kommentarzeilen ausblenden (der Kopf-Kommentar BESCHREIBT das missing_ok-Muster).
  const sql = readMigration(34).split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(/CREATE POLICY tenant_default_read/.test(sql), 'tenant_default_read wird neu angelegt');
  assert.ok(/CREATE POLICY tenant_isolation/.test(sql), 'tenant_isolation wird neu angelegt');
  assert.ok(!/current_setting\([^)]*,\s*true\s*\)/.test(sql),
    '0034 enthält KEIN current_setting(..., true) — fail-closed');
});

// ── LIVE-Sandbox: Policy-Definitionen in der DB sind nach 0034 einarmig ───────

test('0034 LIVE: pg_policies ohne missing_ok nach Anwendung (idempotent, 2. Lauf ok)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 32); // Ausgangslage post-0032 (auf dem Mini eh committed)
      await applyMigration(client, 34);
      await applyMigration(client, 34); // idempotent: zweiter Lauf bricht nicht

      const r = await client.query(
        `SELECT polname,
                pg_get_expr(polqual, polrelid)      AS qual,
                pg_get_expr(polwithcheck, polrelid) AS with_check
           FROM pg_policy
          WHERE polrelid = 'automatenlager.classification_settings'::regclass
          ORDER BY polname`);
      assert.equal(r.rowCount, 2, 'genau zwei Policies (tenant_default_read + tenant_isolation)');
      for (const row of r.rows) {
        for (const expr of [row.qual, row.with_check]) {
          if (!expr) continue;
          assert.ok(/current_setting/.test(expr), `${row.polname}: GUC-Vergleich vorhanden`);
          assert.ok(!/current_setting\([^)]*,\s*true\)/.test(expr),
            `${row.polname}: einarmig (kein missing_ok) — ${expr}`);
        }
      }
    });
  } finally { await client.end(); }
});

// ── LIVE-Verhaltensbeweis als App-Rolle: ohne GUC kracht es, mit GUC normal ───

test('0034 LIVE: App-Rolle ohne GUC ⇒ Fehler 42704 (fail-closed); mit GUC eigener+__default__', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      // #124: Advisory-Lock VOR der DML auf classification_settings (serialisiert
      // mit parallelen Sandbox-Transaktionen, sonst DML-vs-DML-Deadlock).
      await client.query('SELECT pg_advisory_xact_lock($1)', [SANDBOX_LOCK_KEY]);
      await client.query(`INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
        VALUES ('__default__','{}'::jsonb, now()) ON CONFLICT (tenant_id) DO NOTHING`);
      await client.query(`INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
        VALUES ('acme','{}'::jsonb, now()) ON CONFLICT (tenant_id) DO NOTHING`);
      await applyMigration(client, 32);
      await applyMigration(client, 34);

      await client.query('SET ROLE automatenlager_app');
      // Ohne Mandanten-GUC ist fail-closed in ZWEI Formen dicht (AC #214:
      // "Fehler 42704 / keine Zeilen"):
      //  - Direktverbindung (Mini): der GUC war in dieser Backend-Session nie
      //    definiert ⇒ current_setting KRACHT (42704).
      //  - Hinter dem Supabase-Pooler (Supavisor) kann das Server-Backend
      //    recycelt sein: hat irgendeine fruehere Client-Session dort den GUC
      //    je per set_config definiert, liefert er nach DISCARD ALL '' statt
      //    zu werfen ⇒ einarmige Policies matchen nichts; die Vereinigungs-
      //    Policy zeigt hoechstens die __default__-Vorlage — NIE Tenant-Zeilen.
      // Der Probe-SAVEPOINT stellt fest, welche Form dieses Backend garantiert;
      // ein Cross-Tenant-Leak faellt in beiden Zweigen durch.
      let gucValue = null;
      await client.query('SAVEPOINT guc_probe');
      try {
        const probe = await client.query("SELECT current_setting('automatenlager.current_tenant') AS v");
        gucValue = probe.rows[0].v;
        await client.query('RELEASE SAVEPOINT guc_probe');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT guc_probe');
      }
      if (gucValue === null) {
        await expectReject(client,
          'SELECT tenant_id FROM automatenlager.classification_settings',
          /unrecognized configuration parameter|current_tenant/i,
          'fehlender GUC muss einen Fehler werfen (fail-closed), keine stillen Zeilen');
      } else {
        assert.equal(gucValue, '', 'recyceltes Pooler-Backend: GUC-Platzhalter ist LEER (kein Alt-Mandant klebt)');
        const silent = await client.query('SELECT tenant_id FROM automatenlager.classification_settings');
        assert.ok(silent.rows.every((r) => r.tenant_id === '__default__'),
          'ohne Mandant hoechstens __default__-Vorlage sichtbar — NIE Tenant-Zeilen (acme unsichtbar)');
      }
      // Mit GUC: Vereinigungs-Policy unverändert — eigener Mandant + __default__.
      await client.query("SELECT set_config('automatenlager.current_tenant', 'acme', true)");
      const vis = await client.query(
        'SELECT tenant_id FROM automatenlager.classification_settings ORDER BY 1');
      const ids = vis.rows.map((r) => r.tenant_id);
      assert.ok(ids.includes('acme'), 'eigener Mandant sichtbar');
      assert.ok(ids.includes('__default__'), '__default__-Vorlage sichtbar');
      assert.ok(ids.every((id) => id === 'acme' || id === '__default__'),
        'keine fremden Mandanten sichtbar');
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});
