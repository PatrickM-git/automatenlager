# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-07 — Mandantenfähigkeit STUFE 3 „Query-Filter" (Lese-Isolation) — Issues #122–#129 KOMPLETT (Code), Mini-Deploy AUSSTEHEND

Branch `feat/query-filter-stufe-3` (8 Commits), Suite **1003/1003 grün** (live gegen die
Mini-DB im #94-Sandbox-Harness, ROLLBACK). SPEC:
`docs/specs/multi-tenant-query-filter-stufe-3-v1.md`. Macht die in Stufe 2 scharf
gestellte Mandanten-Identität erstmals in den **Lese-Pfaden** wirksam: jede
DB-gestützte Lese-Abfrage liefert nur noch Daten des **eigenen Mandanten**.

### Architektur (das Fundament, #122)
- **Mandanten-Tür** `dashboard/lib/tenant-db.js` (`createTenantDb`): die EINZIGE legitime
  Stelle für mandanten-bezogene Reads. `read({tenant, tables, text, params})` +
  `write(...)` (Stufe-4-Vorbereitung) + `forTenant`/`forViewer` + `asDoor` (Brücke:
  akzeptiert Tür ODER rohen pg-Client → gewrappt). Fail-closed: kein/leerer Mandant ⇒
  **leeres** Resultat OHNE Abfrage (kein Default, kein „catch ⇒ alles"). Mandant wird
  als **`$1`** vorangestellt; eigene Parameter folgen ab `$2`. Technischer Fehler
  **propagiert** (≠ leer). Stufe-5-Haken (SET LOCAL current_tenant) vorbereitet, inert.
  Geteilter pg-Pool in `server.js` (Registry + Tür).
- **#107-Wächter** `dashboard/lib/query-filter-guard.js`: **struktureller** Contract
  (kein SQL-Parsing) — kein rohes pg (`new Client`/`client.query`/…) außerhalb der Tür.
  Im **build-blocking-Endzustand** (Test `dashboard-query-filter-guard.test.js`).
  Enge Global-Allowlist: nur `tenants`/`tenant_users`/`platform_admins` (Verzeichnis).
  Doku: `docs/security/query-filter-guard-allowlist.md`.
- **Fixtures** `dashboard/tests/helpers/tenant-fixtures.js`: beidseitige `acme`/`globex`
  (FK-konsistente Kette) im Sandbox-Harness; `doorForClient`; Advisory-Lock gegen
  DDL-vs-DML-Deadlock über parallele Sandbox-Transaktionen.

### Migrierte Lese-Domänen (je nicht-vakuöser acme↔globex-Isolationstest)
- **#123 Finanzen/GuV** — economics, economics-live (inkl. Aggregate + MatView `mv_inventory_value_daily`).
- **#124 Übersicht/Cockpit/Monitoring** — overview-monitoring, automaten-view, **alert-digest**
  (Hintergrund-Job: Mandant aus expliziter Quelle `tenant-directory.listTenantIds`, pro
  Mandant, KEIN Default; `audit.workflow_runs` = System-Telemetrie, tenant-gated).
- **#125 Sortiment** — assortment-slots, category-config, settings-thresholds(Read).
- **#126 Bestand/MHD/Lager** — inventory-mhd + Refill-Vorschauen.
- **#127 Automaten/Standorte/Nayax/Einstellungen** — machine-profiles, location-profiles,
  nayax-devices, nayax-abgleich. + **Startup-Race-Fix** (Ready-Log erst nach Registry-Load).
- **#128 Korrektur/Onboarding/Slots** — correction-cases, product-onboarding + slot-Vorschauen.

### Wichtige Einordnung (Abgrenzung)
- App-Filter allein sind **nicht** die finale Garantie. **RLS = Stufe 5** ist der
  unumgehbare DB-Backstop und kommt **ohne Lücke**; **Schreib-Isolation = Stufe 4**
  direkt im Anschluss. **Kein zweiter realer Kunde vor Stufe 3+4+5.** Mit nur einem
  realen Mandanten (Faltrix) leckt während des Umbaus nichts (keine zweiten Echtdaten).
- **Schreibpfade unverändert (Stufe 4):** upsert/create/delete/setThreshold der Module
  location-profiles/machine-create/machine-profiles/settings-thresholds bleiben roh und
  stehen bewusst (dokumentiert) auf der Guard-Allowlist. Infrastruktur-Guards
  (db-schema, stock-cost-invariant) lesen kein Mandanten-Datum → dauerhafte Ausnahme.
- **Config (classification_settings)** wird weiter unter `__default__` gelesen (nicht
  per Viewer) — per-Mandant-Config ist Stufe 6 (mandant_id→tenant_id). Korrektur in
  #125: ein latenter Regress aus #123/#124 (Config per Viewer) wurde rückgängig gemacht.

## Nächste Schritte
1. **PR mergen** (Branch `feat/query-filter-stufe-3`, schließt #107 + #122–#129) und
   **auf den Mini deployen** (reiner Code-Deploy ohne DDL: `git pull --ff-only` +
   Container-Restart). **Finaler Live-Smoke am Mini:** Eigentümer-Zugriff auf alle Panels
   (GuV, Übersicht, Cockpit, Sortiment, Bestand/MHD, Automaten, Korrektur, Onboarding)
   liefert unverändert die Faltrix-Daten; keine leeren Ansichten, keine Fehler.
2. **Stufe 4 (Schreib-Isolation):** die in Stufe 3 bewusst rohen Schreibpfade durch die
   Tür/`db.write` führen + Objekt-Isolation an allen Schreib-Endpunkten.
3. **Stufe 5 (RLS):** den Stufe-5-Haken der Tür zünden (`SET LOCAL current_tenant`) +
   Supabase Row-Level-Security — der unumgehbare Backstop.
