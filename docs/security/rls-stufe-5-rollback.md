# RLS Stufe 5 — Rollback-Runbook (disziplinierter Notausstieg)

> SPEC: `docs/specs/multi-tenant-rls-stufe-5-v1.md` (User Story 12).
> Dieser Notausstieg ist **temporär** und **auditiert**. Er darf NICHT klammheimlich
> zum dauerhaften Bypass werden.

## Wann

Nur, wenn nach einer Scharfschaltung (Migration 0023–0026) eine Policy das Dashboard
für Faltrix nachweislich lahmlegt (z. B. legitime Reads liefern leer / `current_tenant`
kracht in einem nicht über die Tür laufenden Pfad) und ein Vorwärts-Fix nicht in
Minuten möglich ist.

## Regeln (verbindlich)

1. **Nur die Infra-/Owner-Rolle** (`homelab`, BYPASSRLS) führt den Rollback aus — nie
   die App-Rolle (`automatenlager_app` darf RLS weder abschalten noch Policies droppen;
   sie besitzt die Tabellen nicht).
2. **Auditieren:** Zeitpunkt, ausführende Person, betroffene Tabellengruppe und Grund
   in `dashboard/logs/guest-access.jsonl`-Manier bzw. im Incident-Log festhalten.
3. **Temporär + nachverfolgt:** sofort eine Remediation-Aufgabe (GitHub-Issue) anlegen
   („RLS-Gruppe X wieder scharf schalten"). Der Rollback gilt als offener Incident.
4. **Kein zweiter Mandant**, solange ein Rollback aktiv ist (der Backstop ist dann
   für die betroffene Gruppe offen).

## Befehle

Gezielt eine Gruppe entschärfen (bevorzugt — minimaler Eingriff). `DISABLE` reicht;
`NO FORCE` ist nur nötig, falls die App je als Eigentümer verbände (tut sie nicht):

```sql
-- Beispiel Kern-Gruppe (Migration 0023). Pro betroffener Tabelle:
ALTER TABLE automatenlager.products DISABLE ROW LEVEL SECURITY;
-- … übrige Tabellen der Gruppe analog.
```

Vollständiger Notausstieg (alle Gruppen) — nur im Ernstfall:

```sql
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'machines','locations','machine_profiles','slot_assignments','products','stock_batches',
    'invoices','invoice_items','guv_daily','warnings',
    'stock_movements','sales_transactions','suppliers','nayax_devices',
    'settings_thresholds','warehouses','prices','product_aliases','product_change_proposals',
    'workflow_state','classification_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
```

Die Policies bleiben dabei bestehen (nur deaktiviert) — Wiederinkraftsetzen =
erneut die jeweilige Migration `0023`–`0026` anwenden (idempotent: `ENABLE`/`FORCE`
+ `DROP POLICY IF EXISTS`/`CREATE POLICY`).

## NICHT zurückrollen

- Die App-Rolle `automatenlager_app` (0022) und `n8n_app BYPASSRLS` bleiben bestehen —
  sie sind ohne Policies harmlos und ihr Wegfall bräche die Verbindung/n8n.
- Die Security-View `v_inventory_value_daily` bleibt (economics/assortment lesen sie).
  Sie ist auch ohne RLS korrekt (GUC-Filter).

## Notfall: App sperrt sich aus

Greift die App-Verbindung (`automatenlager_app`) gar nicht mehr, auf die Infra-URL
zurückschalten (`DASHBOARD_V2_APP_PG_URL` in `dashboard/.env.local` leeren ⇒ Fallback
auf die Owner-Verbindung, siehe `server.js` `dashboardV2AppPgUrl`) + Container-Restart.
Owner umgeht RLS (BYPASSRLS) ⇒ Dashboard läuft, während die Policy gefixt wird.
