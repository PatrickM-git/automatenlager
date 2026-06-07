# SPEC: Schreib-Isolation (Stufe 4) — mandantengetrennte Writes über Tür, Autorisierungs-Tor und Transaktion

> Stufe 4 der Mandantenfähigkeits-Migration. Schließt die in Stufe 3 bewusst offen
> gelassene Lücke: Nachdem **Lesen** mandantengetrennt ist, wird jetzt **Schreiben**
> (INSERT/UPDATE/DELETE/UPSERT) und jede **schreib-auslösende Autorisierung**
> mandantengetrennt — fail-closed und gegen zwei echte Test-Mandanten nachweisbar.
>
> Vorgänger: `docs/specs/multi-tenant-query-filter-stufe-3-v1.md` (Stufe 3, „Query-Filter").
> Landkarte: `docs/specs/mandantenfaehigkeit-audit-2026-06-05.md` (Schritt 4 der
> Migrationsreihenfolge 0→8). Memory: [[mandantenfaehigkeit-audit]].

## Problem Statement

Nach Stufe 3 ist das **Sehen** mandantengetrennt: jede DB-gestützte Lese-Abfrage läuft
durch die zentrale Mandanten-Tür (`lib/tenant-db.js`) und liefert nur Daten des eigenen
Mandanten. Das **Verändern** von Daten ist es **nicht**. Konkret und gegen den echten Code
verifiziert:

- **Direkte DB-Schreiber** öffnen weiter ihren eigenen rohen `pg`-Client und schreiben
  **ohne** Mandanten-Bindung: `write-off.js` (UPDATE auf `stock_batches`/`warnings`),
  `location-profiles.js` (UPSERT/DELETE auf `locations`), `machine-create.js`
  (UPSERT auf `machines`/`machine_profiles`, UPDATE `active`), `machine-profiles.js`
  (UPSERT auf `machine_profiles`), `settings-thresholds.js` (UPSERT/DELETE auf
  `settings_thresholds`). Diese Pfade stehen heute **bewusst** auf der Guard-Allowlist
  von Stufe 3 — als ausdrücklich nach Stufe 4 verschobene Schuld.
- **Schreib-auslösende Webhook-Endpunkte** reichen eine vom Client gelieferte Objekt-ID
  an n8n weiter, das dann produktiv schreibt. Nur **zwei** dieser Endpunkte prüfen heute,
  ob das Zielobjekt überhaupt dem Anfragenden gehört (*slot-change*, *nayax-apply* via
  `requireMachineAccess`). **Vier** prüfen es **nicht**: *refill/trigger*,
  *slot-assign-inline/confirm*, *correction-action/confirm*, *onboarding/start*. Über sie
  könnte ein Mandant per gefälschter `machine_id`/`case_id`/`product_key` eine Schreibung
  auf **fremden** Objekten auslösen.
- Die Mandanten-Tür hat zwar eine `write()`-Methode, aber sie leistet heute nur die
  Mandanten-Bindung als Parameter; sie ist **noch nicht** der erzwungene, einzige
  Schreib-Weg, und sie behandelt den tenant-losen Fall **still** (`{rowCount:0}`) statt
  als Fehler.
- Die Upsert-Konflikt-Ziele für `locations` (`ON CONFLICT (location_key)`) und `machines`
  (`ON CONFLICT (machine_key)` / `(machine_id)`) enthalten **kein** `tenant_id`. Bei zwei
  Mandanten würde ein gleicher Schlüssel als „dieselbe Zeile" gewertet — ein Mandant könnte
  beim Speichern die Zeile eines anderen **überschreiben**.

Der Schaden einer fehlenden Schreib-Isolation ist **kategorisch schlimmer** als beim Lesen:
Ein Lese-Leck verletzt Vertraulichkeit; ein mandantenübergreifender `UPDATE`/`DELETE`
**korrumpiert oder zerstört** fremde Daten (Integrität **und** Verfügbarkeit). Heute leckt
faktisch nichts, weil es nur **einen** realen Mandanten (Faltrix) gibt — aber das System ist
ohne Stufe 4 **nicht** verkaufsfähig für einen zweiten echten Kunden.

## Solution

Stufe 4 trennt die **Schreib-Pfade** sauber nach Mandant — als Sicherheits- und
Verkabelungs-Stufe, ohne neue fachliche Features und ohne UI-Änderung. Sie zieht dabei eine
architektonische Trennlinie, die zugleich die spätere Cloud-Migration vorbereitet.

1. **Architektur-Leitprinzip — zwei getrennte, cloud-agnostische Schichten:**
   **Autorisierung** („wem gehört das Objekt?") und **Datenzugriff** („schreibe in die DB")
   werden bewusst getrennt. Die Autorisierung wird in der Zielarchitektur zur Aufgabe der
   Backend-Schicht (perspektivisch Render statt n8n); der Datenzugriff wird zur
   Supabase-Schicht plus RLS (Stufe 5). Das Autorisierungs-Tor am Dashboard-Rand überlebt
   den n8n→Render-Wechsel **unverändert** — nur der Transport dahinter ändert sich. Stufe 4
   baut damit ausschließlich Arbeit, die in **jeder** Zukunft gebraucht wird.

2. **Schreiben nur durch die Mandanten-Tür:** Sämtliche direkten DB-Schreibungen laufen über
   `db.write()` bzw. den neuen transaktionalen Schreib-Modus der Tür. Direkte rohe
   `pg`-Schreibungen an der Tür vorbei sind verboten (No-Bypass) und werden vom #107-Wächter
   markiert. Die Tür ist **fail-closed**: ohne gesetzten Mandanten wird **nicht still
   nichts getan**, sondern ein **harter Fehler geworfen** — ein „erfolgreich gespeichert"
   ohne tatsächliche Schreibung ist ausgeschlossen.

3. **Transaktionaler Schreib-Modus (Prüfen + Schreiben atomar):** Viele Schreibungen sind
   eigentlich zwei Schritte — erst prüfen, ob ein Parent-Objekt (z. B. der Standort einer
   neuen Maschine) dem Mandanten gehört, dann schreiben. Die Tür bekommt einen
   transaktionalen Modus, der beide Schritte **auf einem Client in einer Transaktion**
   ausführt. Das schließt die Prüf-dann-Schreib-Lücke (TOCTOU) und deckt gleichzeitige
   Schreibungen sauber ab. Genau diese Transaktion ist der Steckplatz, an dem Stufe 5
   zusätzlich die RLS-Sitzungsvariable setzt — Stufe 5 wird dadurch „eine Zeile".

4. **Autorisierungs-Tor an allen schreib-auslösenden Endpunkten:** Jeder Endpunkt, der eine
   Schreibung auslöst (direkt **oder** per Webhook), prüft **vor** dem Auslösen, dass das
   adressierte Objekt dem Mandanten des Viewers gehört — über die **generische**
   Eigentums-Prüfung `requireObjectAccess` bzw. ihren Maschinen-Spezialfall
   `requireMachineAccess`. Der zu prüfende **Parent-Typ ist pro Endpunkt explizit
   festgelegt** (Parent-Matrix), damit nichts fälschlich über die Maschinenlogik gezogen
   wird. Fremd/unbekannt ⇒ 404 (kein Existenz-Leak) + Audit.

5. **Mandant kommt ausschließlich aus dem Viewer:** Ein vom Client geliefertes
   `tenant_id`/`mandant_id`-Feld im Request-Body wird **hart abgelehnt** (400 Bad Request)
   und **auditiert**. Der Mandant einer Schreibung wird **nie** aus dem Payload, sondern
   immer aus dem Viewer (`viewer.tenantId`) bestimmt — die zentrale
   Privilege-Escalation-Verteidigung.

6. **DDL vor Code (kleine, idempotente Migration):** Anders als Stufe 3 ist Stufe 4 **nicht**
   reiner Code. Die Upsert-Eindeutigkeit von `locations` und `machines` wird um `tenant_id`
   erweitert (`UNIQUE (tenant_id, <key>)`, Muster `NULLS NOT DISTINCT` analog
   `settings_thresholds`), mit idempotenten Vorab-Checks. Erst danach ist der dazugehörige
   Code (Upsert mit `tenant_id` im Konflikt-Ziel) korrekt.

7. **#107-Wächter auf Schreibpfade erweitert — strukturell, build-blocking:** Der bestehende
   Contract-Guard wird auf Schreibpfade ausgedehnt: kein rohes `pg` außerhalb der Tür, jeder
   Tür-Aufruf nennt Mandant + Zieltabelle. Er bleibt **strukturell** (kein SQL-Parsing). Die
   inhaltliche Korrektheit jeder Schreibung (trägt sie `tenant_id` im WHERE/INSERT/
   Konflikt-Ziel?) wird durch **nicht-vakuöse Isolationstests** bewiesen, nicht durch einen
   fragilen SQL-Parser — der wäre durch RLS (Stufe 5) ohnehin bald redundant. Im Endzustand
   ist der Wächter für Schreibpfade **build-blocking**.

8. **Häppchenweiser Rollout:** Fundament → DDL → Webhook-Tore (schneller Sicherheitsgewinn)
   → direkte Schreiber (einfach zuerst) → Scharfschaltung, jeweils mit nicht-vakuösem
   `acme`/`globex`-Isolationstest und Live-Verifikation, damit das produktiv genutzte
   Dashboard durchgehend funktioniert.

Ergebnis: Die Schreib-Isolation ist **flächendeckend** und gegen zwei echte, verschiedene
Test-Mandanten end-to-end verifizierbar. Die unumgehbare DB-Garantie (Stufe 5, RLS) bleibt
bewusst der Folgestufe vorbehalten und kommt **ohne Lücke** vor jedem zweiten realen Kunden.

## User Stories

### Schreib-Isolation (Kern)

1. As an Eigentümer, I want every write in the dashboard to affect only data of my own
   tenant, so that I can never create, change or delete another customer's data.
2. As a Sicherheitsverantwortlicher, I want a cross-tenant `UPDATE`/`DELETE` to be
   impossible, so that one customer can never corrupt or destroy another's data — a strictly
   worse failure than a read leak.
3. As a Betreiber, I want **all** direct DB writers (write-off, location-profiles,
   machine-create, machine-profiles, settings-thresholds) to write **through** the tenant
   door with a tenant binding, so that the write isolation is complete and not partial.
4. As an Entwickler, I want raw `pg` writes outside the door to be a hard violation flagged
   by the guard, so that no unguarded write path can re-emerge over time.

### Mandanten-Tür: Schreiben (Architektur)

5. As an Entwickler, I want all writes to go through the same central tenant-aware door as
   reads, so that the tenant binding is enforced in exactly one place.
6. As an Entwickler, I want the door to **throw** when a write is attempted without a tenant
   (fail-closed), so that an endpoint can never report "saved" while nothing was written.
7. As an Entwickler, I want the door to keep its read path fail-closed-**empty** while the
   write path fail-closed-**throws**, so that "nothing to show" and "refused to write" stay
   clearly distinct.
8. As a Betreiber, I want a technical failure during a write to surface as an error, not as a
   silent no-op, so that an outage is distinguishable from a legitimate no-change.

### Transaktionaler Schreib-Modus

9. As an Entwickler, I want a transactional write mode that performs the parent-ownership
   check and the write **atomically on one client**, so that there is no time window between
   check and write (no TOCTOU).
10. As a Sicherheitsverantwortlicher, I want two concurrent writes to the same resource to
    never produce cross-tenant corruption, so that races cannot bypass isolation.
11. As an Entwickler, I want the transaction to be the exact place where Stufe 5 will set the
    RLS session variable, so that the database backstop can be added later without touching
    the write paths again.

### Autorisierungs-Tor & Parent-Matrix

12. As an Eigentümer, I want every write-triggering endpoint to verify that the addressed
    object belongs to my tenant **before** triggering, so that a forged id cannot act on a
    foreign object.
13. As a Sicherheitsverantwortlicher, I want the four currently unguarded webhook endpoints
    (refill, slot-assign-inline, correction-action, onboarding) to get an authorization gate
    in Stufe 4, so that the gap is closed even though the actual DB write stays Stufe 6/n8n.
14. As an Entwickler, I want the parent type of each endpoint to be **explicit** (machine via
    registry; correction case via `correction_cases.tenant_id`; product/catalog via
    `products.tenant_id`), so that onboarding and correction are not wrongly forced through
    machine logic.
15. As a Plattform-Admin, I want the authorization gate to live in a layer that survives the
    n8n→Render migration unchanged, so that future cloud work does not reopen the gap.

### Mandant-Herkunft (Privilege-Escalation-Schutz)

16. As a Sicherheitsverantwortlicher, I want a client-supplied `tenant_id`/`mandant_id` in
    the request body to be **hard-rejected** (400) and **audited**, so that a manipulation
    attempt is loud and visible.
17. As an Entwickler, I want the tenant of a write to always come from the viewer and never
    from the payload, so that no caller can write as another tenant.

### DDL & Upsert-Korrektheit

18. As an Entwickler, I want `locations` and `machines` unique constraints to include
    `tenant_id` (`NULLS NOT DISTINCT`), so that the same key can exist per tenant and an
    upsert can never overwrite a foreign tenant's row.
19. As a Betreiber, I want the DDL migration to be idempotent with pre-checks (tenant_id
    populated + `NOT NULL`; `ON CONFLICT` target moved in lockstep), so that the rollout
    cannot fail on legacy data or break upserts.
20. As an Entwickler, I want the DDL applied **before** the dependent code, so that the
    upsert referencing the new constraint is always valid.

### Break-Glass (Schreib-Sperre bestätigt)

21. As a Sicherheitsverantwortlicher, I want a write under an active break-glass support
    session to stay **blocked** (403, read-only) for the new write endpoints too, so that
    support can never modify a customer's data.

### Wächter (build-blocking, strukturell)

22. As a Sicherheitsverantwortlicher, I want the #107 guard extended to write paths so a
    forgotten raw write fails the suite, so that protection cannot erode after the migration.
23. As an Entwickler, I want the write guard to stay **structural** (no SQL parsing), so that
    the completeness check is robust rather than a leaky parser, with RLS (Stufe 5) as the
    real runtime backstop.

### Rollout & Verifizierbarkeit

24. As a Betreiber, I want Stufe 4 rolled out **slice by slice** with the webhook gates done
    early as a quick security win, so that the live dashboard keeps working and the biggest
    open gap closes first.
25. As an Entwickler, I want each write path verified against **two synthetic tenants**
    (`acme`, `globex`) with a **non-vacuous** test (the other tenant actually has rows), so
    that isolation is proven per path, not assumed.
26. As an Eigentümer, I want a final live smoke confirming I can still write everything I
    could before (locations, machines, thresholds, write-offs), so that completeness did not
    break legitimate writes.

### Abgrenzung & Folgestufen

27. As a Sicherheitsverantwortlicher, I want it documented that app-level write guards alone
    are **not** the final guarantee and that **RLS (Stufe 5)** is the unbypassable backstop
    coming without a gap, so that no second real customer onboards before Stufe 3+4+5.

## Implementation Decisions

### Grundprinzip

- Stufe 4 ändert **kein fachliches Verhalten** und **kein UI**. Sie ergänzt ausschließlich
  die Mandanten-Bindung und Objekt-Autorisierung der Schreib-Pfade.
- **Nicht reiner Code (anders als Stufe 3):** Stufe 4 enthält eine kleine, klar abgegrenzte,
  idempotente DDL-Migration, die **vor** dem abhängigen Code läuft (wie in Stufe 0–2).
- **Null-Toleranz-Prinzip:** An keiner Stelle darf eine Schreibung fremde Mandanten-Daten
  anlegen, ändern oder löschen. Im Zweifel **fail-closed** — beim Schreiben heißt das:
  **Fehler werfen**, nicht still nichts tun.
- Begriffe (konsistent zu Stufe 2/3): **Mandant** = `tenant_id`; **Viewer** = Ergebnis von
  `resolveViewer`; **effektiver Mandant** = `viewer.tenantId`; **Mandanten-Tür** = der
  zentrale Datenzugriffs-Helfer; **Autorisierungs-Tor** = `requireObjectAccess` /
  `requireMachineAccess`.

### Mandanten-Tür: Schreib-Erweiterung (`lib/tenant-db.js`)

- **`write()` wird fail-closed-werfend:** Der heutige stille tenant-lose Rückgabewert
  (`{rowCount:0, tenantless:true}`) wird durch einen geworfenen Fehler ersetzt. Der Lese-Pfad
  (`read()`) bleibt unverändert fail-closed-**leer**. Damit gilt: „leer" ist ein gültiges
  Lese-Ergebnis, „kein Mandant beim Schreiben" ist ein Fehler.
- **Transaktionaler Schreib-Modus:** Die Tür erhält einen Modus, der einen Mandanten-Wert
  bindet, einen Client aus dem geteilten Pool nimmt, eine Transaktion öffnet, dem Aufrufer
  eine **tür-gebundene** Schnittstelle (Lesen **und** Schreiben innerhalb derselben
  Transaktion) übergibt und am Ende committet bzw. bei Fehler zurückrollt. Parent-Prüfung und
  Schreibung laufen darin atomar. Dies ist der vorbereitete (in Stufe 4 **inerte**) Ort für
  den Stufe-5-RLS-Haken (`SET LOCAL automatenlager.current_tenant`).
- **Mandant einheitlich als `$1`:** Wie beim Lesen wird der Mandant als erster
  Positions-Parameter vorangestellt; eigene Parameter folgen ab `$2`. INSERT setzt
  `tenant_id = $1`; UPDATE/DELETE tragen `WHERE tenant_id = $1 AND …`; UPSERT trägt
  `tenant_id` im Konflikt-Ziel.

### Autorisierungs-Tor & Parent-Matrix

Die generische Eigentums-Prüfung `requireObjectAccess(viewer, objectTenantId, res, event)`
existiert bereits; `requireMachineAccess` ist ihr Maschinen-Spezialfall (löst
`machine → tenant` über die Stufe-2-Registry auf). Stufe 4 verkabelt **pro Endpunkt** den
korrekten Parent-Typ:

| Endpunkt | Parent | Auflösung → Mandant | Prüfung |
|---|---|---|---|
| `slot-change/confirm` | `machine_id` | Registry | `requireMachineAccess` (bereits vorhanden) |
| `nayax-abgleich/apply` | `machine_id` | Registry | `requireMachineAccess` (bereits vorhanden) |
| `refill/trigger` | `machine_id` | Registry | `requireMachineAccess` (**neu**) |
| `slot-assign-inline/confirm` | `machine_id` (+ Slot/Produkt) | Registry | `requireMachineAccess` (**neu**) |
| `correction-action/confirm` | `case_id` | `correction_cases.tenant_id` | `requireObjectAccess` (**neu**, nicht Maschine) |
| `onboarding/start` | `product_key` | `products.tenant_id` / Katalog-Kontext | `requireObjectAccess` (**neu**, nicht Maschine) |

- **Webhook-Klasse:** Der eigentliche DB-Write dieser sechs Endpunkte bleibt Stufe 6 (n8n).
  Stufe 4 liefert die **Autorisierung** — die einzige Verteidigung, die diese Endpunkte vor
  Stufe 6 bekommen können. Diese Schicht überlebt den n8n→Render-Wechsel unverändert.
- **Fremd/unbekannt ⇒ 404** (kein Existenz-Leak) + Audit, konsistent zur bestehenden
  IDOR-Taxonomie aus Stufe 2.

### Mandant-Herkunft: `tenant_id` im Body verboten

- Eine zentrale Eingangs-Prüfung an den schreibenden Endpunkten lehnt jeden Request-Body mit
  `tenant_id`/`mandant_id` mit **400 Bad Request** ab und schreibt einen Audit-Eintrag. Ein
  Client hat nie einen legitimen Grund, den Mandanten zu schicken; jedes Vorkommen ist Bug
  oder Angriff.

### Direkte DB-Schreiber (Klasse 1) — durch die Tür

- `write-off.js` → `stock_batches`, `warnings` (UPDATE): Parent `batch_key`; UPDATE trägt
  `tenant_id = $1`; betroffene Warnungen werden mandanten-gebunden aufgelöst.
- `location-profiles.js` → `locations` (UPSERT/DELETE): UPSERT mit neuem
  `(tenant_id, location_key)`-Konflikt-Ziel; DELETE mit `WHERE tenant_id = $1`.
- `machine-create.js` → `machines`, `machine_profiles` (UPSERT, UPDATE `active`): Parent
  `location_id` wird **in der Transaktion** auf Mandanten-Eigentum geprüft; UPSERT-Ziel um
  `tenant_id` erweitert.
- `machine-profiles.js` → `machine_profiles` (UPSERT): Parent `machine_id`; mandanten-gebunden.
- `settings-thresholds.js` → `settings_thresholds` (UPSERT/DELETE): Constraint
  `UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id, key)` ist **bereits** sauber und dient
  als Vorbild für die DDL der anderen Tabellen; die rohen `client.query`-Aufrufe werden auf
  die Tür umgestellt.

### DDL-Migration (Slice 1, vor Code)

- Neue Unique-Constraints `UNIQUE NULLS NOT DISTINCT (tenant_id, <key>)` auf `locations`
  (`location_key`) und `machines` (`machine_key`; zusätzlich `machine_profiles.machine_id`
  prüfen). Idempotent (existenz-geprüft).
- **Vorab-Checks (idempotente Guards):**
  1. **`tenant_id` befüllt + `NOT NULL`** (Backfill auf `__default__`), sonst kollabieren
     NULLs unsauber. Dies ist der Check, der tatsächlich beißt.
  2. **`ON CONFLICT`-Ziel im Code wandert im selben Schritt mit** (vom alten Schlüssel auf
     den neuen Constraint), sonst wirft der Upsert „no unique constraint matching ON CONFLICT".
  3. **Duplikat-Prüfung** als Gürtel-und-Hosenträger (das Erweitern ist formal eine
     Lockerung; Altdaten können den neuen Constraint nicht verletzen, der Check schadet aber
     nicht).

### #107-Wächter: Schreibpfad-Erweiterung

- Der bestehende strukturelle Guard (`lib/query-filter-guard.js`) wird auf Schreibungen
  ausgedehnt: kein rohes `pg` (`new Client`/`client.query`/…) außerhalb der Tür auch für
  Writes; jeder Schreib-Tür-Aufruf nennt Mandant + Zieltabelle.
- **Kein SQL-Parser.** Die inhaltliche Korrektheit beweisen die Isolationstests; RLS (Stufe
  5) ist der Laufzeit-Backstop.
- **Rollout über schrumpfende Allowlist:** Die heute auf der Allowlist stehenden rohen
  Schreib-Module werden Slice für Slice entfernt; im Endzustand ist der Guard für
  Schreibpfade **build-blocking**.

### Rollout-Reihenfolge (risikogetrieben)

- **Slice 0 — Fundament:** `db.write()` wirft fail-closed; transaktionaler Schreib-Modus
  `db.tx`; Eingangs-Prüfung „`tenant_id` im Body → 400 + Audit"; Wächter auf Schreibpfade
  erweitern (Melde-Modus); beidseitige `acme`/`globex`-**Schreib**-Fixtures.
- **Slice 1 — DDL:** Unique-Constraints `locations` + `machines` (idempotent, vor Code, mit
  Vorab-Checks).
- **Slice 2 — Webhook-Tore:** `requireMachineAccess`/`requireObjectAccess` auf die vier
  offenen Endpunkte (reine Autorisierung, kein DB-Umbau, schneller Sicherheitsgewinn).
- **Slice 3 — direkte Schreiber (einfach→komplex):** location-profiles →
  machine-create/machine-profiles (Parent `location_id` in der Transaktion) →
  settings-thresholds → write-off.
- **Slice 4 — Abschluss:** Wächter build-blocking für Schreibpfade; Stufe-5-Haken
  vorbereitet (inert); voller Isolationstest-Durchlauf; Live-Smoke am Mini; HANDOVER.

### Cloud-Migration (Vorbereitung, nicht Umsetzung)

- Die Trennung „Autorisierung vs. Datenzugriff" bildet die spätere Drei-Schichten-Architektur
  ab (Cloudflare Frontend / Render Backend-Workflows statt n8n / Supabase Datenbank). Der
  transaktionale Schreib-Modus ist der fertige Steckplatz für Supabase-RLS. Es wird in Stufe
  4 **kein** Cloud-Code geschrieben — nur cloud-agnostisch (Transaktionen identisch auf
  Mini-PostgreSQL und Supabase) gebaut, sodass keine spätere Bruch- oder Doppelarbeit entsteht.

## Testing Decisions

- **Was einen guten Test ausmacht:** Nur **externes Verhalten** prüfen — das Ergebnis der
  Schreib-Funktionen bzw. das HTTP-Verhalten der Endpunkte für einen gegebenen Viewer — nicht
  die internen Strukturen der Tür. Jeder Isolationstest ist **nicht-vakuös**: der andere
  Mandant hat in der betroffenen Relation wirklich Zeilen, die der Viewer nicht anfassen darf.
- **Zwei synthetische Test-Mandanten** (`acme`, `globex`) über das #94-Sandbox-Harness
  (`tests/helpers/migration-sandbox.js` + `tenant-fixtures.js`), transaktional mit ROLLBACK,
  Advisory-Lock gegen DDL-vs-DML-Deadlock; offline sauberes Skippen via `connectOrSkip`. Die
  beidseitigen **Schreib**-Fixtures gehören in den Fundament-Slice.
- **Prior Art:** die bestehenden `dashboard-mt-*`-Tests, die Stufe-3-Isolationstests pro
  Domäne, die Auth-/Tenant-Tests sowie die Contract-/Invariant-Guards
  (`dashboard-query-filter-guard.test.js`, `dashboard-stock-cost-invariant.test.js`).
- **Harness/Runner:** `node:test` + `node:assert/strict`.

Pflicht-Testfälle (je Schreibpfad, soweit zutreffend):

1. **Fremde Parent-ID ⇒ abgewiesen:** Ein `acme`-Viewer, der mit `location_id`/`case_id`/
   `machine_id`/`product_key` von `globex` schreibt, wird mit **404** abgewiesen; es entsteht
   **keine** Änderung an `globex`-Daten.
2. **`tenant_id` im Body ⇒ 400 + Audit:** Ein Schreib-Request mit `tenant_id`/`mandant_id`
   im Body wird mit **400** abgelehnt und auditiert.
3. **Read-after-write:** `acme` schreibt → `acme` sieht die Änderung → `globex` sieht sie
   **nicht** (und umgekehrt).
4. **Side-Effects-Isolation:** Eine Schreibung an einer `acme`-Maschine erzeugt **keine**
   Alerts/Jobs/Warnungen/Logs für `globex` (besonders `settings-thresholds`).
5. **Concurrent Writes:** Zwei Mandanten schreiben gleichzeitig dieselbe logische Ressource
   (gleicher `location_key`/`machine_key`); es entsteht **keine** Cross-Tenant-Korruption,
   der ON-CONFLICT-Pfad bleibt pro Mandant getrennt.
6. **Fail-closed ohne Mandant:** Eine Schreibung ohne gesetzten Mandanten **wirft** (kein
   stilles `rowCount:0`); der Endpunkt liefert einen klaren Fehlercode, kein „gespeichert".
7. **Owner-Regression:** Ein Faltrix-Eigentümer-Viewer kann über jeden migrierten Schreibpfad
   weiterhin **alles** schreiben wie bisher (Vollständigkeit bricht legitimes Schreiben nicht).
8. **Break-Glass-Schreib-Sperre:** Ein Plattform-Admin mit aktiver Support-Sitzung wird an
   jedem neuen Schreib-Endpunkt mit **403** (`SUPPORT_SESSION_READ_ONLY`) geblockt + Audit
   `break_glass_write_blocked` (bestätigt die schon in Stufe 2 gebaute Sperre).
9. **Wächter fängt Vergessenes:** Ein künstlich eingefügter roher Write an der Tür vorbei
   lässt den #107-Guard **fehlschlagen** (beweist die Wirksamkeit).
10. **Build-blocking-Endzustand:** Nach Scharfschaltung lässt ein neuer ungesicherter Write
    die Suite **rot** werden (CI bricht), nicht nur eine Warnung.
11. **DDL-Idempotenz & Upsert-Korrektheit:** Die Migration läuft mehrfach ohne Fehler; nach
    der Constraint-Umstellung funktioniert der Upsert (kein „no unique constraint matching
    ON CONFLICT").
12. **Live-Smoke am Mini** (nach jedem Slice + final): Eigentümer-Schreibungen am echten
    Dashboard funktionieren unverändert; keine falschen „gespeichert", keine Fehler.

## Out of Scope

Bewusst **nicht** Teil dieser Stufe (jeweils einer Folgestufe zugeordnet):

- **Supabase Row-Level-Security (die unumgehbare DB-Garantie)** → **Stufe 5**. App-Guards
  allein sind für „null Toleranz" zu zerbrechlich; RLS ist der Backstop und kommt **ohne
  Lücke** danach. Stufe 4 baut nur den Tür-/Transaktions-Haken dafür (inert).
- **n8n-eigene Schreibpfade** (der Zweitschreiber hinter den Webhooks) → **Stufe 6**. Stufe 4
  sichert nur die **Autorisierung** am Dashboard-Rand, nicht die Schreibung in n8n.
- **Per-Mandant-Config** (`classification_settings`) bleibt unter `__default__` gekeyt →
  **Stufe 6** (`mandant_id`→`tenant_id`).
- **UI-Änderungen** (Mandanten-Selektor, Support-Bedien-UI) → **Stufe 8**. Stufe 4 ist rein
  serverseitig.
- **`POST /api/config`** (schreibt eine Konfig-Datei, kein DB/Mandant) bleibt außerhalb.
- **Tatsächlicher Cloud-Umzug** (Cloudflare/Render/Supabase, Capacitor-App,
  Push-Benachrichtigungen) → spätere, eigene Phasen. Stufe 4 bereitet nur cloud-agnostisch vor.

**Wichtige Einordnung:** Stufe 4 macht das System **noch nicht** verkaufsfähig für einen
zweiten realen Kunden. Erst nach Stufe 3 (Lesen) **und** Stufe 4 (Schreiben) **und** Stufe 5
(RLS) darf ein zweiter echter Kunde onboarden. Mit nur einem realen Mandanten (Faltrix) leckt
während des Umbaus nichts.

## Further Notes

- **Warum Schreiben strenger als Lesen:** Ein Lese-Leck verletzt Vertraulichkeit; ein
  mandantenübergreifender Schreibvorgang verletzt Integrität **und** Verfügbarkeit. Daher
  beim Schreiben **werfen** statt still leer, und Parent-Prüfung **atomar** statt lose.
- **Warum die Webhook-Tore trotz „n8n = Stufe 6" jetzt kommen:** Die Autorisierung ist eine
  von der Schreibung getrennte Schicht. Sie gehört an den Dashboard-Rand (künftig Render) und
  überlebt den n8n→Render-Wechsel unverändert. Sie jetzt zu bauen ist Arbeit, die in jeder
  Zukunft gebraucht wird — die Alternative wäre, vier offene Türen bis Stufe 6 stehen zu
  lassen.
- **Garantie-Ebene (ehrlich):** Die Stufe-4-Laufzeitsicherung ist die Tür + das
  Autorisierungs-Tor + der Wächter im CI — **nicht** ein SQL-prüfender Parser. Ein Leck, das
  am Wächter vorbeikäme, fängt erst **RLS (Stufe 5)** zur Laufzeit ab — bewusst akzeptierter
  Restrisiko-Korridor; ein zweiter realer Kunde erst nach Stufe 5.
- **Korrektur zum ersten Planungsdurchlauf:** Der ursprüngliche grill-me (mit einem
  schwächeren Modell) ging von „4 Modulen, reiner Code wie Stufe 3" aus. Die Code-Analyse
  zeigt: Stufe 4 enthält **DDL** und umfasst eine **übersehene Klasse** (`write-off` + sechs
  schreib-auslösende Webhook-Endpunkte, von denen vier ungeschützt sind). Diese SPEC basiert
  auf der echten Code-Analyse (`server.js`, `lib/tenant-db.js`, `lib/*.js`,
  `query-filter-guard.js`, `auth.js`).
- **Projektregeln:** keine Klartext-Geheimnisse in Code/Tests; jeder Slice hält das
  Live-Dashboard funktionsfähig; produktive n8n-Arbeit immer gegen die **HP-Mini**-Instanz
  (nie localhost); `HANDOVER.md` vor Überschreiben archivieren; Kommunikation/Doku auf
  Deutsch; Workflow-JSON UTF-8.
