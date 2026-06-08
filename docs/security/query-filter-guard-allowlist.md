# Query-Filter-Contract-Guard — Global-Allowlist & struktureller Vertrag (Stufe 3, #107/#122)

> Begleitdokument zur Mandanten-Tür (`dashboard/lib/tenant-db.js`) und zum Wächter
> (`dashboard/lib/query-filter-guard.js`).
> SPEC: `docs/specs/multi-tenant-query-filter-stufe-3-v1.md`.

## Zweck

Stufe 3 trennt die Lese-Pfade nach Mandant. Der Wächter (#107) fängt **strukturell**
(kein SQL-Parsing) jeden Lesepfad, der **an der Mandanten-Tür vorbei** läuft, d. h.
rohen DB-Zugriff (`new Client` / `new Pool` / `require('pg')` / `client.query` /
`pool.query`) **außerhalb** von `lib/tenant-db.js`.

## Struktureller Vertrag (warum kein SQL-Parsing)

Beliebiges SQL semantisch zu verstehen (zusammengebaute Strings, Joins, Aggregate)
wäre ein löchriger Parser — eine Scheingarantie. Stattdessen gilt:

1. **No-Bypass:** kein roher DB-Zugriff außerhalb der Tür. Die Tür ist die **einzige**
   erlaubte DB-Zugriffsschicht (`DOOR_FILES = ['tenant-db.js']`).
2. **Explizite Deklaration:** jeder Tür-Aufruf übergibt **explizit** den Mandanten
   (als `$1`-Parameter) **und** die Zieltabelle(n) (`tables: [...]`).

Damit reduziert sich „vergessener `WHERE tenant_id = …`-Filter" auf die robust
erkennbare Frage „greift jemand an der Tür vorbei?".

## Modi des Wächters

- **Melde-Modus** (`buildReport`): inventarisiert alle Lesepfade und listet die noch
  an der Tür vorbei laufenden (Worklist). Bricht den Build **nicht**. Zustand in #122.
- **Scharf, bereichsweise** (`findViolations` mit Allowlist): pro abgeschlossenem Slice
  (#123ff.) wird die Allowlist noch-nicht-migrierter Dateien **kleiner**; ein migrierter
  Bereich kann nicht mehr unbemerkt zurückfallen.
- **Build-blocking-Endzustand** (#129): Allowlist leer ⇒ jeder neue rohe/umgehende Read
  bricht den Build.

## Global-Allowlist echt-globaler Tabellen (EXTREM ENG)

**Default ist mandantenpflichtig.** Global ist die **begründete Ausnahme**, nie die
Regel. Aufnahmekriterium: **keinerlei kundenspezifische Information**. Jede Aufnahme ist
ein bewusster, reviewter Akt mit Begründung (Quelle der Wahrheit:
`GLOBAL_TABLE_ALLOWLIST` in `lib/query-filter-guard.js`).

| Tabelle | Begründung |
| --- | --- |
| `tenants` | Mandanten-Verzeichnis (Auth-Infrastruktur). Nur von der Verzeichnis-/Auth-Schicht gelesen, nie als Mandantendaten ausgespielt. |
| `tenant_users` | Verzeichnis: Login→Mandant (Auth-Infrastruktur). Keine operativen Kundendaten. |
| `platform_admins` | Verzeichnis: Break-Glass-Schlüssel der Plattform-Admins (Auth). Keine Kundendaten. |

### Bewusst NICHT global (mandantenpflichtig — Reviewer-Härtung)

`machines`, `locations`/`location_profiles`, `settings_thresholds`, `products`,
`sales_transactions`, `guv_daily`, `stock_batches`, `warnings`, `slot_assignments`,
… — und **jede** Tabelle mit kundenspezifischem Inhalt.

- **`nayax_devices`** ist als Geräte-**Zuordnung** mandantenpflichtig (trägt `tenant_id`,
  Migration 0009). Der **einzige** eng begründete Globalfall ist die reine
  **Existenz-/Claiming-Eindeutigkeitsprüfung** (globale Unique `(provider,
  nayax_machine_id)`, kein nutzersichtbarer Lesepfad; Onboarding/Stufe 6). Das ist eine
  **Query-Form**, keine Tabellen-Ausnahme — daher **nicht** in der Allowlist. Jeder
  nutzersichtbare Geräte-Read ist tenant-gefiltert.
- **`classification_settings`** trägt seine Mandanten-Dimension als `mandant_id`
  (Brücke `category-config.js::tenantColumn()`, bis Stufe 6) — mandantenpflichtig.

### (Mat)Views sind kein Bypass

Die mandanten-führenden (Mat)Views (`mv_inventory_value_daily`,
`mv_db_per_product_monthly`, `mv_db_per_slot_monthly`, `v_*`) werden **über die Tür**
gelesen und tragen ihren `tenant_id`-Filter wie Basistabellen — kein Sonderfall „ist ja
schon getrennt".

## Anti-Aufblähung

Die Global-Allowlist bleibt **sehr kurz** (Test: `≤ 5` Einträge). Wächst sie, muss die
Schranke bewusst angefasst und die Aufnahme hier begründet werden.

## Endzustand nach Stufe 3 (#129) — build-blocking

Nach den Slices #123–#128 ist die **Read-Migrations-Ausnahmeliste leer** (alle
Lese-Domänen laufen durch die Tür). Der Wächter ist **build-blocking**: jeder NEUE rohe
oder ungefilterte Read außerhalb der Datei-Allowlist bricht die Suite/CI
(`dashboard-query-filter-guard.test.js`).

Die verbleibende **Datei-Allowlist** (nicht Tabellen — diese ist die Liste der `lib/*.js`
mit noch rohem pg) hatte nach Stufe 3 zwei Klassen; **nach Stufe 4 bleibt nur noch eine:**

| Klasse | Dateien | Begründung |
| --- | --- | --- |
| **Infrastruktur** | `db-schema.js`, `stock-cost-invariant.js` | Kein Mandanten-Datenpfad: lesen `information_schema` bzw. prüfen Invarianten (System-Metadaten). Dauerhafte Ausnahme. |

## Endzustand nach Stufe 4 (#131–#139) — Schreibpfade durch die Tür

Stufe 4 hat die in Stufe 3 bewusst belassenen **Schreibpfade** durch die Mandanten-Tür
geführt. Die frühere Klasse „Stufe-4-Schreibpfade" der Datei-Allowlist
(`location-profiles.js`, `machine-create.js`, `machine-profiles.js`,
`settings-thresholds.js`) ist damit **leer** — alle vier schreiben jetzt über
`db.write()`/`db.tx` (Mandant als `$1`). Die finale `lib/`-Allowlist ist **nur noch
Infrastruktur** (`db-schema.js`, `stock-cost-invariant.js`); `STUFE4_WRITE_ALLOWLIST = []`
im Guard-Test. Der Wächter bleibt damit für `lib/`-Schreibpfade **build-blocking**.

- **Tür-Schreibmodus:** `db.write()` ist **fail-closed-werfend** (kein Mandant ⇒ Fehler,
  nicht stilles `{rowCount:0}`); `db.read()` bleibt fail-closed-**leer**. Der
  transaktionale Modus `db.tx(tenant, fn)` führt Parent-Prüfung **und** Schreibung atomar
  auf einem Client aus (TOCTOU-Schutz) — der vorbereitete, in Stufe 4 **inerte** Ort für
  den Stufe-5-RLS-Haken (`SET LOCAL automatenlager.current_tenant`).
- **Autorisierungs-Tor** an allen schreib-auslösenden Webhook-Endpunkten
  (`requireMachineAccess` für refill/slot-assign-inline; Case-Mitgliedschaft für
  correction-action/onboarding). **`tenant_id`/`mandant_id` im Body ⇒ 400 + Audit.**
- **Break-Glass:** der zentrale Methodenriegel blockt jeden Schreib-/Trigger-Endpunkt
  unter aktiver Support-Sitzung (403 `SUPPORT_SESSION_READ_ONLY`).
- **DDL:** `locations`/`machines`/`machine_profiles` mandantengetrennte Uniques
  (`0020`), tenant-skopierter `machine_profiles`-Trigger (`0021`).

### Residual: roher pg in `server.js` (bewusst, dokumentiert)

`server.js` erzeugt den geteilten `pg.Pool` (das **Backing der Tür**) und enthält noch
einzelne rohe `new Client` in **Lese**-Endpunkten (Stufe-3-Restposten, z. B. Nayax-/
Report-Reads). Der `lib/`-Guard scannt `server.js` **nicht** build-blocking (der Guard ist
**strukturell** und kann eine rohe Schreibung nicht von einem rohen Read im selben File
unterscheiden — die SPEC verzichtet bewusst auf einen SQL-Parser). Der frühere **inline-
Schreibpfad** (write-off) ist in Stufe 4 (#138) in eine durch die Tür gehende Lib
ausgelagert; in `server.js` verbleibt **kein** roher Schreibpfad. Eine künftig versehentlich
**inline** in `server.js` eingefügte Rohschreibung wäre der bewusst akzeptierte Rest­risiko-
Korridor — abgefangen zur Laufzeit erst durch **RLS (Stufe 5)**.

**Ehrliche Garantie-Ebene:** Die Stufe-3/4-Laufzeitsicherung ist die **Tür + das
Autorisierungs-Tor + der Wächter im CI**, **nicht** ein SQL-prüfender Parser. Ein Leck,
das am Wächter vorbeikäme, fängt erst **RLS (Stufe 5)** ab — bewusst akzeptierter
Restrisiko-Korridor; **ein zweiter realer Kunde erst nach Stufe 3+4+5.**

## Stufe 6 (#160) — `lib/jobs/*` + Worker-Einstieg im Scan

Stufe 6 löst n8n ab; die portierten Jobs leben in `lib/jobs/*` und der Scheduler in
`worker.js`. Beide kommen in den **build-blocking Standard-Scan** des Wächters, damit
kein Job versehentlich an der Tür vorbei schreibt:

- **`extraDirs`** erweitert `buildReport`/`findViolations` additiv um flache Verzeichnisse
  (hier `lib/jobs/`), per Basename klassifiziert wie `entryFiles`. Der Worker-Einstieg
  `worker.js` wird wie `server.js` über `entryFiles` mitgescannt.
- **Saubere Job-Module** (`tenant-runner.js`, `shadow-harness.js`) tragen **kein** rohes pg
  (sie bekommen die Tür injiziert) und stehen daher **nicht** auf der Allowlist — ein
  Rückfall (neues rohes pg) bräche den Build. Der Telemetrie-Schreiber `lib/workflow-runs.js`
  ist ebenfalls sauber (injizierter `exec`).

### Dokumentierte Datei-Ausnahmen (Stufe 6)

| Datei | Begründung |
| --- | --- |
| `infra-runner.js` | Mandantenübergreifende Pflege (`REFRESH MATERIALIZED VIEW …`) über die **Infra-/BYPASSRLS-Verbindung** — der einzige legitime Nicht-Tür-Pfad (kein Mandant zu setzen). Kapselt rohes `pool.query` an EINER Stelle; View-Namen gegen Allowlist validiert (kein Identifier-Injection). Analog `db-schema.js`. |
| `worker.js` | Kompositions-Wurzel/Einstieg (`new Pool` für Infra- + App-Verbindung), injiziert Tür+Infra in die Jobs. Kein eigener Mandanten-Read. Analog `server.js`. |

`audit.workflow_runs` ist **System-Telemetrie ohne `tenant_id`** (geteilte Pipeline) — der
Schreiber läuft bewusst über die Infra-Verbindung, nicht durch die Tür.

> Vollständiger Backstop-Nachweis (`n8n_app` verliert BYPASSRLS, „Schreiben ohne GUC kracht")
> = **Slice 4 (#164)** — erst wenn ALLE ex-n8n-Schreiber durch die Tür gehen.
