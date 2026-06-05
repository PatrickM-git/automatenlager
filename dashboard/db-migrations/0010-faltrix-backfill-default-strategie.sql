-- Migration 0010: Realen Mandanten Faltrix anlegen + Altdaten-Backfill +
-- differenzierte Default-Strategie. Stufe 1. Issue #97. Idempotent/wiederholbar.
-- Setzt 0007-0009 voraus. Anwenden VOR Code-Rollout/Mini-Deploy.
--
-- Tenant-ID: 't_faltrix' — stabile, opake (Praefix t_), debugging-freundliche ID,
-- bewusst getrennt vom aenderbaren Anzeigenamen 'Faltrix'. Bei Bedarf in Stufe 2
-- auf eine UUID migrierbar (die ID wird auf jede Zeile gestempelt).
--
-- BACKFILL-DIFFERENZIERUNG (wichtig, bewusste Abweichung vom woertlichen #97-AC):
--   * Daten-Tabellen werden auf 't_faltrix' VERSCHOBEN (keine '__default__'-Zeile
--     mehr) — '__default__' wuerde dort echte Daten besitzen.
--   * Config-Tabellen (classification_settings/settings_thresholds) werden auf
--     't_faltrix' KOPIERT, '__default__' bleibt als read-side-Vorlage erhalten.
--     Grund: der Stufe-1-Code liest die Config noch unter '__default__'
--     (DEFAULT_MANDANT). Wuerde man sie wegziehen, verloere Faltrix bis Stufe 2/3
--     seinen echten Override (heute: kleinunternehmerAktiv=true -> sonst falsche
--     GuV). Das deckt sich mit der SPEC-Notiz "'__default__' bleibt als System-
--     Default-Vorlage erhalten, nie als Besitzer echter Daten".
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0010-faltrix-backfill-default-strategie.sql

DO $$
DECLARE
  v_tenant TEXT := 't_faltrix';
  v_name   TEXT := 'Faltrix';
  v_email  TEXT := 'faltrixgbr@gmail.com';
  v_old    TEXT := '__default__';
  t TEXT;
  -- Alle Daten-Tabellen: '__default__' -> realer Mandant VERSCHIEBEN.
  data_tables TEXT[] := ARRAY[
    'machines', 'locations', 'machine_profiles', 'slot_assignments',
    'products', 'product_aliases', 'product_change_proposals',
    'stock_batches', 'stock_movements', 'sales_transactions', 'guv_daily',
    'warnings', 'invoices', 'invoice_items', 'suppliers',
    'nayax_devices', 'workflow_state', 'prices'
  ];
  -- Root-/Stammtabellen (kein tenant-tragender Eltern): DEFAULT -> realer Mandant
  -- (transient bis Stufe 2/3 die Schreiber viewer.tenantId explizit mitgeben).
  root_tables TEXT[] := ARRAY[
    'machines', 'locations', 'suppliers', 'products', 'invoices',
    'nayax_devices', 'workflow_state'
  ];
  -- Abhaengige Tabellen (tenant-tragender Eltern): DEFAULT ENTFERNEN — der Bruecken-
  -- Trigger (0014, #101) fuellt tenant_id aus dem Eltern. WICHTIG: 0010-0014
  -- zusammen deployen, damit kein Schreiber im Fenster ohne Default/Trigger bricht.
  dep_tables TEXT[] := ARRAY[
    'slot_assignments', 'machine_profiles', 'stock_batches', 'stock_movements',
    'sales_transactions', 'guv_daily', 'warnings', 'invoice_items',
    'prices', 'product_aliases', 'product_change_proposals'
  ];
BEGIN
  -- 1. Realen Mandanten + Default-Zentrallager (idempotent).
  PERFORM automatenlager.fn_create_tenant(v_tenant, v_name, v_email);

  -- 2. Backfill Daten-Tabellen: '__default__' -> 't_faltrix' (verschieben).
  FOREACH t IN ARRAY data_tables LOOP
    EXECUTE format('UPDATE automatenlager.%I SET tenant_id = %L WHERE tenant_id = %L',
                   t, v_tenant, v_old);
  END LOOP;

  -- 3. Config-Tabellen: '__default__'-Config auf 't_faltrix' KOPIEREN (Vorlage bleibt).
  EXECUTE format(
    'INSERT INTO automatenlager.classification_settings (tenant_id, config, updated_at)
       SELECT %L, config, now() FROM automatenlager.classification_settings WHERE tenant_id = %L
     ON CONFLICT (tenant_id) DO NOTHING', v_tenant, v_old);
  EXECUTE format(
    'INSERT INTO automatenlager.settings_thresholds (tenant_id, machine_id, key, value, updated_at)
       SELECT %L, machine_id, key, value, now() FROM automatenlager.settings_thresholds WHERE tenant_id = %L
     ON CONFLICT ON CONSTRAINT settings_thresholds_unique DO NOTHING', v_tenant, v_old);

  -- 4a. Root-/Stammtabellen: DEFAULT auf realen Mandanten (transient).
  FOREACH t IN ARRAY root_tables LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I ALTER COLUMN tenant_id SET DEFAULT %L',
                   t, v_tenant);
  END LOOP;

  -- 4b. Abhaengige Tabellen: DEFAULT entfernen (Trigger 0014 uebernimmt).
  FOREACH t IN ARRAY dep_tables LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I ALTER COLUMN tenant_id DROP DEFAULT', t);
  END LOOP;
END $$;
