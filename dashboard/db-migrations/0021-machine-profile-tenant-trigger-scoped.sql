-- Migration 0021: machine_profiles-Validierungs-Trigger mandanten-skopiert — Stufe 4, #136.
-- Folge-Korrektur zu 0020. Idempotent (CREATE OR REPLACE FUNCTION).
--
-- 0020 hat die globale (machine_key)-Unique auf `machines` gedroppt: zwei Mandanten
-- duerfen denselben machine_key haben (Variante 2). Der tenant-treue-Validierungs-
-- Trigger aus 0017 (fn_assert_machine_profile_tenant) loeste machine_key -> tenant
-- jedoch GLOBAL auf (`WHERE machine_key = NEW.machine_id`). Bei gleichem Key in zwei
-- Mandanten ist das mehrdeutig: `SELECT ... INTO` nimmt eine beliebige Zeile, und das
-- machine_profile des ZWEITEN Mandanten wird faelschlich als „tenant_id passt nicht"
-- abgewiesen. Fix: die Maschine im SELBEN Mandanten suchen
-- (`AND tenant_id = NEW.tenant_id`). Die tenant-treue-Invariante bleibt unveraendert:
-- ein machine_profile muss eine Maschine DESSELBEN Mandanten referenzieren.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0021-machine-profile-tenant-trigger-scoped.sql

CREATE OR REPLACE FUNCTION automatenlager.fn_assert_machine_profile_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Mandanten-skopierte Aufloesung: existiert eine Maschine mit diesem machine_key
  -- IM Mandanten der Profilzeile? (Ob eine fremde mit gleichem Key existiert, ist
  -- nach 0020 irrelevant.) Fehlt sie, ist das Profil nicht tenant-treu.
  IF NOT EXISTS (
    SELECT 1
      FROM automatenlager.machines
     WHERE machine_key = NEW.machine_id
       AND tenant_id   = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'machine_profiles: keine Maschine mit machine_key=% fuer Mandant % (tenant-treu)',
      NEW.machine_id, NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Der Trigger selbst (trg_validate_tenant_machine_profiles aus 0017) bleibt bestehen
-- und zeigt weiterhin auf diese Funktion — kein DROP/CREATE TRIGGER noetig.
