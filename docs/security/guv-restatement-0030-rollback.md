# GuV-Restatement 0030 — Rollback-Runbook (exakte Umkehr je `run_id`)

> SPEC: `docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md` (User Stories 9, 10).
> Das Restatement hebt die gebuchte Historie **beleg-treu in-place auf brutto** und ist
> die Grundlage der Steuererklärung. Jeder Lauf ist vollständig auditiert
> (`audit.guv_restatement_log`) und über seine `restatement_run_id` **exakt umkehrbar** —
> auch ein Teil-Lauf.

## Was das Restatement tut (Kurzfassung)

Pro Zeile mit `cost_basis = 'netto'` eines effektiven Kleinunternehmer-Mandanten
(`revenue_gross` bleibt unverändert):

- `new_cost_of_goods = old_cost_of_goods × (1 + Kategorie-MwSt/100)`
- `new_gross_profit  = revenue_gross − new_cost_of_goods`
- `new_revenue_net   = revenue_gross`
- `cost_basis        = 'brutto'`

Kategorie-MwSt + Faktor stammen aus derselben `costBasisMultiplier`/`resolveCategory`-Logik
wie der korrigierte Nacht-Job (#176) → Historie == go-forward. Jede geänderte Zeile
schreibt einen Eintrag in `audit.guv_restatement_log` mit `run_id`, Alt-/Neu-Werten,
`vat_rate`, `factor`, `executed_by`, `executed_context`.

## Voraussetzungen (vor jedem Lauf)

1. Migrationen `0028` (Spalte/Tabelle) + `0029` (Klassifizierung) + `0030` (Grants) sind angewendet.
2. Preflight liefert **Exit 0**: `node dashboard/tools/preflight-guv-daily.js` (#177).
   - Exit 1 = harte Anomalie (Restatement **blockiert**), Exit 2 = manuelle Prüfung nötig.
3. **Schutzbedingung:** im Zielscope existiert **keine** `cost_basis IS NULL`-Zeile
   (der Run bricht sonst je Mandant ab — kein „halb korrigiert").

## Lauf

```bash
cd dashboard
DASHBOARD_V2_PG_URL=... node tools/run-guv-restatement.js              # alle Mandanten
DASHBOARD_V2_PG_URL=... node tools/run-guv-restatement.js --tenant t_x # ein Mandant
```

Der Runner gibt die `run_id` aus (`restatement-0030-<ISO>`). **`run_id` notieren** — sie
ist der Schlüssel für den Rollback.

## Rollback (exakte Umkehr)

```bash
cd dashboard
DASHBOARD_V2_PG_URL=... node tools/run-guv-restatement.js --rollback <run_id>
```

Der Rollback liest je `guv_key` die Alt-Werte aus `audit.guv_restatement_log`
(`WHERE restatement_run_id = <run_id> AND rollback_at IS NULL`) zurück:

- `cost_of_goods`, `gross_profit`, `revenue_net` ← Alt-Werte,
- `cost_basis` ← `'netto'`,
- stempelt `rollback_at = now()`, `rollback_by`.

Eigenschaften:

- **Teil-Rollback:** genau die Zeilen eines Laufs (`run_id`) werden zurückgesetzt — andere
  Läufe bleiben unberührt.
- **Idempotent:** nur Logbuch-Zeilen mit `rollback_at IS NULL` werden angefasst; ein
  zweiter Rollback desselben Laufs ist ein No-op.
- **Reproduzierbar:** nach einem Rollback liefert ein erneutes Restatement **identische**
  neue Werte (verifiziert: `tests/guv-restatement.test.js`).

### Manueller Rollback (Fallback, ohne Runner)

Pro Mandant in einer Transaktion durch die Tür / als Infra-Rolle:

```sql
BEGIN;
UPDATE automatenlager.guv_daily g
   SET cost_of_goods = l.old_cost_of_goods,
       gross_profit  = l.old_gross_profit,
       revenue_net   = l.old_revenue_net,
       cost_basis    = 'netto'
  FROM audit.guv_restatement_log l
 WHERE l.restatement_run_id = :run_id
   AND l.rollback_at IS NULL
   AND g.tenant_id = l.tenant_id
   AND g.guv_key   = l.guv_key;

UPDATE audit.guv_restatement_log
   SET rollback_at = now(), rollback_by = :operator
 WHERE restatement_run_id = :run_id AND rollback_at IS NULL;
COMMIT;
```

## Regeln (verbindlich)

1. **Vor dem Lauf** Preflight Exit 0 + Voraussetzungen prüfen — nie blind restaten.
2. **`run_id` festhalten** (Lauf-Protokoll/Incident-Log) — ohne sie kein gezielter Rollback.
3. **Mini-Deploy-Reihenfolge** (Memory `mini-deploy-mechanismus`): DDL `0028`→`0029`→`0030`
   vor dem Run, Container-Restart, danach Live-Smoke (GuV-Panel zeigt die korrigierten,
   niedrigeren Gewinn-Zahlen).
4. **Regelbesteuerte Mandanten** werden nie restated (Mandanten-Tor auf das effektive
   Kleinunternehmer-Flag) — ihr Bestand bleibt netto.
5. Backup griffbereit (Memory `pg-backup-mechanismus`) — der Logbuch-Rollback ist die
   erste, der DB-Restore die letzte Verteidigungslinie.
