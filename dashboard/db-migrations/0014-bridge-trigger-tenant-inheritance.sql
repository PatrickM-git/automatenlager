-- Migration 0014: Bruecken-Trigger — tenant_id-Vererbung (BEFORE INSERT Auto-Fill)
-- + die bestehenden Trigger 0003/0005 mandantenrein nachziehen. Damit laeuft der
-- heutige n8n-Schreibpfad ohne Aenderung weiter (kein NULL-/Falsch-Tenant).
-- Stufe 1. Issue #101. Idempotent. Setzt 0010-0013 voraus.
-- WICHTIG: zusammen mit 0010-0013 deployen (DROP DEFAULT aus 0010 + dieser Trigger
-- gehoeren zusammen, sonst brechen Schreiber abhaengiger Tabellen).
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0014-bridge-trigger-tenant-inheritance.sql

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Generische Vererbungs-Funktion: leitet tenant_id aus dem Eltern ab, wenn der
--    Schreiber sie weglaesst. TG_ARGV als Tripel (fk_spalte, eltern_tabelle,
--    eltern_schluessel); mehrere Tripel = Fallback-Kette (erster Treffer gewinnt).
--    Alles ::text-verglichen, deckt damit auch machine_profiles.machine_id (TEXT =
--    machine_key) sauber ab.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION automatenlager.fn_inherit_tenant_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  i INT := 0;
  v_fk_val  TEXT;
  v_tenant  TEXT;
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    RETURN NEW;  -- Schreiber hat tenant_id explizit gesetzt -> respektieren
  END IF;
  WHILE i < TG_NARGS LOOP
    EXECUTE format('SELECT ($1).%I::text', TG_ARGV[i]) INTO v_fk_val USING NEW;
    IF v_fk_val IS NOT NULL THEN
      EXECUTE format('SELECT tenant_id FROM automatenlager.%I WHERE %I::text = $1 LIMIT 1',
                     TG_ARGV[i + 1], TG_ARGV[i + 2])
        INTO v_tenant USING v_fk_val;
      IF v_tenant IS NOT NULL THEN
        NEW.tenant_id := v_tenant;
        RETURN NEW;
      END IF;
    END IF;
    i := i + 3;
  END LOOP;
  RETURN NEW;  -- nichts gefunden -> tenant_id bleibt NULL (NOT NULL-Fehler, gewollt)
END;
$$;

COMMENT ON FUNCTION automatenlager.fn_inherit_tenant_id() IS
  'BEFORE-INSERT-Vererbung: setzt NEW.tenant_id aus dem Eltern, wenn der Schreiber '
  'sie weglaesst (Bruecke fuer den heutigen n8n-Schreibpfad). TG_ARGV-Tripel = '
  'Fallback-Kette (fk_spalte, eltern_tabelle, eltern_schluessel).';

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. BEFORE INSERT Auto-Fill-Trigger je abhaengiger Tabelle (idempotent).
-- ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  spec JSONB;
  specs JSONB := '[
    {"t":"slot_assignments",         "args":["machine_id","machines","machine_id"]},
    {"t":"machine_profiles",         "args":["machine_id","machines","machine_key"]},
    {"t":"stock_batches",            "args":["product_id","products","product_id"]},
    {"t":"stock_movements",          "args":["batch_id","stock_batches","batch_id"]},
    {"t":"sales_transactions",       "args":["machine_id","machines","machine_id"]},
    {"t":"guv_daily",                "args":["machine_id","machines","machine_id"]},
    {"t":"invoice_items",            "args":["invoice_id","invoices","invoice_id"]},
    {"t":"prices",                   "args":["slot_assignment_id","slot_assignments","slot_assignment_id"]},
    {"t":"product_aliases",          "args":["product_id","products","product_id"]},
    {"t":"warnings",                 "args":["machine_id","machines","machine_id","product_id","products","product_id","slot_assignment_id","slot_assignments","slot_assignment_id"]},
    {"t":"product_change_proposals", "args":["machine_id","machines","machine_id","product_id","products","product_id"]}
  ]';
  argstr TEXT;
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(specs) LOOP
    SELECT string_agg(quote_literal(a), ', ') INTO argstr
      FROM jsonb_array_elements_text(spec->'args') AS a;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_inherit_tenant_%s ON automatenlager.%I',
                   spec->>'t', spec->>'t');
    EXECUTE format(
      'CREATE TRIGGER trg_inherit_tenant_%s BEFORE INSERT ON automatenlager.%I '
      'FOR EACH ROW EXECUTE FUNCTION automatenlager.fn_inherit_tenant_id(%s)',
      spec->>'t', spec->>'t', argstr);
  END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3a. fn_deduct_stock_on_machine_sale nachziehen: FIFO-Abbuchung NUR innerhalb des
--     Mandanten (zusaetzlicher tenant_id-Filter). Funktion erweitert, nicht ersetzt.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION automatenlager.fn_deduct_stock_on_machine_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_delta  INTEGER;
  v_rem    INTEGER;
  rec      RECORD;
BEGIN
  IF NEW.current_machine_qty >= OLD.current_machine_qty THEN
    RETURN NEW;
  END IF;
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_delta := OLD.current_machine_qty - NEW.current_machine_qty;
  v_rem   := v_delta;

  FOR rec IN
    SELECT batch_id, remaining_qty
    FROM   automatenlager.stock_batches
    WHERE  product_id  = NEW.product_id
      AND  tenant_id   = NEW.tenant_id            -- #101: FIFO bleibt mandantenrein
      AND  status NOT IN ('ausgesondert', 'leer', 'wartet_nachkauf')
      AND  remaining_qty > 0
    ORDER  BY received_at ASC, batch_id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_rem <= 0;
    IF rec.remaining_qty >= v_rem THEN
      UPDATE automatenlager.stock_batches
      SET    remaining_qty = remaining_qty - v_rem, updated_at = now()
      WHERE  batch_id = rec.batch_id;
      v_rem := 0;
    ELSE
      UPDATE automatenlager.stock_batches
      SET    remaining_qty = 0, updated_at = now()
      WHERE  batch_id = rec.batch_id;
      v_rem := v_rem - rec.remaining_qty;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3b. fn_update_price_from_sale nachziehen: Preislese/-schreibe mandantenrein,
--     INSERT schreibt tenant_id mit. Funktion erweitert, nicht ersetzt.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION automatenlager.fn_update_price_from_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_price  NUMERIC(10, 2);
  v_current_id  BIGINT;
  v_current_amt NUMERIC(10, 2);
BEGIN
  v_unit_price := ROUND(NEW.gross_amount / NEW.quantity, 2);

  SELECT price_id, sale_price_gross
    INTO v_current_id, v_current_amt
    FROM automatenlager.prices
   WHERE slot_assignment_id = NEW.slot_assignment_id
     AND tenant_id = NEW.tenant_id              -- #101: nur eigener Mandant
     AND valid_to IS NULL
   ORDER BY valid_from DESC
   LIMIT 1
   FOR UPDATE;

  IF v_current_amt IS NOT DISTINCT FROM v_unit_price THEN
    RETURN NEW;
  END IF;

  IF v_current_id IS NOT NULL THEN
    UPDATE automatenlager.prices
       SET valid_to = NEW.settlement_at
     WHERE price_id = v_current_id;            -- per PK eindeutig
  END IF;

  INSERT INTO automatenlager.prices
    (slot_assignment_id, sale_price_gross, valid_from, valid_to, source, tenant_id)
  VALUES
    (NEW.slot_assignment_id, v_unit_price, NEW.settlement_at, NULL, 'nayax_transaction', NEW.tenant_id);

  RETURN NEW;
END;
$$;
