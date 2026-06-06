-- Migration 0015: provider-Dimension (anbieter-agnostisches Fundament, Nayax =
-- erster Anbieter) + Geraete-Claiming-Garantie (nayax_devices global-unique).
-- Stufe 1. Issue #102. Idempotent. Setzt 0009 (tenant_id) + 0012 (sales-Unique) voraus.
--
-- Entscheidung (SPEC): nayax_transaction_id wird in Stufe 1 NICHT physisch in
-- external_transaction_id umbenannt (heutige n8n-Schreiber wuerden brechen) — nur
-- die Unique-Constraint wird provider-aware. Physische Umbenennung erst Stufe 6.
-- Der Claiming-FLOW (Konflikt erkennen/eskalieren) ist eigene Arbeit, hier nur die
-- Eindeutigkeits-Garantie.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0015-provider-dimension-device-claiming.sql

-- provider-Spalten (Default 'nayax') auf den einspeisenden Tabellen.
ALTER TABLE automatenlager.nayax_devices
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'nayax';
ALTER TABLE automatenlager.sales_transactions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'nayax';

-- Geraete-Claiming: ein externes Geraet systemweit genau einmal (NICHT pro Mandant
-- — ein physisches Geraet gehoert genau einem Mandanten, Claiming-Schutz).
DO $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'nayax_devices_claim_unique'
           AND conrelid = 'automatenlager.nayax_devices'::regclass)
  THEN
    ALTER TABLE automatenlager.nayax_devices
      ADD CONSTRAINT nayax_devices_claim_unique UNIQUE (provider, nayax_machine_id);
  END IF;
END $$;

-- Verkaufs-Idempotenz provider-aware: (tenant_id, provider, nayax_transaction_id)
-- ADDITIV. Der bestehende globale Unique sales_transactions_nayax_transaction_id_key
-- (nayax_transaction_id) BLEIBT, damit der laufende Schreibpfad (pgw_write nutzt
-- `ON CONFLICT (nayax_transaction_id)`) nicht mit 42P10 bricht — Story 23. Drop des
-- alten globalen Unique + Schreibpfad-Umstellung erst in Stufe 6 (n8n-Abloesung).
DO $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'sales_transactions_tenant_provider_uk'
           AND conrelid = 'automatenlager.sales_transactions'::regclass)
  THEN
    ALTER TABLE automatenlager.sales_transactions
      ADD CONSTRAINT sales_transactions_tenant_provider_uk
      UNIQUE (tenant_id, provider, nayax_transaction_id);
  END IF;
END $$;

COMMENT ON COLUMN automatenlager.nayax_devices.provider IS
  'Anbieter (Default nayax). Fundament fuer additive weitere Anbieter (VDIL, eigene SPEC).';
COMMENT ON COLUMN automatenlager.sales_transactions.provider IS
  'Anbieter der externen Transaktions-ID (Default nayax). Idempotenz: (tenant_id, provider, nayax_transaction_id).';
