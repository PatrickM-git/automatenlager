# Slice 1 (#214) — DB → Supabase: Runbook + Ergebnis-Protokoll 2026-06-12

> Gehört zur SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md` (Slice 1).
> Ziel-DB: Supabase-Projekt **Faltrix** (`bimftbjpvljjnvorqbtn`, eu-central-1/Frankfurt,
> PG 17). Quelle: Mini-Prod-DB `homelab` (PG 16) via Tailscale-Tunnel `127.0.0.1:15432`.
> Keine Secrets in dieser Datei — Connection-Strings in `dashboard/.env.local`
> (`SUPABASE_PG_URL_SESSION` = Infra/Migrationen Port 5432, `SUPABASE_PG_URL_TX` =
> postgres via TX-Pooler, `SUPABASE_APP_PG_URL_TX` = App-Rolle via TX-Pooler 6543).

## Rollen-Abbildung (ohne Custom-BYPASSRLS)

| Mini | Supabase | Anmerkung |
| --- | --- | --- |
| `homelab` (Superuser, Eigentümer) | `postgres` (rolbypassrls=true) | Infra-Pool: Bootstrap, Migrationen, MatView-Refresh, Registry |
| `automatenlager_app` (LOGIN, kein BYPASSRLS) | `automatenlager_app` (identisch) | App-Pool über **Transaction-Pooler 6543**, Username `automatenlager_app.<ref>` |
| `app_reader`/`app_writer` (NOLOGIN, out-of-band) | identisch, via `dashboard/deploy/supabase/bootstrap-roles.sql` | Objekt-Grants kamen mit dem Schema-Dump |
| `n8n_app` | **existiert bewusst NICHT** | Migration 0033 ist rollen-bedingt und skippt (NOTICE) |
| `migrator`/`validator` (Alt-Ära) | **nicht angelegt** | Grants beim Dump-Filter entfernt; nichts im Code nutzt sie |

## Durchgeführte Schritte (wiederholbar)

1. **Rollen-Bootstrap** (als `postgres`, Session-Pooler):
   `psql $SUPABASE_PG_URL_SESSION -f dashboard/deploy/supabase/bootstrap-roles.sql`
2. **Schema-Dump** vom Mini (PG-17-Client gegen PG 16 ok):
   `pg_dump $MINI_URL --schema-only --no-owner -n automatenlager -n audit -f schema.sql`
3. **Filter** (Rollen, die es auf Supabase nicht gibt):
   `grep -vE "^(GRANT|REVOKE) .*( TO | FROM )(n8n_app|migrator|validator);$" schema.sql | grep -v "^ALTER DEFAULT PRIVILEGES FOR ROLE homelab" > schema.filtered.sql`
4. **Schema-Restore:** `psql $SUPABASE_PG_URL_SESSION -v ON_ERROR_STOP=1 -f schema.filtered.sql`
5. **Default-Privileges** (Ersatz für die gefilterten homelab-Default-ACLs):
   `psql ... -f dashboard/deploy/supabase/post-restore-default-privileges.sql`
6. **Daten-Dump:** `pg_dump $MINI_URL --data-only --no-owner -n automatenlager -n audit -f data.sql`
7. **Daten-Restore ohne Trigger-Feuer** (FIFO-/Bridge-Trigger dürfen beim Kopieren
   nicht erneut buchen): `SET session_replication_role = replica;` voranstellen,
   dann `psql ... --single-transaction -f data.replica.sql`. (Supabase erlaubt
   das als `postgres` — live verifiziert.)
8. **Migrationskette 0001–0036** der Reihe nach (Idempotenz-Beweis, alle grün;
   0033 skippt mit NOTICE, da `n8n_app` fehlt). WICHTIG: **erst Daten, dann
   Migrationen** — 0006/0010/0018 seeden Zeilen mit Tenant-FK auf `tenants`.
9. **MatViews refreshen:** `REFRESH MATERIALIZED VIEW automatenlager.mv_inventory_value_daily / mv_db_per_product_monthly / mv_db_per_slot_monthly`.
10. **App-Rollen-Passwort** out-of-band: `ALTER ROLE automatenlager_app PASSWORD '…'`
    (Passwortmanager); App-URL = `postgresql://automatenlager_app.<ref>:<pw>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`.

## Verifikation (alle automatisiert, 2026-06-12)

- `dashboard/tests/supabase-slice1-verify.test.js` — 4/4 grün (Rollen-Split,
  Migrations-Marker + RLS aktiv, fail-closed-GUC, Datenplausibilität).
- **Isolationssuite gegen Supabase:** `DASHBOARD_V2_PG_URL=$SUPABASE_PG_URL_SESSION node --test tests/dashboard-mt-*.test.js tests/dashboard-write-isolation-fundament.test.js` → **163/163 grün** (acme/globex-Negativ-Matrix, WITH-CHECK, MatView-Verweigerung, fail-closed).
- **Zeilenzahlen Mini ↔ Supabase identisch** für alle Tabellen in `automatenlager` + `audit`
  (einzige Abweichung: `audit.workflow_runs` +6 auf dem Mini — Lauf-Telemetrie des
  weiterlaufenden Workers nach dem Dump; finaler Delta-Sync erfolgt beim Cutover #219).
- **/health vom Mini gegen Supabase:** temporäre zweite Instanz auf dem Mini
  (`PORT=8899`, Env-Override auf Supabase-URLs) → `{"ok":true,"tenantDirectoryReady":true,"tenantDbReady":true,"pgConfigured":true}`.
- Volle Suite gegen den Mini: 1380/1381 (1 bekannter Parallel-Flake
  `dashboard-v2-uploads`, isoliert 8/8 grün).

## Bewusste Abweichungen von der SPEC/AC (begründet)

1. **KEINE GUC-Vorregistrierung** (`ALTER DATABASE … SET automatenlager.current_tenant = ''`):
   Ein DB-weiter Leerwert-Default würde das fail-closed-Verhalten aufweichen —
   fehlender Mandant soll **krachen** (42704, Migration 0034 + Test), nicht still
   `''` liefern. `set_config(..., true)` funktioniert auf Supabase auch ohne
   Vorregistrierung (live verifiziert). Die AC-Formulierung „Fehler 42704 / keine
   Zeilen" ist erfüllt — in der härteren Form.
2. **Pooler-Realität dokumentiert:** Hinter Supavisor kann ein recyceltes
   Server-Backend den GUC-Platzhalter bereits kennen (dann `''` statt 42704;
   einarmige Policies liefern 0 Zeilen, die Vereinigungs-Policy höchstens
   `__default__`). Beide Formen sind dicht; die Tests (0034 + supabase-slice1-verify)
   prüfen die vom Backend garantierte Form und hart auf „kein Tenant-Leak".
3. **Migration 0031 ist auf Supabase vollständig wirksam** (globale Business-Key-
   Uniques gedroppt) — auf dem Mini ist Teil 1+2 noch deploy-gated (#164/#198).
   Die Tests `#99`/`#102` asserten jetzt beide legitimen Zustände exakt
   (Übergang Mini / Endzustand Supabase), nichts dazwischen.

## Rollback

Slice 1 ändert **nichts** am Produktivbetrieb: der Mini-Container zeigt weiter auf
die Mini-DB. Rollback = Supabase-Projektinhalt verwerfen (Schema droppen oder
Projekt zurücksetzen); Wiederholung = Schritte 1–10. Erst #219 (Cutover) macht
Supabase zur führenden DB — bis dahin ist die Supabase-Kopie Wegwerf-Material
und wird beim Cutover frisch synchronisiert.
