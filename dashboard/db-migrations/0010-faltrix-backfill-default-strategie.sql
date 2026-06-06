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
-- DEFAULT-STRATEGIE (revidiert nach Review): ALLE Daten-Tabellen bekommen hier
-- einen TRANSIENTEN DEFAULT auf 't_faltrix' (kein '__default__', kein Insert-Bruch
-- im Bridge-Zustand). Das urspruengliche "DROP DEFAULT bei abhaengigen Tabellen"
-- wandert nach 0014 — DIREKT NACH der Auto-Fill-Trigger-Anlage, damit kein Fenster
-- entsteht, in dem ein Schreiber ohne Default UND ohne Trigger braeche. Die zwei
-- "nackten" Schreibpfad-Tabellen warnings + product_change_proposals (System-/WF1-
-- Inserts ohne ableitbaren Eltern) behalten den Default und werden NICHT ge-DROPt.
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
BEGIN
  -- 1. Realen Mandanten + Default-Zentrallager (idempotent).
  PERFORM automatenlager.fn_create_tenant(v_tenant, v_name, v_email);

  -- 2. Backfill Daten-Tabellen: '__default__' -> 't_faltrix' (verschieben).
  FOREACH t IN ARRAY data_tables LOOP
    EXECUTE format('UPDATE automatenlager.%I SET tenant_id = %L WHERE tenant_id = %L',
                   t, v_tenant, v_old);
  END LOOP;

  -- 3. Config-Tabellen: '__default__'-Config auf 't_faltrix' KOPIEREN (Vorlage bleibt).
  -- classification_settings traegt in Stufe 1 weiter mandant_id (Umbenennung erst
  -- Stufe 6, sonst braeche WF8). Kopie der __default__-Vorlage auf den realen Mandant.
  EXECUTE format(
    'INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
       SELECT %L, config, now() FROM automatenlager.classification_settings WHERE mandant_id = %L
     ON CONFLICT (mandant_id) DO NOTHING', v_tenant, v_old);
  EXECUTE format(
    'INSERT INTO automatenlager.settings_thresholds (tenant_id, machine_id, key, value, updated_at)
       SELECT %L, machine_id, key, value, now() FROM automatenlager.settings_thresholds WHERE tenant_id = %L
     ON CONFLICT ON CONSTRAINT settings_thresholds_unique DO NOTHING', v_tenant, v_old);

  -- 4. ALLE Daten-Tabellen bekommen einen TRANSIENTEN DEFAULT auf den realen
  --    Mandanten. So gibt es im Bridge-Zustand (Single-Tenant) NIE einen Insert-
  --    Bruch und NIE eine '__default__'-Zeile — egal ob ein Schreiber tenant_id
  --    weglaesst und keinen ableitbaren Eltern hat (z. B. System-Warnungen,
  --    WF1-Rechnungsvorschlaege ohne machine/product). Die ABHAENGIGEN Tabellen
  --    verlieren diesen Default wieder in 0014, NACHDEM ihr Auto-Fill-Trigger
  --    steht (Default-Entfernung + Trigger in DERSELBEN Migration -> kein Fenster,
  --    in dem ein Schreiber ohne Default UND ohne Trigger braeche). Reine Root-/
  --    Stammtabellen sowie die "nackten" warnings/product_change_proposals
  --    behalten den Default bis Stufe 2/3 (dann setzt der Code tenant_id explizit).
  FOREACH t IN ARRAY data_tables LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I ALTER COLUMN tenant_id SET DEFAULT %L',
                   t, v_tenant);
  END LOOP;
END $$;
