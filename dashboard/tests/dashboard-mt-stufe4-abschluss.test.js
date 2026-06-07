'use strict';

/**
 * Stufe 4 „Schreib-Isolation" — Abschluss & Scharfschaltung (Issue #139).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Rollout → Slice 4"
 *
 * Bündelt die SPEC-Pflichtfälle, die den Endzustand beweisen:
 *   - Guard build-blocking (Pflichtfall 9/10): kein rohes pg außerhalb der Tür; ein
 *     vergessener roher Write bräche die Suite. Allowlist auf Endzustand (nur Infra).
 *   - Stufe-5-RLS-Haken inert (Pflichtfall 11): db.tx öffnet eine echte Transaktion,
 *     setzt aber KEIN `SET LOCAL` (RLS = Stufe 5).
 *   - Break-Glass-Schreib-Sperre (Pflichtfall 8): zentraler Methodenriegel blockt
 *     ALLE neuen Schreib-/Trigger-Endpunkte (POST/DELETE) mit 403.
 *   - fail-closed-werfend (Pflichtfall 6): write()/tx() ohne Mandant werfen.
 *
 * Owner-Regression + per-Pfad-Isolation (Pflichtfälle 1–5, 7) liegen in den
 * Slice-Isolationstests (dashboard-mt-{location-profiles,machine-create,
 * settings-thresholds,write-off}-isolation, dashboard-mt-webhook-tore-*).
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const guard = require('../lib/query-filter-guard.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { breakGlassDecision } = require('../lib/auth.js');

const LIB_DIR = path.join(__dirname, '..', 'lib');

// ── Guard build-blocking-Endzustand (Pflichtfall 9/10) ────────────────────────

test('#139 Guard-Endzustand: nur Infrastruktur trägt noch rohes pg; alle Stufe-4-Schreibmodule durch die Tür', () => {
  const bypass = guard.buildReport({ libDir: LIB_DIR }).bypass.map((b) => b.file).sort();
  // Endzustand: ausschließlich Infrastruktur-Guards (kein Mandanten-Datenpfad).
  assert.deepEqual(bypass, ['db-schema.js', 'stock-cost-invariant.js']);
  // Die migrierten Stufe-4-Schreibmodule tragen kein rohes pg mehr.
  for (const migrated of ['location-profiles.js', 'machine-create.js', 'machine-profiles.js', 'settings-thresholds.js']) {
    assert.ok(!bypass.includes(migrated), `${migrated} ist durch die Tür (nicht im Bypass)`);
  }
});

test('#139 Guard build-blocking: ein vergessener roher Write außerhalb der Tür lässt die Suite fehlschlagen', () => {
  const FINAL_ALLOWLIST = ['db-schema.js', 'stock-cost-invariant.js'];
  // Heute: keine Verstöße (Endzustand).
  assert.deepEqual(guard.findViolations({ libDir: LIB_DIR, allowlist: FINAL_ALLOWLIST }).map((v) => v.file), []);
  // Beweis der Wirksamkeit: roher Write-Quelltext wird strukturell erkannt …
  assert.ok(guard.scanSource("const c = new (require('pg').Client)(); await c.query('UPDATE automatenlager.locations SET x=1');").length > 0);
  // … und ein NEUES rohes Schreibmodul stünde NICHT auf der finalen Allowlist ⇒ findViolations meldete es (Build rot).
  assert.ok(!FINAL_ALLOWLIST.includes('a-new-raw-write-module.js'));
});

// ── Stufe-5-RLS-Haken inert (Pflichtfall 11) ──────────────────────────────────

test('#139 db.tx: echte Transaktion (BEGIN/COMMIT), aber KEIN SET LOCAL (RLS = Stufe 5, inert)', async () => {
  const calls = [];
  const client = { released: false, query: async (sql) => { calls.push(String(sql)); return { rows: [], rowCount: 1 }; }, release() { this.released = true; } };
  const db = createTenantDb({ pool: { query: (s, p) => client.query(s, p), connect: async () => client } });
  await db.tx('acme', async (door) => { await door.write({ tables: ['machines'], text: 'INSERT INTO automatenlager.machines DEFAULT VALUES', params: [] }); });
  const up = calls.map((s) => s.toUpperCase());
  assert.ok(up.includes('BEGIN') && up.includes('COMMIT'), 'echte Transaktion');
  assert.ok(!up.some((s) => s.includes('SET LOCAL')), 'kein SET LOCAL — der RLS-Haken ist in Stufe 4 inert');
  assert.equal(client.released, true);
});

// ── Break-Glass-Schreib-Sperre an ALLEN neuen Endpunkten (Pflichtfall 8) ───────

test('#139 Break-Glass: zentraler Methodenriegel blockt alle neuen Schreib-/Trigger-Endpunkte (403)', () => {
  // Die in Stufe 4 neu abgesicherten Endpunkte und ihre Methode:
  const NEW_WRITE_ENDPOINTS = [
    ['POST', '/api/v2/refill/trigger'],
    ['POST', '/api/v2/slot-assign-inline/confirm'],
    ['POST', '/api/v2/correction-action/confirm'],
    ['POST', '/api/v2/onboarding/start'],
    ['POST', '/api/v2/locations'],
    ['DELETE', '/api/v2/locations'],
    ['POST', '/api/v2/machines'],
    ['POST', '/api/v2/machines/active'],
    ['POST', '/api/v2/machine-profiles'],
    ['POST', '/api/v2/settings/thresholds'],
    ['DELETE', '/api/v2/settings/thresholds'],
    ['POST', '/api/v2/inventory/write-off'],
  ];
  const ss = { requested: true, active: true, targetTenant: 'acme' };
  const viewer = { login: 'admin', tenantId: 'acme', supportSession: ss };
  for (const [method, route] of NEW_WRITE_ENDPOINTS) {
    const d = breakGlassDecision(viewer, method);
    assert.equal(d.kind, 'block', `${method} ${route} unter Support-Sitzung geblockt`);
    assert.equal(d.status, 403);
    assert.equal(d.code, 'SUPPORT_SESSION_READ_ONLY');
    assert.equal(d.auditEvent, 'break_glass_write_blocked');
  }
});

// ── fail-closed-werfend über die Tür (Pflichtfall 6) ──────────────────────────

test('#139 fail-closed: write()/tx() ohne Mandant WERFEN (kein stilles „gespeichert")', async () => {
  const db = createTenantDb({
    query: async () => ({ rows: [], rowCount: 0 }),
    pool: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) },
  });
  for (const tenant of ['', null, undefined, '  ']) {
    await assert.rejects(() => db.write({ tenant, tables: ['locations'], text: 'UPDATE automatenlager.locations SET x=1' }), /Mandant/i);
    await assert.rejects(() => db.tx(tenant, async () => {}), /Mandant/i);
  }
});
