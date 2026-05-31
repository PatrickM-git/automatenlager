# DB-Schema-Contract & Drift-Guard

Das Dashboard formuliert rohes SQL gegen das PostgreSQL-Schema `automatenlager`
(homelab-DB, via SSH-Tunnel `127.0.0.1:15432`). Damit eine Abweichung zwischen
Code-Annahme und echtem Schema **früh und präzise** auffällt — und nicht erst als
HTTP 503 beim nächsten Feature — gibt es einen Schema-Contract.

> Hintergrund: Ein `SELECT … status … FROM automatenlager.locations` lief gegen
> eine Tabelle ohne `status`-Spalte und warf erst zur Laufzeit
> `PG_ERROR: column "status" does not exist`. Der Guard hätte das beim Testen/Start
> gemeldet.

## Bausteine

| Baustein | Datei | Zweck |
| --- | --- | --- |
| Relations-Manifest | [`lib/db-schema.js`](../lib/db-schema.js) → `EXPECTED_RELATIONS` | Liste der Tabellen/Views/Matviews, die das Dashboard braucht. Existenz wird geprüft. |
| SQL-Scanner | `lib/db-schema.js` → `parseRelationColumnRefs` | Liest die echten SQL-Strings aus `server.js` + `lib/*.js` und leitet die genutzten `(Relation, Spalte)`-Paare ab. **Kein manuelles Pflegen von Spaltenlisten.** |
| Live-Check | `lib/db-schema.js` → `runSchemaCheck` | Vergleicht Manifest + Scanner mit dem echten Schema (`pg_catalog`, inkl. Materialized Views). |
| Drift-Test | [`tests/dashboard-db-schema.test.js`](../tests/dashboard-db-schema.test.js) | Läuft im `npm test`. Bei erreichbarem Tunnel hart; offline `skip`. |
| Diagnose-Endpoint | `GET /api/v2/_diagnostics/schema` (Admin) | Laufzeit-Report. `200` = gesund, `503` = Drift. |
| Startup-Check | `server.js` → `logStartupSchemaCheck` | Loggt beim Start `✓ Schema-Contract erfüllt` bzw. `⚠ Schema-Drift erkannt …`. Nicht-blockierend. |

## So erweiterst du das Dashboard ohne Alt-Probleme

1. **Neue Spalte in bestehender Relation benutzen:** einfach im SQL verwenden.
   Der Scanner erfasst qualifizierte `alias.spalte`-Referenzen und INSERT-Spalten
   automatisch und prüft sie gegen die DB. Existiert die Spalte nicht → roter
   Test / `⚠` beim Start. Nichts weiter zu tun.
2. **Neue Relation (Tabelle/View/Matview) nutzen:** eine Zeile in
   `EXPECTED_RELATIONS` ergänzen (`{ name, kind, note }`). Damit wird ihre Existenz
   geprüft.
3. **Prüfen:**
   - `cd dashboard && npm test` (mit laufendem SSH-Tunnel) — der Test
     `LIVE: Dashboard-SQL passt zum echten automatenlager-Schema` wird hart.
   - oder `GET /api/v2/_diagnostics/schema` als Admin aufrufen.
   - oder Server starten und auf die `✓/⚠`-Zeile im Log achten.

## Grenzen des Scanners (bewusst konservativ)

Geprüft werden **qualifizierte** `alias.spalte`-Referenzen (Alias an
`automatenlager.<relation>` gebunden) sowie **INSERT-Spaltenlisten**. *Nicht*
spaltenscharf geprüft: unqualifizierte SELECT-Spalten, `SELECT *` und
`UPDATE … SET`-Spalten — hier greift nur die Relations-Existenzprüfung. Lieber
still als Fehlalarm: was der Scanner nicht eindeutig zuordnen kann, meldet er
nicht. Neue Queries daher möglichst mit Tabellen-Alias schreiben
(`FROM automatenlager.x AS t … t.spalte`), dann ist die Abdeckung am höchsten.
