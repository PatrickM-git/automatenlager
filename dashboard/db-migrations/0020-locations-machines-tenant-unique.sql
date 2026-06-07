-- Migration 0020: locations + machines mandantengetrennte Uniques — Stufe 4, Issue #132.
-- DDL VOR Code (Slice 1). Idempotent. Setzt 0009 (tenant_id) voraus.
--
-- Ersetzt fuer GENAU diese drei Tabellen (locations, machines, machine_profiles)
-- die GLOBALE (key)-Unique durch UNIQUE NULLS NOT DISTINCT (tenant_id, <key>) —
-- Muster wie settings_thresholds (0002). Damit kann ein Mandant beim Upsert NIE
-- die Zeile eines anderen ueberschreiben, und gleicher Schluessel bei zwei
-- Mandanten = ZWEI Zeilen (kein roher Kollisionsfehler).
--
-- ABGRENZUNG zu 0012: Dort wurden die globalen (key)-Uniques BEWUSST belassen,
-- weil der laufende n8n-/pgw_write-Schreibpfad `ON CONFLICT (key)` nutzt (Story 23).
-- locations/machines werden jedoch NICHT von n8n/pgw_write geschrieben, sondern
-- ausschliesslich vom Dashboard (location-profiles.js, machine-create.js) — daher
-- ist das Droppen hier sicher (vom Eigentuemer freigegeben, "Variante 2"). Der
-- dazugehoerige Dashboard-Upsert-Code wandert in #135/#136 auf ON CONFLICT
-- (tenant_id, <key>). Das generische Droppen der UEBRIGEN globalen Uniques bleibt
-- #111 (Stufe 6) — dessen Scope reduziert sich um diese zwei Tabellen.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0020-locations-machines-tenant-unique.sql

-- ── 1) Vorab-Check: tenant_id befuellt + NOT NULL (sonst kollabieren NULLs unsauber) ──
UPDATE automatenlager.locations        SET tenant_id = '__default__' WHERE tenant_id IS NULL;
UPDATE automatenlager.machines         SET tenant_id = '__default__' WHERE tenant_id IS NULL;
UPDATE automatenlager.machine_profiles SET tenant_id = '__default__' WHERE tenant_id IS NULL;
ALTER TABLE automatenlager.locations        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE automatenlager.machines         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE automatenlager.machine_profiles ALTER COLUMN tenant_id SET NOT NULL;

-- ── 2) Duplikat-Vorab-Check (Guertel-und-Hosentraeger) ──────────────────────────
-- Das Erweitern um tenant_id ist formal eine Lockerung; Altdaten koennen den neuen
-- Constraint nicht verletzen. Der Check macht eine etwaige Datenpanne aber sichtbar,
-- statt den ADD CONSTRAINT kryptisch fehlschlagen zu lassen.
DO $$
DECLARE dup TEXT;
BEGIN
  SELECT string_agg(t || ':' || k, ', ') INTO dup FROM (
    SELECT 'locations' AS t, tenant_id || '/' || location_key AS k
      FROM automatenlager.locations GROUP BY tenant_id, location_key HAVING count(*) > 1
    UNION ALL
    SELECT 'machines', tenant_id || '/' || machine_key
      FROM automatenlager.machines GROUP BY tenant_id, machine_key HAVING count(*) > 1
    UNION ALL
    SELECT 'machine_profiles', tenant_id || '/' || machine_id
      FROM automatenlager.machine_profiles GROUP BY tenant_id, machine_id HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0020 abgebrochen: Duplikate fuer (tenant_id, key): %', dup;
  END IF;
END $$;

-- ── 3) Globale (key)-Unique droppen, (tenant_id, key) NULLS NOT DISTINCT anlegen ──
-- Idempotent: DROP ... IF EXISTS; ADD nur, wenn der neue Constraint noch fehlt.
DO $$
DECLARE
  spec JSONB;
  specs JSONB := '[
    {"t":"locations",        "drop":"locations_location_key_key",        "new":"locations_tenant_key_uk",            "cols":"tenant_id, location_key"},
    {"t":"machines",         "drop":"machines_machine_key_key",          "new":"machines_tenant_key_uk",             "cols":"tenant_id, machine_key"},
    {"t":"machine_profiles", "drop":"machine_profiles_machine_id_unique", "new":"machine_profiles_tenant_machine_uk", "cols":"tenant_id, machine_id"}
  ]';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(specs) LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I DROP CONSTRAINT IF EXISTS %I',
                   spec->>'t', spec->>'drop');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec->>'new'
                     AND conrelid = ('automatenlager.' || (spec->>'t'))::regclass) THEN
      EXECUTE format('ALTER TABLE automatenlager.%I ADD CONSTRAINT %I UNIQUE NULLS NOT DISTINCT (%s)',
                     spec->>'t', spec->>'new', spec->>'cols');
    END IF;
  END LOOP;
END $$;

COMMENT ON CONSTRAINT locations_tenant_key_uk ON automatenlager.locations IS
  'Stufe 4 (#132): location_key mandantengetrennt eindeutig. Ersetzt die globale (location_key)-Unique.';
COMMENT ON CONSTRAINT machines_tenant_key_uk ON automatenlager.machines IS
  'Stufe 4 (#132): machine_key mandantengetrennt eindeutig. Ersetzt die globale (machine_key)-Unique.';
COMMENT ON CONSTRAINT machine_profiles_tenant_machine_uk ON automatenlager.machine_profiles IS
  'Stufe 4 (#132): machine_id mandantengetrennt eindeutig. Ersetzt die globale (machine_id)-Unique.';
