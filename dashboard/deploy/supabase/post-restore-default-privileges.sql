-- Supabase Slice 1 (Issue #214): Default-Privileges NACH dem Schema-Restore.
-- --------------------------------------------------------------------------
-- Der Mini hatte Default-ACLs des Eigentümers `homelab` (pg_default_acl):
--   automatenlager: app_writer=SELECT/INSERT/UPDATE, app_reader=SELECT
--   audit:          app_writer=SELECT/INSERT/UPDATE
-- Die ALTER-DEFAULT-PRIVILEGES-Zeilen des Dumps referenzieren `FOR ROLE homelab`
-- und werden beim Restore gefiltert (Rolle existiert auf Supabase nicht).
-- Hier das Äquivalent für den Supabase-Eigentümer `postgres` (= Ersteller
-- künftiger Tabellen via Migrationen): neue Tabellen erben dieselben Grants.
-- Als `postgres` NACH dem Schema-Restore ausführen. Idempotent.

ALTER DEFAULT PRIVILEGES IN SCHEMA automatenlager
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA automatenlager
  GRANT SELECT ON TABLES TO app_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_writer;
