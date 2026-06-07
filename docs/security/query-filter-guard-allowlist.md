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
mit noch rohem pg) hat zwei begründete Klassen:

| Klasse | Dateien | Begründung |
| --- | --- | --- |
| **Infrastruktur** | `db-schema.js`, `stock-cost-invariant.js` | Kein Mandanten-Datenpfad: lesen `information_schema` bzw. prüfen Invarianten (System-Metadaten). Dauerhafte Ausnahme. |
| **Stufe-4-Schreibpfade** | `location-profiles.js`, `machine-create.js`, `machine-profiles.js`, `settings-thresholds.js` | Ihre **Lesepfade** sind durch die Tür migriert; nur ihre **Schreibfunktionen** (upsert/create/delete/setThreshold) tragen noch rohes pg. Werden in **Stufe 4** (Schreib-Isolation) durch die Tür geführt und in **Stufe 5** (RLS) abgesichert. |

**Ehrliche Garantie-Ebene:** Die Stufe-3-Laufzeitsicherung ist der **Wächter im CI**
(kein neuer ungesicherter Read kommt rein), **nicht** die Tür zur Laufzeit. Ein Leck,
das am Wächter vorbeikäme, fängt erst **RLS (Stufe 5)** zur Laufzeit ab — bewusst
akzeptierter Restrisiko-Korridor; ein zweiter realer Kunde erst nach Stufe 3+4+5.
