# SPEC: Mandanten-Query-Filter (Stufe 3) — flächendeckende Lese-Isolation über eine Mandanten-Tür

> Stufe 3 der Mandantenfähigkeits-Migration. Macht die in Stufe 2 scharf gestellte
> Mandanten-Identität erstmals in den **Lese-Pfaden** wirksam: jede datenbankgestützte
> Abfrage liefert nur noch Daten des **eigenen Mandanten**. Umgesetzt über **eine
> zentrale, fail-closed „Mandanten-Tür"** statt über 40 einzeln gepflegte Filter, plus
> einen automatischen Wächter, der vergessene Filter fängt.
>
> Vorgänger: `docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md` (Stufe 2, „Auth scharf").
> Landkarte: `docs/specs/mandantenfaehigkeit-audit-2026-06-05.md` (Schritt 3 der
> Migrationsreihenfolge 0→8). Begleit-Issue: #107 (Query-Filter-Contract-Guard).

## Problem Statement

Nach Stufe 2 kennt der Viewer seinen **echten Mandanten** (`tenantId`, z. B. `t_faltrix`),
die IDOR-Prüfung an den zwei verdrahteten Schreib-Endpunkten ist scharf, und ein
unzugeordneter Login bekommt keinen Mandanten. **Die Lese-Abfragen filtern aber noch
nicht nach Mandant.** Stellvertretend belegt: `lib/economics.js` (Finanz-/GuV-Lesepfad)
referenziert `tenant_id` **null Mal** — die SQL-Queries lesen über alle Mandanten hinweg.
Das gilt für praktisch alle ~40 lesenden `lib/*`-Module (Finanzen, Übersicht/Cockpit,
Monitoring, Sortiment, Bestand/MHD, Reports, Korrektur-Fälle u. v. m.).

Heute **leckt** dadurch faktisch nichts, weil es nur **einen** echten Mandanten (Faltrix)
gibt — es existieren schlicht keine fremden Daten. Aber:

- In dem Moment, in dem ein **zweiter echter Kunde** auf demselben System liegt, würde
  **jeder** ungefilterte Lese-Pfad fremde Mandanten-Daten mischen.
- Die Leck-Fläche ist **breit und wächst unbemerkt**: Jede neue Abfrage ohne Filter ist
  ein neues Leck, und es gibt heute **keinen automatischen Mechanismus**, der ein
  vergessenes `WHERE tenant_id = …` erkennt.
- Der Schaden ist **kategorisch**: Sieht Kunde B auch nur eine Zahl von Kunde A, ist das
  Vertrauen in das System zerstört — unabhängig davon, *welche* Daten es waren. Es gibt
  hier keine „harmlose" Teilmenge.

Solange die Lese-Pfade nicht mandantengetrennt sind, ist die in Stufe 0–2 gebaute
Mandanten-Infrastruktur für den Alltagsbetrieb (das Anschauen von Daten) **wirkungslos**.

## Solution

Stufe 3 trennt die **Lese-Pfade** sauber nach Mandant — als Sicherheits- und
Verkabelungs-Stufe, ohne neue fachliche Features und ohne UI-Änderung.

1. **Eine Mandanten-Tür (Deep Module):** Sämtliche lesenden DB-Zugriffe laufen über
   **einen** zentralen, mandanten-bewussten Datenzugriffs-Helfer. Diese Tür **verlangt
   zwingend einen Mandanten** und arbeitet **fail-closed**: ohne gesetzten Mandanten führt
   sie keine mandanten-bezogene Abfrage aus. Statt 40-mal kopierte Filter gibt es **eine**
   Stelle, an der die Mandanten-Bindung erzwungen wird. **Direkte DB-Reads an der Tür
   vorbei sind verboten (No-Bypass).**
2. **Effektiver Mandant aus dem Viewer:** Die Tür filtert auf den effektiven Mandanten des
   Viewers (`viewer.tenantId`). Damit gilt automatisch: Eigentümer ⇒ `t_faltrix`;
   Break-Glass-Support-Sitzung ⇒ Ziel-Mandant (weiterhin nur-lesend); unzugeordneter
   Login (Gast) ⇒ **kein Mandant ⇒ leeres Dashboard**.
3. **#107-Wächter (Query-Filter-Contract-Guard):** Ein automatischer Test fängt jede
   mandanten-relevante Abfrage, die **ohne** Mandanten-Bezug bzw. **an der Tür vorbei**
   ausgeführt würde. Er startet im **Melde-Modus** (vollständige Liste aller noch
   ungefilterten Lesepfade) und wird **Bereich für Bereich scharf** geschaltet
   (schrumpfende Ausnahmeliste, Default-Deny), sodass ein abgesicherter Bereich nicht
   zurückfallen kann. Im Endzustand ist der Wächter **build-blocking**: ein neuer
   ungefilterter Read bricht den Build.
4. **Bewusste Allowlist echt-globaler Tabellen:** Tabellen, die absichtlich
   mandantenübergreifend sind (das Mandanten-Verzeichnis selbst, die Provider-Dimension,
   das global-eindeutige Geräte-Register), werden explizit **ausgenommen** — damit der
   Wächter sie nicht fälschlich anmeckert und niemand sie aus Versehen filtert.
5. **Häppchenweiser Rollout:** Bereich für Bereich (Finanzen zuerst), je ein vertikaler
   Slice mit Test gegen zwei synthetische Mandanten (`acme`, `globex`) und Live-Check,
   damit das produktiv genutzte Dashboard durchgehend funktioniert.

Die Tür ist zugleich **der Haken für Stufe 5**: Dort wird an genau dieser einen Stelle die
RLS-Sitzungsvariable „aktueller Mandant" gesetzt, sodass die Datenbank-Garantie ohne
erneuten Eingriff in die 40 Module nachgezogen werden kann.

Ergebnis: Die Lese-Isolation ist **flächendeckend** und gegen zwei echte, verschiedene
Test-Mandanten end-to-end verifizierbar. Schreib-Isolation (Stufe 4) und die unumgehbare
DB-Garantie (Stufe 5) bleiben bewusst den Folgestufen vorbehalten und kommen **ohne
Lücke** vor jedem zweiten realen Kunden.

## User Stories

### Lese-Isolation (Kern)

1. As an Eigentümer, I want every read in the dashboard to return only data of my own
   tenant, so that no other customer's data can ever appear in my views.
2. As a Betreiber, I want **all** ~40 read query functions (economics, overview/cockpit,
   monitoring, assortment, inventory/MHD, reports, correction cases, …) to be
   tenant-scoped, so that the isolation is complete and not partial.
3. As a Sicherheitsverantwortlicher, I want a single leaked read path to be impossible to
   ship unnoticed, so that trust in the system is never put at risk.

### Mandanten-Tür (Architektur)

4. As an Entwickler, I want all read queries to go through **one** central tenant-aware
   data-access module, so that the tenant binding is enforced in exactly one place instead
   of being copy-pasted into 40 modules.
5. As an Entwickler, I want the door to **refuse** to run a tenant-scoped query when no
   tenant is set (fail-closed), so that forgetting to pass a tenant cannot silently return
   all tenants' rows.
6. As an Entwickler, I want the door to centralize the database connection (today each
   module opens its own `pg.Client`), so that connection handling and the tenant binding
   are consistent and testable.
7. As an Entwickler, I want the door to be the same chokepoint where Stufe 5 will set the
   RLS session variable, so that the database backstop can be added later without touching
   the 40 modules again.

### Effektiver Mandant & Verhalten

8. As an Eigentümer, I want the door to use my **effective** tenant from the viewer, so
   that I always see exactly my tenant and nothing else.
9. As a Plattform-Admin, I want a read during an active break-glass support session to be
   scoped to the **target** tenant (read-only), so that support sees the customer's data
   and only the customer's data.
10. As a Betreiber, I want a login with **no** tenant (guest/unmapped) to see an **empty**
    dashboard, so that an unassigned account never inherits anyone's data.
11. As a Sicherheitsverantwortlicher, I want a **missing** tenant to result in *no data*
    rather than a default tenant (consistent with Stufe 2), so that a bug never falls back
    to showing someone's data.
12. As a Betreiber, I want a **technical** failure in the door to surface as an error, not
    as empty results, so that an outage is distinguishable from a legitimately empty
    result.

### #107 Wächter (Query-Filter-Contract-Guard)

13. As a Sicherheitsverantwortlicher, I want an automated guard that fails the test suite
    when a query touching a tenant-scoped table runs without a tenant binding / outside the
    door, so that a forgotten filter is caught before it ships.
14. As an Entwickler, I want the guard to start in **report mode**, listing every
    still-unfiltered read, so that we have a complete, trustworthy worklist.
15. As an Entwickler, I want the guard to be flipped to **enforce per domain** (a shrinking
    allowlist of not-yet-migrated paths), so that a migrated area can never silently
    regress.
16. As an Entwickler, I want the guard to know a deliberate **allowlist of genuinely
    global tables**, so that it does not falsely flag tables that must not be
    tenant-filtered.

### Echt-globale Tabellen

17. As an Entwickler, I want the tenant-directory tables (`tenants`, `tenant_users`,
    `platform_admins`), the provider dimension and the global `nayax_devices` registry to
    be **exempt** from tenant filtering, so that cross-tenant infrastructure keeps working.
18. As a Betreiber, I want the global-vs-tenant classification of every read to be
    **explicit and reviewed**, so that nothing is exempted by accident.

### Aggregierte Sichten

19. As an Entwickler, I want the already tenant-bearing materialized views (inventory value
    daily, db-per-product/slot monthly) to be read **through the door** as well, so that
    aggregates are isolated like base tables.

### Rollout & Live-Sicherheit

20. As a Betreiber, I want Stufe 3 rolled out **domain by domain**, so that the live
    dashboard the owners use daily keeps working throughout.
21. As an Eigentümer, I want each slice **verified live before the next**, so that I never
    lose access to my own data during the migration.
22. As an Entwickler, I want the **financial/GuV** reads tenant-scoped **first**, so that
    the most sensitive numbers are isolated earliest.

### Verifizierbarkeit

23. As an Entwickler, I want the whole stage verified against **two synthetic tenants**
    (`acme`, `globex`) via the #94 sandbox harness, so that isolation is tested against
    real, distinct tenants and not against a constant.
24. As an Entwickler, I want a per-read-path test asserting **"tenant A sees zero rows of
    tenant B"**, so that isolation is proven for each path, not assumed.
25. As a Betreiber, I want a final **live smoke** confirming the owners still see all their
    Faltrix data unchanged, so that completeness did not break legitimate access.

### Abgrenzung & Folgestufen

26. As a Betreiber, I want write protection (preventing **modifying** another tenant's
    data) explicitly deferred to **Stufe 4** directly after, so that the scope stays
    focused but the gap is closed before any second customer.
27. As a Sicherheitsverantwortlicher, I want it documented that app-level filters alone are
    **not** the final guarantee and that **RLS (Stufe 5)** is the unbypassable backstop
    coming without a gap, so that no second real customer onboards before Stufe 3+4+5.

### Härtung (No-Bypass, Aggregate, build-blocking)

28. As a Sicherheitsverantwortlicher, I want any direct database read **outside** the
    central door to be a hard violation flagged by the guard, so that no second, unguarded
    read path can re-emerge over time.
29. As a Sicherheitsverantwortlicher, I want aggregate reads
    (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`) to be tenant-scoped exactly like row reads, so that a
    leaked total is treated as the leak it is.
30. As an Entwickler, I want materialized views to be unusable as a bypass — either carrying
    `tenant_id` or read only through a tenant-filtering view/the door — so that aggregates
    cannot become a side door.
31. As an Entwickler, I want the guard to end up **build-blocking** (a new unfiltered or
    bypassing read fails CI), not merely warning, so that the protection cannot quietly
    erode after the migration.
32. As a Betreiber, I want scheduled/background reads (e.g. the alert mail, monitoring jobs)
    to run **per tenant** from an explicit tenant source rather than a viewer, and **never**
    fall back to a default, so that a background job never mails or surfaces another tenant's
    data.
33. As an Entwickler, I want the guard to enforce a **structural contract** (no DB access
    outside the door; every door call passes an explicit tenant + target table) instead of
    parsing arbitrary SQL, so that the completeness check is robust rather than a leaky
    parser.
34. As an Entwickler, I want each isolation test to be **non-vacuous** (the other tenant
    actually has rows the viewer must not see), so that a passing test proves isolation
    rather than emptiness.

## Implementation Decisions

### Grundprinzip

- Stufe 3 ändert **kein fachliches Verhalten** und **kein UI**. Sie ergänzt ausschließlich
  die Mandanten-Bindung der Lese-Pfade und macht damit die vorhandene Mandanten-Identität
  im Alltag wirksam.
- **Reiner Code, kein Schema-Change:** `tenant_id` existiert bereits auf allen operativen
  Tabellen (Stufe 0/1); Stufe 3 ist daher **reiner Code-Deploy ohne DDL** — kein
  „Migration-vor-Code" wie in Stufe 0–2, eine ganze Risiko- und Reihenfolge-Klasse entfällt.
- **Null-Toleranz-Prinzip:** An keiner Stelle dürfen fremde Mandanten-Daten sichtbar
  werden. Im Zweifel gilt **fail-closed** (kein Mandant ⇒ keine Daten), nie „im Zweifel
  zeigen".
- Begriffe (konsistent zu Stufe 2): **Mandant** = `tenant_id` (opaker String);
  **Viewer** = Ergebnis von `resolveViewer`; **effektiver Mandant** = `viewer.tenantId`
  (Heimat-Mandant, bei aktiver Support-Sitzung der Ziel-Mandant); **Mandanten-Tür** = der
  zentrale, mandanten-bewusste Datenzugriffs-Helfer dieser Stufe.

### Neues Deep Module: Mandanten-Tür

Ein in sich geschlossenes Modul kapselt den mandanten-gebundenen Lese-Zugriff hinter einer
kleinen, stabilen Schnittstelle. Es ist die **einzige** legitime Stelle, an der
mandanten-bezogene Tabellen gelesen werden.

- **Eingang:** Die Tür wird mit dem effektiven Mandanten eröffnet (aus dem Viewer
  abgeleitet). Ein **fehlender/leerer/null** Mandant führt **sofort** zu „verweigert"
  (Fehler/leeres Resultat, je nach Vertrag unten) — die Tür führt für einen tenant-losen
  Aufrufer **keine** mandanten-bezogene Abfrage aus.
- **Vertrag (bewusst ehrlich, keine Magie):** Die Tür **schreibt keine `WHERE`-Klauseln in
  fremdes SQL um**. Sie leistet dreierlei: (a) sie **erzwingt**, dass ein Mandant deklariert
  ist (fail-closed); (b) sie stellt den Mandanten-Wert den Abfragen **einheitlich** als
  Parameter bereit, sodass jede mandanten-bezogene Query ihren `tenant_id`-Filter trägt;
  (c) sie ist der **eine Kontrollpunkt**, gegen den der #107-Wächter prüfen kann. Die
  tatsächliche Filterung in Stufe 3 leisten die `tenant_id`-Prädikate in den Queries; die
  Vollständigkeit garantiert der Wächter.
- **Kein zweiter Pfad (No-Bypass-Invariante):** Eine Lese-Query darf **niemals** an der Tür
  vorbei ausgeführt werden. Direkte DB-Reads außerhalb der Tür (eigener `pg.Client`, eigenes
  `client.query`) sind **verboten** und werden vom #107-Wächter als Verstoß **markiert** —
  nicht bloß „bitte die Tür nutzen", sondern eine erzwungene Invariante. Sonst entsteht
  später wieder ein zweiter, ungesicherter Pfad.
- **Aggregationen sind Lese-Pfade:** Die Mandanten-Bindung gilt **genauso** für
  aggregierende Abfragen (`COUNT`/`SUM`/`AVG`/`MIN`/`MAX`). Ein `SELECT SUM(revenue) FROM
  sales` ohne Filter leckt exakt so viel wie `SELECT * FROM sales` — Summen über fremde
  Mandanten sind ein vollwertiges Datenleck. Die Tür und der Wächter behandeln aggregierende
  und zeilenliefernde Queries identisch.
- **DB-Zugriff zentralisiert:** Heute öffnet jedes Modul seine eigene `pg.Client`-
  Verbindung. Die Tür bündelt den Verbindungsaufbau an einer Stelle (vorzugsweise ein
  geteilter Pool, analog zur in Stufe 2 eingeführten Pool-gestützten Registry). Verbindungs-
  Timeouts und Fehler werden konsistent behandelt.
- **Stufe-5-Haken:** Die Tür ist der Ort, an dem in Stufe 5 zusätzlich die RLS-Sitzungs-
  variable (`SET LOCAL …current_tenant`) gesetzt wird. Ab dann sind die `tenant_id`-
  Prädikate Gürtel **und** Hosenträger; die DB weist fremde Zeilen selbst dann ab, wenn ein
  Prädikat fehlte. Stufe 3 baut den Haken, zündet ihn aber **nicht** (kein RLS in Stufe 3).

### Effektiver Mandant & Durchreichung

- Der effektive Mandant kommt aus dem **Viewer** (`viewer.tenantId`), der in Stufe 2 bereits
  korrekt aufgelöst wird (Heimat-Mandant bzw. bei aktiver Break-Glass-Sitzung der
  Ziel-Mandant). Stufe 3 fügt **keine** neue Mandanten-Auflösung hinzu — sie **konsumiert**
  den bestehenden Viewer.
- Die Lese-Funktionen erhalten den Mandanten (bzw. den Viewer) durchgereicht, statt ihn aus
  einer Konstante oder globalem Zustand zu ziehen. Das Durchreichen erfolgt vom Endpunkt
  (`getViewer`) bis in die Tür.

### Hintergrund-/zeitgesteuerte Lesepfade (kein Viewer)

- Nicht alle Lesepfade haben einen eingeloggten Viewer: **zeitgesteuerte/Hintergrund-Jobs**
  im Dashboard (z. B. die Alert-Mail `alert-digest.js`, Monitoring-Aggregationen) laufen
  ohne Request und damit ohne Viewer.
- **Regel:** Solche Reads brauchen eine **explizite Mandanten-Quelle** (z. B. eine Iteration
  über die aktiven Mandanten aus dem Verzeichnis) statt eines Viewers — und dürfen
  **niemals** auf einen Default-Mandanten zurückfallen. Die Tür verlangt auch hier zwingend
  einen Mandanten; ein Hintergrund-Job ohne gesetzten Mandanten bekommt **nichts**.
- Sobald es mehrere Mandanten gibt, laufen solche Jobs **pro Mandant** (z. B. eine
  Alert-Mail je Mandant), sonst verschickt ein Job fremde Warnungen — genau der im Audit
  markierte WF5-Fall. n8n-getriggerte Lese-/Schreibpfade (der Zweitschreiber) bleiben
  **Stufe 6**; hier geht es nur um die **dashboard-eigenen** Hintergrund-Jobs.

### Fehler- & Leerfall-Taxonomie (konsistent zu Stufe 2)

- **Kein Mandant gesetzt** (Gast/unzugeordnet) ⇒ **leeres Resultat / leeres Dashboard**.
  **Kein** Default-Mandant, **kein** `try/catch ⇒ alles zeigen`.
- **Technischer Fehler** (DB/Verbindung/Pool) in der Tür ⇒ **Fehler propagieren**
  (Endpunkt liefert den schon etablierten technischen Fehlercode, klar abgegrenzt von
  „legitim leer"). Ein Aussetzer darf nie als „keine Daten vorhanden" erscheinen.
- Diese Trennung („leer" ≠ „kaputt") ist dieselbe Linie wie die 404/503-Taxonomie aus
  Stufe 2.

### #107 Query-Filter-Contract-Guard

- **Zweck:** automatisch erkennen, ob eine mandanten-bezogene Tabelle **ohne**
  `tenant_id`-Bindung, als **Aggregat** (`SUM`/`COUNT`/…) ohne Filter, oder **an der Tür
  vorbei** (direkter DB-Read außerhalb der Tür) gelesen wird. Der Guard ist ein Test der
  bestehenden Suite (Prior Art: die vorhandenen Contract-/Invariant-Guards), kein
  Laufzeit-Hook.
- **Mechanismus — struktureller Vertrag, kein SQL-Parsing:** Der Wächter versucht **nicht**,
  beliebiges SQL semantisch zu verstehen (fragil bei zusammengebautem SQL, Joins,
  Aggregaten — ein löchriger Parser wäre eine Scheingarantie). Er erzwingt stattdessen einen
  **strukturellen** Vertrag: (a) **kein** direkter DB-Zugriff (`new pg.Client`/`client.query`)
  **außerhalb** der Tür (statisch/grep-bar geprüft); (b) **jeder** Tür-Aufruf übergibt
  **explizit** einen Mandanten **und** die Zieltabelle(n). Damit reduziert sich „vergessener
  Filter" auf „greift jemand an der Tür vorbei?" bzw. „fehlt der Mandant am Tür-Aufruf?" —
  beides robust und ohne SQL-Parser erkennbar.
- **Melde-Modus zuerst:** Der Guard inventarisiert alle Lesepfade und meldet die noch nicht
  abgesicherten — die vollständige Worklist für den häppchenweisen Rollout. In dieser Phase
  schlägt er **nicht** fehl, sondern berichtet (kein Big-Bang-Rot über alle 40 Module).
- **Bereichsweise scharf:** Pro abgeschlossenem Bereich wird der Guard für diesen Bereich
  auf **Default-Deny** umgestellt; die Ausnahmeliste der „noch nicht migriert"-Pfade
  **schrumpft** mit jedem Slice. Ein einmal abgesicherter Bereich kann nicht mehr
  unbemerkt zurückfallen.
- **Allowlist echt-globaler Tabellen (extrem eng):** Der Guard kennt eine **bewusste,
  dokumentierte, restriktive** Liste von Tabellen, die mandantenübergreifend sein **müssen**
  und daher **nicht** gefiltert werden. Default ist **mandantenpflichtig**; global ist die
  begründete Ausnahme, nicht die Regel. Aufnahmekriterium: **keinerlei kundenspezifische
  Information**.
  - **Global zulässig:** das Mandanten-Verzeichnis (`tenants`, `tenant_users`,
    `platform_admins`) — Auth-Infrastruktur, nur von der Verzeichnis-/Auth-Schicht gelesen,
    nie als Mandanten-Daten ausgespielt; reine Provider-/Dimensions-Lookups **ohne**
    Kundendaten; technische Referenztabellen **ohne** Kundendaten.
  - **NICHT global (mandantenpflichtig):** `machines`, `locations`/`location-profiles`,
    `settings`/`thresholds` (`settings_thresholds`), `nayax_devices` als
    **Geräte-Zuordnung** — und jede Tabelle mit kundenspezifischem Inhalt. Sobald
    kundenspezifische Information drinsteht, ist die Tabelle **nicht** global. Der einzige
    *eng begründete* Globalfall von `nayax_devices` ist die reine **Existenz-/Claiming-
    Eindeutigkeitsprüfung** (kein nutzersichtbarer Lesepfad; gehört zu Onboarding/Stufe 6) —
    jeder nutzersichtbare Geräte-Read ist tenant-gefiltert.
  - Jede Aufnahme in die Allowlist ist ein **bewusster, reviewter** Akt **mit Begründung**.
- **Endzustand — build-blocking, nicht nur warnend:** Der Wächter darf **nicht dauerhaft im
  Melde-Modus bleiben**. Nach dem letzten Slice ist er vollständig scharf; die einzige
  verbleibende Ausnahme ist die Global-Allowlist. Ab dann **bricht jeder neue ungefilterte
  oder an der Tür vorbei laufende Read den Build** (Suite/CI schlägt fehl) — ein neuer
  unsicherer Lesepfad kann nicht mehr gemerged werden. Der Melde-Modus ist ausschließlich
  ein **transienter** Zustand während des Rollouts.

### (Mat)Views als potenzieller Bypass

- (Mat)Views sind ein **potenzieller Umgehungspfad**: Wer eine MatView ungefiltert liest,
  umgeht die Tür genauso wie bei einer Basistabelle. **Regel:** Eine MatView muss **entweder
  `tenant_id` enthalten** (und wird dann wie eine Basistabelle gefiltert) **oder
  ausschließlich über eine tenant-filternde View bzw. die Tür** gelesen werden — **nie roh**.
- Konkret: Die in Stufe 1 mandanten-führend gemachten (Mat)Views (`mv_inventory_value_daily`,
  `mv_db_per_product_monthly`, `mv_db_per_slot_monthly`, `v_*`-Sichten aus #103/#106) werden
  **über die Tür** gelesen und tragen ihren `tenant_id`-Filter wie Basistabellen. Der
  Wächter behandelt sie wie tenant-pflichtige Relationen (kein Sonderfall „ist ja schon
  getrennt").

### Häppchen-Reihenfolge (je ein vertikaler Slice)

Jeder Slice: betroffene Lese-Queries durch die Tür führen + `tenant_id`-Filter ergänzen +
Test gegen `acme`/`globex` (A sieht 0 Zeilen von B) + Live-Verifikation am Mini + Guard für
diesen Bereich scharf schalten.

1. **Fundament:** Mandanten-Tür + Guard-Gerüst (Melde-Modus) + DB-Zugriff zentralisieren.
2. **Finanzen/GuV** (economics, economics-live, reports, GuV-Aggregate) — die heikelsten
   Zahlen zuerst.
3. **Übersicht/Cockpit/Monitoring** (cockpit, overview-monitoring, monitoring-view,
   automaten-view, alert-digest).
4. **Sortiment** (assortment-slots, slow-mover, product-catalog/-category, category-config).
5. **Bestand/MHD/Lager** (inventory-mhd, lager, stock-status, Lesepfade von
   write-off/refill/bulk-refill).
6. **Rest** (machine-profiles, location-profiles, nayax-abgleich/-devices-Lesepfade,
   correction-cases, wf3/4/5-product/stock-reads, onboarding-flow/-start, slot-editor,
   settings-thresholds).
7. **Abschluss:** Guard vollständig scharf + Schluss-Verifikation gegen `acme`/`globex` +
   Live-Smoke.

### Berührte Module/Teilsysteme

- **Neue Mandanten-Tür** (Deep Module, z. B. `lib/tenant-db.js`) — zentraler
  mandanten-gebundener Lese-Zugriff + gebündelter DB-Pool.
- **Die lesenden `lib/*`-Module** (~40, s. Reihenfolge oben) — Queries durch die Tür +
  `tenant_id`-Prädikate; Mandant/Viewer wird durchgereicht.
- **`server.js`** — reicht den effektiven Mandanten aus `getViewer` an die Lese-Pfade
  durch.
- **#107-Wächter** — neuer Contract-Guard-Test in der bestehenden Suite + dokumentierte
  Global-Allowlist.
- **`dashboard/tests/*`** — Isolations-Tests pro Bereich (Struktur wie `dashboard-mt-*`).

## Testing Decisions

- **Was einen guten Test ausmacht:** Nur **externes Verhalten** prüfen — das Ergebnis der
  Lese-Funktionen bzw. das HTTP-Verhalten der Endpunkte für einen gegebenen Viewer — nicht
  die internen Strukturen der Tür. Der Kerntest jedes Lesepfads lautet: **„Mandant A sieht
  0 Zeilen von Mandant B."**
- **Zwei synthetische Test-Mandanten** (`acme`, `globex`) werden über das Sandbox-Harness
  aus #94 angelegt und mit unterscheidbaren Daten **in allen für die Lesepfade relevanten
  Tabellen** befüllt (sonst sind Isolations-Tests **vakuös** — siehe Pflicht-Testfall 1);
  die echten Faltrix-Daten werden dabei nicht berührt (transaktional/ROLLBACK). Der Aufbau
  dieser beidseitigen Fixtures gehört in den **Fundament-Slice**.
- **Prior Art:** die bestehenden `dashboard/tests/dashboard-mt-0007…0019`-Tests, die
  Auth-/Tenant-Tests (`dashboard-tenant-directory.test.js`, `dashboard-auth-tenant-switch.test.js`)
  sowie die vorhandenen Contract-/Invariant-Guards (`dashboard-db-schema.test.js`,
  `dashboard-stock-cost-invariant.test.js`, `dashboard-produktart-contract.test.js`,
  `sql-date-format-guard.test.js`). Neue Tests fügen sich in dieselbe Struktur ein.
- **Harness/Runner:** `node:test` + `node:assert/strict`; Sandbox via
  `tests/helpers/migration-sandbox.js`; Tests skippen sauber offline (`connectOrSkip`).

Pflicht-Testfälle:

1. **Isolation je Bereich (nicht-vakuös):** Für jeden migrierten Lesepfad gilt
   **zweiseitig**: `globex` **hat** Zeilen in der gelesenen Relation (nicht-leer) **und** ein
   `acme`-Viewer sieht davon **0** (und umgekehrt). Ein „0 Zeilen"-Ergebnis zählt **nur**,
   wenn der andere Mandant dort wirklich Daten hat — sonst besteht der Test leer (falsche
   Sicherheit).
2. **Fail-closed ohne Mandant:** Ein Viewer **ohne** Mandant (Gast/unzugeordnet) erhält über
   jeden migrierten Lesepfad ein **leeres** Resultat — niemals Daten irgendeines Mandanten.
3. **Kein Default-Fallback:** Unter simuliertem „kein Mandant" erhält **kein** Aufrufer
   `t_faltrix`/`__default__` als Fallback (Anti-Regression gegen ein `catch ⇒ alles`).
4. **Technischer Fehler ≠ leer:** Ein simulierter Tür-/DB-Fehler propagiert als Fehler und
   ist klar von „legitim 0 Zeilen" unterscheidbar.
5. **Break-Glass-Lese-Scope:** Ein Plattform-Admin mit aktiver Support-Sitzung auf `acme`
   liest über die Lesepfade **`acme`-Daten** (read-only); ohne Override seinen
   Heimat-Mandanten.
6. **Globale Tabellen:** Lesezugriffe auf die Allowlist-Tabellen (Verzeichnis, Provider,
   `nayax_devices`) funktionieren mandantenübergreifend und werden vom Guard **nicht**
   angemeckert.
7. **Guard fängt Vergessenes:** Eine künstlich eingefügte mandanten-bezogene Query **ohne**
   Filter / an der Tür vorbei lässt den #107-Guard **fehlschlagen** (beweist, dass der
   Wächter wirkt).
8. **MatView-Isolation:** Lesepfade über die mandanten-führenden (Mat)Views liefern je
   Mandant nur dessen Aggregate.
9. **Owner-Regression:** Ein Faltrix-Eigentümer-Viewer sieht über jeden migrierten Lesepfad
   weiterhin **alle** seine Faltrix-Daten (Vollständigkeit bricht legitimen Zugriff nicht).
10. **Live-Smoke am Mini** (nach jedem Slice + final): Eigentümer-Zugriff auf das echte
    Dashboard liefert unverändert die Faltrix-Daten; keine leeren Ansichten, keine Fehler.
11. **Aggregat-Isolation:** Ein aggregierender Lesepfad (`SUM`/`COUNT`/…) liefert für einen
    `acme`-Viewer nur `acme`-Summen; `globex`-Zeilen fließen **nicht** in die Summe ein.
12. **No-Bypass-Erkennung:** Ein künstlich eingefügter direkter DB-Read an der Tür vorbei
    (eigener `pg.Client`) lässt den #107-Guard **fehlschlagen**.
13. **Build-blocking-Endzustand:** Nach Scharfschaltung lässt ein neuer ungefilterter Read
    die Suite **rot** werden (CI bricht), nicht nur eine Warnung.
14. **Hintergrund-Read ohne Default:** Ein zeitgesteuerter Lesepfad (Alert-/Monitoring-Job)
    ohne expliziten Mandanten erhält **nichts** (kein Default-Fallback); mit explizitem
    Mandanten nur dessen Daten.

## Out of Scope

Bewusst **nicht** Teil dieser Stufe (jeweils einer Folgestufe zugeordnet):

- **Schreib-/Objekt-Isolation an den übrigen Endpunkten** (verhindern, dass fremde Daten
  *verändert* werden) → **Stufe 4**, direkt im Anschluss, vor jedem zweiten realen Kunden.
  Stufe 3 sichert nur das **Sehen** ab; die zwei in Stufe 2 verdrahteten IDOR-Hooks bleiben
  unverändert.
- **Supabase Row-Level-Security (die unumgehbare DB-Garantie)** → **Stufe 5**. App-Filter
  allein sind für „null Toleranz" zu zerbrechlich; RLS ist der Backstop und kommt **ohne
  Lücke** danach. Stufe 3 baut nur den Tür-Haken dafür.
- **n8n-Lese-/Schreibpfade** (Zweitschreiber) → **Stufe 6**.
- **UI-Änderungen** (Mandanten-Selektor, Support-Bedien-UI) → **Stufe 8**. Stufe 3 ist rein
  serverseitig.
- **Multi-Instanz-Cache-Kohärenz** → erst nötig bei mehr als einer Dashboard-Instanz (heute
  genau eine).
- **Umzug der Rolle in die DB** (`tenant_users.role` autoritativ) → spätere
  Onboarding-Phase.
- **Plattform-weite Auswertungen** (mandantenübergreifende Betreiber-Sicht, z. B. „alle
  Mandanten gesamt") → späteres Betreiber-/Admin-UI. In Stufe 3 gibt es **keinen** legitimen
  mandantenübergreifenden Daten-Read (außerhalb der Global-Allowlist) — damit niemand eine
  ungefilterte Query „braucht".

**Wichtige Einordnung:** Stufe 3 macht das System **noch nicht** verkaufsfähig für einen
zweiten realen Kunden. Erst nach Stufe 3 (Lesen) **und** Stufe 4 (Schreiben) **und**
Stufe 5 (RLS) darf ein zweiter echter Kunde onboarden. Mit nur einem realen Mandanten
(Faltrix) leckt während des Umbaus nichts, weil keine zweiten echten Daten existieren.

## Further Notes

- **Warum eine Tür statt 40 Filter:** Eine zentrale, fail-closed Stelle ist die einzige
  Architektur, die „null Toleranz" trägt — ein vergessener Einzel-Filter unter 40 ist
  praktisch unvermeidbar, ein vergessener Durchgang an *einer* Tür ist vom Wächter trivial
  erkennbar.
- **Tür ≠ SQL-Magie:** Die Tür ersetzt nicht das Nachdenken über jede Query; sie macht
  „kein Mandant" unmöglich und „vergessener Filter" sichtbar. Die `tenant_id`-Prädikate
  bleiben in den Queries — bis Stufe 5 die DB-Garantie darüberlegt.
- **Reihenfolge ist Risiko-getrieben, nicht Wert-getrieben:** Alle Bereiche sind gleich
  kritisch (null Toleranz überall); Finanzen kommen nur deshalb zuerst, weil ihre Zahlen am
  sensibelsten wirken und der Slice die Tür/den Guard zuerst real erprobt.
- **Cache-Annahme:** unverändert genau eine Dashboard-Instanz (ein `homelab-dashboard`-
  Container auf dem Mini); die Tür braucht keinen eigenen Cache.
- **Projektregeln:** keine Klartext-Geheimnisse in Code/Tests; jeder Slice hält das
  Live-Dashboard funktionsfähig; nach Abschluss `HANDOVER.md`/`CLAUDE.md` aktualisieren und
  pushen; Kommunikation/Doku auf Deutsch.
- **Reviewer-Härtung eingearbeitet (5 Punkte):** (1) **No-Bypass** — kein Read an der Tür
  vorbei, vom Wächter markiert; (2) **Global-Allowlist extrem eng** — kundendaten-tragende
  Tabellen (`machines`, `locations`, `settings_thresholds`, `nayax_devices`-Zuordnung) sind
  mandantenpflichtig, nicht global; (3) **Aggregate** (`SUM`/`COUNT`/…) explizit
  eingeschlossen; (4) **(Mat)Views** als potenzieller Bypass behandelt; (5) Wächter im
  Endzustand **build-blocking** statt nur warnend.
- **Garantie-Ebene (ehrlich):** Die Stufe-3-Laufzeitsicherung ist der **Wächter im CI** (kein
  neuer ungesicherter Read kommt rein), **nicht** die Tür zur Laufzeit. Ein Leck, das am
  Wächter vorbeikäme, fängt erst **RLS (Stufe 5)** zur Laufzeit ab — bewusst akzeptierter
  Restrisiko-Korridor; ein zweiter realer Kunde erst nach Stufe 5.
- **`tenant_id`-Spalte vorausgesetzt:** Beim Migrieren jedes Lesepfads wird geprüft, dass die
  gelesene Relation überhaupt eine `tenant_id`-Spalte zum Filtern hat; fehlt sie (übersehene
  Tabelle/Sicht), ist das ein eigener Befund, kein „ist halt global".
- **Indizes = Performance, nicht Korrektheit:** `tenant_id`-Indizes sind ein Performance-Thema
  (heute mit einem Mandanten irrelevant), kein Leck-Thema — bei Bedarf später, kein
  Stufe-3-Blocker.
