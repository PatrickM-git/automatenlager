# SPEC: Multi-Tenant-Datenmodell (Stufe 0) — Fundament für Mandanten, Standorte & Lager

**Status:** Entwurf, umsetzungsreif
**Erstellt:** 2026-06-05
**Bereich:** Datenmodell / PostgreSQL-Schema `automatenlager` (Repo `github.com/PatrickM-git/automatenlager`, Live-Klon `C:\Users\patri\Documents\mein-erstes-Projekt`)
**Bezug:** Stufe **0** aus `docs/specs/mandantenfaehigkeit-audit-2026-06-05.md` (Multi-Agenten-Audit, ~15 % Multi-Tenant-Readiness). Vorbild-Muster: `classification_settings` / `settings_thresholds`. Glossar: `docs/UBIQUITOUS_LANGUAGE.md`.
**Zielstack später:** PostgreSQL/Supabase mit Row-Level-Security (RLS) als Mandanten-Primitive. Diese SPEC legt das **Fundament** (Schema), vollzieht das Scharfschalten aber **nicht**.
**Abgrenzung:** Reine Daten-/Schema-Entscheidung (Stufe 0) + der Schema-Bauplan für die Migration (Stufe 1). **Kein** Code-Scharfschalten (Auth, Query-Filter, RLS-Policies, IDOR, n8n-Ablösung, Credential-Vault, Frontend) — das sind die Folgestufen 2–8 des Audits.

---

## Problem Statement

Das Automatenlager-System ist heute faktisch **Single-Tenant** und in diesem Zustand nicht an fremde Automaten-Betreiber verkaufbar — jeder Verkauf wäre ein garantiertes, mehrschichtiges Datenleck. Konkret und belegt (siehe Audit):

- **Der Mandant ist eine Konstante, kein Datum.** `tenantId` ist in `resolveViewer` (`dashboard/lib/auth.js:140`) auf `'eigentuemer'` hartcodiert, und `machineTenant()` (`dashboard/server.js:243-245`) ist ein Stub, der immer denselben Mandanten zurückgibt. Die kluge RBAC-/IDOR-Architektur läuft dadurch **im Leerlauf**: jeder Viewer trägt denselben Mandanten, jedes Objekt „gehört" demselben Mandanten.
- **18 von 20 operativen Tabellen haben keine `tenant_id`-Spalte.** Betroffen sind genau die finanz- und betriebssensibelsten Tabellen: `machines`, `locations`, `slot_assignments`, `stock_batches`, `prices`, `products`, `sales_transactions`, `guv_daily`, `warnings`, `invoices`, u. a. Ohne diese Spalte **in der Relation selbst** ist Supabase-RLS unmöglich (RLS filtert auf Spalten, nicht auf JOINs), und jede Wirtschafts-, Verkaufs- und Bestands-Query liest ungefiltert über **alle** Zeilen aller Kunden.
- **Es gibt kein Mandanten-Verzeichnis und keine Nutzer-Zuordnung.** Wer Admin ist, entscheidet heute eine Env-Var-Liste — das reicht für genau eine Firma. Es existiert keine Tabelle, die sagt „dieser Login gehört zu diesem Betrieb mit dieser Rolle". Damit lässt sich weder „ein Betrieb mit zwei Eigentümern" noch „viele getrennte Betreiber" abbilden.
- **„Mehrere Lager" existieren gar nicht.** Bestand kennt heute nur zwei Aufenthaltsorte: *im Automaten* (`stock_batches.machine_id`) oder *im Zentrallager* (`machine_id = NULL`, ein einziges namenloses „irgendwo"). Ein benennbares, getrennt auswertbares Lager als eigene Sache fehlt.
- **Die Trigger vererben keinen Mandanten.** `fn_deduct_stock_on_machine_sale` (Migration `0003`) und `fn_update_price_from_sale` (Migration `0005`) schreiben in `stock_batches`/`prices` ohne Mandanten-Kontext — beim Einbau von `tenant_id` würden sonst NULL-/Falsch-Tenant-Zeilen entstehen.

Eine falsche Entscheidung auf dieser Ebene (z. B. „Produkte sind geteilt") müsste später über *alle* Tabellen zurückgedreht werden. Deshalb ist Stufe 0 eine reine, gründliche **Entscheidungs- und Bauplan-Stufe**, bevor die erste DDL läuft.

Zusätzlich gilt eine **harte Produkt-Vorgabe des Eigentümers:** Das Modell muss intern beliebig komplex sein dürfen, aber ein Mandant mit nur **einem** Standort und **einem** Lager darf von der gesamten Mehrmandanten-Maschinerie **nichts** merken. Komplexität nur unter der Haube, nie an der Oberfläche des Einfach-Falls.

## Solution

Ein **einziges, durchgängiges Isolations-Primitiv** plus drei neue Strukturtabellen, die das Fundament für Mandanten, Standorte und Lager legen — gebaut als reiner Schema-Bauplan, RLS-fertig, ohne den laufenden Betrieb zu gefährden.

1. **Eine Regel statt Sonderfällen: alles trägt `tenant_id`.** Jede operative Tabelle bekommt eine `tenant_id`-Spalte (`TEXT NOT NULL`), die **denormalisiert** auf jede Zeile gestempelt wird — damit RLS und Query-Filter auf **jeder** Relation direkt greifen, ohne Umweg über JOINs. Es gibt **keine geteilten Zeilen** und **keine Ausnahmen**. Das ist gleichzeitig das einfachste *und* das sicherste Modell: „filtere nach `tenant_id` — fertig."

2. **Stammdaten gehören dem Mandanten (Variante „eigener Katalog").** Produkte, Produkt-Aliase, Lieferanten und Preise gehören je genau **einem** Mandanten. Kein geteilter Live-Katalog. Begründung: Konkurrenten müssen absolut getrennt sein; Einkaufspreise und Lieferanten sind ohnehin privat; und ein geteilter, veränderbarer Stammsatz würde die Mandanten wieder aneinanderkoppeln (A's Änderung träfe B). Die Duplikat-Sorge fängt später ein **optionaler, schreibgeschützter Referenz-Katalog** ab (Copy-on-Onboard) — bewusst nicht Teil der Live-Tabellen.

3. **Drei neue Strukturtabellen.**
   - **`tenants`** — das Mandanten-Verzeichnis: jeder Betrieb steht einmal da, mit unveränderlicher technischer ID, änderbarem Namen, Status und Kontakt-/Alarm-Adresse.
   - **`tenant_users`** — Mitgliedschaften: welcher Login zu welchem Mandanten mit welcher **Rolle** (Eigentümer/Auffüller/Gast) gehört. Trägt „ein Betrieb, zwei Eigentümer" als zwei Zeilen.
   - **`warehouses`** (Lager) — ein benennbares Lager, das dem Mandanten gehört, optional an einen Standort hängbar. Jeder Mandant startet automatisch mit genau einem „Zentrallager".

4. **Lager als echter Ort jeder Charge.** `stock_batches` bekommt eine `warehouse_id`. Eine Charge liegt künftig **entweder** in einem Automaten (`machine_id`) **oder** in einem Lager (`warehouse_id`). Das heutige „`machine_id = NULL` = Zentrallager" wird beim Backfill zu „`warehouse_id` zeigt aufs Zentrallager". Daraus fallen **Gesamt-Kurzansicht** (Summe über alle Lager) und **Drill-down pro Lager** von selbst heraus — ohne Extra-Daten.

5. **Standorte gehören dem Mandanten.** `locations` bekommt `tenant_id`; ein Automat hängt an genau einem Standort; Standorte werden **nie** über Mandanten geteilt (gleiches Gebäude, zwei Betreiber = zwei getrennte Einträge). Der reale Fall „Lager direkt am Automaten-Standort" wird über die optionale `warehouse.location_id`-Zuordnung abgebildet.

6. **Der laufende Betrieb bleibt heil (Brücken-Trigger).** Damit bestehende Schreibpfade (n8n) bis zu ihrer Ablösung in Stufe 6 nicht brechen, füllt ein **`BEFORE INSERT`-Trigger** `tenant_id` automatisch aus dem referenzierten Eltern-Datensatz (z. B. Verkauf → Automat, Charge → Slot), wenn der Schreiber sie nicht selbst mitliefert. Dieser Trigger erfüllt gleichzeitig die im Audit geforderte **Mandanten-Vererbung** und ist die Brücke für den Einfach-/Single-Tenant-Betrieb.

7. **Support-Notfall-Schlüssel wird ermöglicht, nicht verbaut.** Im Datenmodell bleibt `tenant_id` die **absolute Wand** — keine Löcher. Der vom Eigentümer als geschäftskritisch bezeichnete mandantenübergreifende Support-Zugriff wird als eigenes, standardmäßig **leeres/ausgeschaltetes** Konstrukt (`platform_admins`) reserviert; scharf wird er erst in der Auth-Stufe, lückenlos protokolliert. Das Modell darf ihn nur nicht unmöglich machen.

8. **RLS-fertig & einheitlich benannt.** `tenant_id` ist überall eine normale `TEXT`-Spalte (später aus dem Login/JWT-Claim ableitbar). Der Spaltenname ist **überall `tenant_id`** — die heutige Abweichung `classification_settings.mandant_id` wird angeglichen. Im UI/Fachsprech bleibt es „Mandant".

9. **Anbieter-agnostisches Fundament (Vending Data Integration Layer).** Heute ist die Daten-Einspeisung Nayax-spezifisch (`nayax_devices`, `nayax_transaction_id`, Matching über Nayax-Namen/-IDs). Da später weitere Zahlungs-/Telemetrie-Anbieter dazukommen sollen, bekommt das Fundament **jetzt** eine schlanke `provider`-Dimension (Default `'nayax'`) auf den einspeisenden Tabellen — genau dieselbe Vorsorge wie bei `tenant_id`: die Spalte jetzt mitnehmen ist billig, sie später nachzurüsten teuer. Die **vollständige** Normalisierungs-/Abstraktionsschicht (der „Vending Data Integration Layer") ist eine eigene spätere SPEC; diese Stufe sorgt nur dafür, dass ein zweiter Anbieter **additiv** andockt statt einen Umbau zu erzwingen. Ein physisches Gerät gehört dabei **genau einem** Mandanten (systemweit eindeutig — Claiming-Schutz).

---

## User Stories

### Mandant als Einheit & Isolation

1. Als Eigentümer möchte ich, dass ein „Mandant" ein **Betrieb/eine Firma** ist (nicht eine Person), sodass mehrere Logins zum selben Betrieb gehören können.
2. Als Eigentümer möchte ich, dass mein Betrieb mit **zwei Eigentümern** als ein Mandant mit zwei Logins abgebildet wird, die beide alles sehen, sodass wir gemeinsam arbeiten, ohne die Daten zu doppeln.
3. Als externer Automaten-Betreiber (Mandant) möchte ich, dass **keine einzige** meiner Zeilen (Automaten, Standorte, Lager, Slots, Chargen, Preise, Produkte, Verkäufe, GuV, Warnungen, Rechnungen, Lieferanten, Aliase, Devices) für einen anderen Mandanten sichtbar oder schreibbar ist, sodass an keiner kleinen Stelle ein Leak entstehen kann.
4. Als Eigentümer möchte ich, dass die Isolation über **eine einzige Regel** („jede Zeile trägt `tenant_id`") läuft statt über Sonderfälle, sodass das Modell einfach prüfbar und schwer zu unterlaufen ist.
5. Als Entwickler möchte ich, dass `tenant_id` auf **jede** operative Tabelle denormalisiert wird, sodass spätere RLS-Policies und Query-Filter direkt auf der Relation greifen, ohne über JOINs zu gehen.

### Stammdaten pro Mandant

6. Als Mandant möchte ich meine **eigenen Produkte, Aliase, Lieferanten und Preise** haben, sodass meine Sortiments- und Einkaufsdaten privat bleiben und niemand sie durch eine Änderung beeinflusst.
7. Als zwei verschiedene Mandanten möchten wir denselben Artikel (z. B. „Cola 0,5 l") unabhängig anlegen können, sodass gleiche Geschäftsschlüssel bei verschiedenen Mandanten zu **zwei sauberen, getrennten Einträgen** führen (kein Konflikt, keine Vermischung).

### Lager (Warehouses)

8. Als Mandant möchte ich **ein oder mehrere benannte Lager** führen können (z. B. „Zentrallager", „Garage", „Transporter Nord"), sodass ich Backstock an verschiedenen Orten getrennt verwalten kann.
9. Als neuer Mandant möchte ich **automatisch genau ein** Lager „Zentrallager" bekommen, sodass ich ohne jede Einrichtung sofort Bestand führen kann und von der Lager-Mechanik nichts merke, solange ich nur eins habe.
10. Als Mandant möchte ich, dass jede **Charge** entweder „in Automat X" oder „in Lager Y" liegt, sodass ihr physischer Ort eindeutig ist.
11. Als Mandant möchte ich eine **Gesamt-Kurzansicht** („Gesamt auf Lager: X Stück / Y €") und bei Bedarf einen **Drill-down pro Lager** bekommen, sodass ich Überblick *und* Detail habe — beides aus denselben Daten.
12. Als Mandant möchte ich ein Lager **optional einem Standort zuordnen** können (z. B. Lager direkt am Automaten-Standort), sodass die reale Welt abgebildet ist, ohne dass die Zuordnung erzwungen wird.

### Standorte

13. Als Mandant möchte ich meine **eigenen Standorte** führen, an denen meine Automaten hängen (genau ein Standort je Automat), sodass meine Standortliste privat ist.
14. Als zwei Betreiber im selben Gebäude möchten wir **zwei getrennte Standort-Einträge** haben, sodass ein gemeinsamer physischer Ort nicht zu geteilten Daten führt.

### Mandanten-Verzeichnis & Mitgliedschaften

15. Als Plattform-Betreiber möchte ich ein **Mandanten-Verzeichnis** (`tenants`) mit ID, Name, Status (aktiv/pausiert/gekündigt), Anlagedatum und Kontakt-/Alarm-Adresse, sodass ich Betriebe sauber verwalten kann.
16. Als Plattform-Betreiber möchte ich, dass die **Mandanten-ID unveränderlich** ist (sie wird auf jede Zeile gestempelt) und der **Name jederzeit änderbar**, sodass eine Umbenennung keinen Daten-Umzug auslöst.
17. Als Mandant möchte ich, dass meine **Alarm-/Warnungs-Mails an meine eigene Kontaktadresse** gehen (nicht an den Plattform-Betreiber), sodass z. B. MHD-Warnungen beim richtigen Betrieb landen.
18. Als Plattform-Betreiber möchte ich eine **Mitglieder-Tabelle** (`tenant_users`: Login + Mandant + Rolle), sodass eindeutig ist, wer zu welchem Betrieb mit welcher Rolle (Eigentümer/Auffüller/Gast) gehört.

### Onboarding-Automatik & Einfachheit

19. Als neuer Mandant möchte ich, dass beim Anlegen automatisch mein **Zentrallager und meine Standard-Einstellungen** miterzeugt werden, sodass ich ab Tag 1 ohne Konfiguration startklar bin.
20. Als Mandant mit nur einem Standort und einem Lager möchte ich, dass das System sich **wie ein Single-Tenant-System anfühlt**, sodass die Mehrmandanten-Komplexität für mich unsichtbar bleibt.

### Support-Zugriff (ermöglicht, nicht gebaut)

21. Als Plattform-Betreiber möchte ich, dass das Modell einen späteren **Support-Notfall-Zugriff** auf fremde Mandanten *ermöglicht* (standardmäßig aus, lückenlos protokolliert), sodass mein Geschäftsmodell (Kunden-Support) tragbar ist — ohne dass die normale Mandanten-Wand dadurch ein Loch bekommt.

### Migration & Betrieb

22. Als Eigentümer möchte ich, dass meine **heutigen Daten geschlossen in meinen eigenen Mandanten** umziehen (echte `tenant_id`, kein namenloses „__default__" als Besitzer), sodass mein Bestand korrekt zugeordnet ist.
23. Als Eigentümer möchte ich, dass der **laufende Betrieb (n8n-Schreibpfade) während der Migration nicht bricht**, sodass die `tenant_id` bei bestehenden Schreibern automatisch aus dem Automaten/Slot abgeleitet wird, bis die Schreibpfade in einer späteren Stufe abgelöst sind.
24. Als Entwickler möchte ich, dass das Schema **RLS-fertig** ist (einheitlich `tenant_id`, aus dem Login ableitbar), sodass der spätere Supabase-Umzug ein Konfigurations- statt eines Umbau-Schritts ist.

### Datenintegrität & Anbieter-Zukunft

25. Als Mandant möchte ich, dass ein physisches Nayax-Gerät **genau einem** Mandanten gehört (systemweit eindeutig), sodass kein zweiter Betreiber dasselbe Gerät beanspruchen oder dessen Daten sehen kann.
26. Als Eigentümer möchte ich, dass die Datenbank **selbst** verhindert, dass ein Datensatz auf einen Eltern-Datensatz eines *fremden* Mandanten verweist (mandanten-treue Fremdschlüssel), sodass selbst ein Schreibfehler keine Cross-Tenant-Verkettung erzeugen kann.
27. Als Plattform-Betreiber möchte ich, dass das Fundament eine `provider`-Dimension trägt (heute nur `'nayax'`), sodass wir später weitere Zahlungs-/Telemetrie-Anbieter **additiv** anbinden können, ohne das Schema umzubauen.

---

## Implementation Decisions

> **Konvention:** Alle DDL-Skizzen unten sind das **Zielbild**. Da ein Teil des heutigen Schemas nur implizit im Code (nicht in Migrationen) existiert, liest das Migrations-TDD die **exakten** bestehenden Spalten und Constraint-Namen zur Bauzeit aus dem Live-Schema (`dashboard/lib/db-schema.js`-Introspektion) und passt `ALTER`-Statements entsprechend an. Schema: `automatenlager`. Höchste bestehende Migration: `0006` → neue Migrationen ab `0007`.

### Grundprinzip & Begriff

- **`tenant_id` ist überall `TEXT NOT NULL`** und wird auf **jede** operative Zeile denormalisiert. Typwahl `TEXT` konsistent zu den Vorbild-Tabellen `settings_thresholds` (`tenant_id TEXT`) und `classification_settings` (`mandant_id TEXT`).
- Der **Spaltenname ist einheitlich `tenant_id`**. `classification_settings.mandant_id` wird auf `tenant_id` umbenannt (abhängiger Code in `dashboard/lib/category-config.js` wird im selben Migrationsschritt nachgezogen — Code-Anpassung, aber kein Verhaltenswechsel). UI-/Fachbegriff bleibt „Mandant".
- **Mandant ≠ Login.** Ein Mandant ist ein Betrieb; Logins hängen über `tenant_users` daran.

### Neue Tabelle `tenants` (Mandanten-Verzeichnis)

```sql
CREATE TABLE automatenlager.tenants (
  tenant_id    TEXT        PRIMARY KEY,            -- unveränderliche, opake ID (z. B. ULID/UUID/Slug)
  name         TEXT        NOT NULL,               -- änderbares Etikett (Firmenname)
  status       TEXT        NOT NULL DEFAULT 'aktiv', -- 'aktiv' | 'pausiert' | 'gekuendigt'
  contact_email TEXT       NULL,                   -- Per-Mandant-Kontakt/Alarm-Adresse
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Die `tenant_id` ist eine **opake, stabile** Kennung (kein sprechender Wert, der sich ändern könnte). Empfehlung: generierte ID; der Anzeigename ist strikt getrennt.
- `status` steuert später (Auth-Stufe) den Zugang; im Datenmodell nur ein Feld.
- `contact_email` ist die Zieladresse für mandanteneigene Benachrichtigungen (löst die Audit-Anforderung „WF5 darf nicht fremde Warnungen versenden" auf der Datenseite).

### Neue Tabelle `tenant_users` (Mitgliedschaften)

```sql
CREATE TABLE automatenlager.tenant_users (
  tenant_user_id BIGSERIAL  PRIMARY KEY,
  tenant_id      TEXT        NOT NULL REFERENCES automatenlager.tenants(tenant_id),
  login          TEXT        NOT NULL,             -- E-Mail / Tailscale-User-Login
  role           TEXT        NOT NULL,             -- 'eigentuemer' | 'auffueller' | 'gast'
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_users_unique UNIQUE (tenant_id, login)
);
CREATE INDEX idx_tenant_users_login ON automatenlager.tenant_users (login);
```

- Trägt „ein Betrieb, zwei Eigentümer" als **zwei Zeilen** mit `role='eigentuemer'`.
- Die Rollen-Werte spiegeln das bestehende RBAC-Glossar (Eigentümer/Auffüller/Gast).
- Der Index auf `login` ist die Grundlage, aus der Stufe 2 (Auth) die `tenant_id` eines Logins auflöst. **Die Tabelle gehört ins Fundament; die Auflösungs-Logik ist Stufe 2** (hier nicht enthalten).

### Neue Tabelle `platform_admins` (Support-Notfall-Schlüssel, reserviert)

```sql
CREATE TABLE automatenlager.platform_admins (
  login      TEXT        PRIMARY KEY,   -- Login mit mandantenübergreifender Break-Glass-Befugnis
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **Bewusst eigene Tabelle statt Flag in `tenant_users`** (Verfeinerung gegenüber der Grill-Skizze): Break-Glass ist mandanten*übergreifend* und damit kein Attribut einer einzelnen Mitgliedschaft. So bleibt das Rollenmodell pro Mandant rein.
- Standardzustand: **leer = niemand kann übergreifen.** Erst ein Eintrag + (Stufe 2/4) eine protokollierte Auswertung schaltet Support-Zugriff frei. Das Modell *ermöglicht* den Schlüssel, baut ihn aber nicht scharf.
- **Audit-Reservierung:** Der spätere Support-Zugriff muss nachvollziehbar sein. Der bestehende Audit-Trail (heute JSONL, `auditAction`/`auditGuestAccess`) wird in der Auth-Stufe um die Felder **handelnder Login**, **Ziel-`tenant_id`** und **`war_mandantenuebergreifend`** erweitert. Diese SPEC reserviert die Anforderung; die Umsetzung ist Stufe 2/4.

### Neue Tabelle `warehouses` (Lager)

```sql
CREATE TABLE automatenlager.warehouses (
  warehouse_id BIGSERIAL  PRIMARY KEY,
  tenant_id    TEXT        NOT NULL REFERENCES automatenlager.tenants(tenant_id),
  name         TEXT        NOT NULL,              -- "Zentrallager", "Garage", ...
  location_id  INTEGER     NULL REFERENCES automatenlager.locations(location_id) ON DELETE SET NULL,
  is_default   BOOLEAN     NOT NULL DEFAULT FALSE, -- das auto-erzeugte Zentrallager
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warehouses_name_unique UNIQUE (tenant_id, name)
);
CREATE INDEX idx_warehouses_tenant ON automatenlager.warehouses (tenant_id);
-- Genau ein Default-Lager pro Mandant:
CREATE UNIQUE INDEX idx_warehouses_one_default
  ON automatenlager.warehouses (tenant_id) WHERE is_default;
```

- `location_id` ist **optional** (NULL erlaubt) — die freiwillige „Lager am Standort"-Zuordnung.
- Das partielle Unique-Index erzwingt **genau ein** Default-Lager je Mandant.

### Lager-Ort der Charge: `stock_batches.warehouse_id`

```sql
ALTER TABLE automatenlager.stock_batches
  ADD COLUMN IF NOT EXISTS warehouse_id BIGINT NULL
    REFERENCES automatenlager.warehouses(warehouse_id) ON DELETE SET NULL;
-- Eine Charge liegt in höchstens einem Ort (Automat ODER Lager):
ALTER TABLE automatenlager.stock_batches
  ADD CONSTRAINT stock_batches_one_location
  CHECK (num_nonnulls(machine_id, warehouse_id) <= 1);
```

- Semantik: `machine_id` gesetzt = Charge im Automaten; `warehouse_id` gesetzt = Charge im Lager; das alte „beide NULL = Zentrallager" wird beim Backfill aufgelöst (siehe unten).
- Der `CHECK` ist bewusst „**höchstens** ein Ort" (`<= 1`), nicht „genau ein Ort" — eine vollständig verbrauchte/ausgesonderte Charge (`status` `leer`/`ausgesondert`) darf ortlos sein. Die schärfere Invariante „aktive Charge hat genau einen Ort" wird als **Test-Invariante** geprüft (siehe Testing), nicht als DB-Constraint erzwungen, um Status-Altlasten nicht zu blockieren.

### `tenant_id` auf alle operativen Tabellen

Per `ALTER TABLE … ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '__default__'` (Default zunächst als **Migrations-Sicherheitsnetz**; nach dem Backfill **differenziert** behandelt — siehe „Default-Strategie in der Brücken-Phase") auf:

`machines`, `locations`, `machine_profiles`, `slot_assignments`, `products`, `product_aliases`, `product_change_proposals`, `stock_batches`, `sales_transactions`, `guv_daily`, `warnings`, `invoices`, `invoice_items`, `suppliers`, `nayax_devices`, `workflow_state`, `prices`.

Bereits mandantenfähig (nur **Angleichung**): `settings_thresholds` (hat `tenant_id`), `classification_settings` (`mandant_id` → `tenant_id` umbenennen). **Wichtig:** Auch deren heutige `'__default__'`-Zeilen (Schwellwert-/Kategorie-Config des Eigentümers) ziehen im Backfill auf den **realen** Mandanten um — sonst hinge deine Konfiguration weiter am Platzhalter statt an dir. `'__default__'` bleibt höchstens als System-Default-Vorlage erhalten, nie als Besitzer echter Daten.

Jede `tenant_id` bekommt einen Index:
```sql
CREATE INDEX IF NOT EXISTS idx_<tabelle>_tenant ON automatenlager.<tabelle> (tenant_id);
```
und eine FK auf `tenants(tenant_id)` (nach Backfill, damit keine verwaisten Werte entstehen).

### Schlüssel werden mandanten-eindeutig

Alle heutigen Business-Unique-Constraints werden um `tenant_id` **vorangestellt** erweitert, damit derselbe fachliche Schlüssel bei zwei Mandanten zu zwei sauberen Zeilen wird:

| Tabelle | heutiger Business-Schlüssel (verifiziert/zu verifizieren) | neues Unique |
|---|---|---|
| `products` | `product_key` (UNIQUE) | `UNIQUE (tenant_id, product_key)` |
| `stock_batches` | `batch_key` (UNIQUE) | `UNIQUE (tenant_id, batch_key)` |
| `suppliers` | `supplier_key` (UNIQUE) | `UNIQUE (tenant_id, supplier_key)` |
| `slot_assignments` | `(machine_id, mdb_code)` aktiv | `UNIQUE (tenant_id, machine_id, mdb_code)` (aktiv) |
| `sales_transactions` | `(machine_id, nayax_transaction_id)` | `UNIQUE (tenant_id, provider, <ext-txn-id>)` — `<ext-txn-id>` = heute `nayax_transaction_id`, fachlich `external_transaction_id`; siehe „provider-Dimension" |
| `prices` | `(slot_assignment_id, valid_from)` | `UNIQUE (tenant_id, slot_assignment_id, valid_from)` |
| `warnings` | `warning_key` (zu verifizieren) | `UNIQUE (tenant_id, warning_key)` |
| `product_change_proposals` | `proposal_key` (zu verifizieren) | `UNIQUE (tenant_id, proposal_key)` |
| `product_aliases` | `(product_id, alias_type, alias_value)` (zu verifizieren) | `UNIQUE (tenant_id, product_id, alias_type, alias_value)` |
| `invoices` | `(invoice_number, supplier_id)` (zu verifizieren) | `UNIQUE (tenant_id, …)` |
| `invoice_items` | `(invoice_id, line_number)` (zu verifizieren) | `UNIQUE (tenant_id, …)` |
| `workflow_state` | `workflow_key` (PK) | PK → `(tenant_id, workflow_key)` |

> Hinweis: Da `machine_id`/`location_id`/`slot_assignment_id` SERIAL-PKs bereits global eindeutig sind, ist `tenant_id` dort für die Eindeutigkeit nicht *nötig*, wird aber für RLS/Filter trotzdem als Spalte geführt. Bei **fachlichen** Schlüsseln (`*_key`, MDB-Kombinationen) ist die `tenant_id`-Voranstellung dagegen zwingend.

### Mandanten-treue Fremdschlüssel (composite FK)

Damit ein Kind-Datensatz **niemals** auf einen Eltern-Datensatz eines fremden Mandanten zeigen kann, werden die mandanten-relevanten Fremdschlüssel als **zusammengesetzte** FK über `(tenant_id, parent_id)` geführt statt nur über `parent_id`:

```sql
-- Eltern bekommen einen passenden Unique-Anker:
ALTER TABLE automatenlager.machines
  ADD CONSTRAINT machines_tenant_uk UNIQUE (tenant_id, machine_id);
-- Kinder referenzieren tenant-treu:
ALTER TABLE automatenlager.slot_assignments
  ADD CONSTRAINT slot_assignments_machine_tenant_fk
  FOREIGN KEY (tenant_id, machine_id)
  REFERENCES automatenlager.machines (tenant_id, machine_id);
```

Analog für `slot_assignments → products`, `stock_batches → products/machines/warehouses`, `prices → slot_assignments`, `sales_transactions → machines/slot_assignments`, `machine_profiles → machines`, `invoice_items → invoices`, `warehouses → locations`. So erzwingt die **Datenbank** die Mandanten-Konsistenz über die ganze Verkettung — die `tenant_id`-Denormalisierung kann nicht mehr „auseinanderlaufen". Bei nullbaren FKs (z. B. `stock_batches.machine_id`, wenn die Charge im Lager liegt) greift der composite FK nur, wenn die Spalte gesetzt ist — verträgt sich also mit der „Automat *oder* Lager"-Regel. **Dies ist die stärkste Härtung der SPEC:** kein Leak durch Verkettung, garantiert auf DB-Ebene statt nur per Konvention.

### Root-/Stammtabellen: Herkunft der `tenant_id`

Tabellen ohne mandanten-tragenden Eltern-FK — `machines`, `locations`, `suppliers`, `products`, `invoices`, `nayax_devices` — können `tenant_id` **nicht** aus einem Eltern ableiten. Ihre `tenant_id` kommt aus dem **Kontext des anlegenden Nutzers** (`viewer.tenantId`): die schreibende Funktion/der Endpunkt setzt sie explizit (durchgesetzt in Stufe 2/3). Während Migration/Single-Tenant-Betrieb füllt der Backfill bzw. der Default sie auf den einen realen Mandanten. Klar abgegrenzt: **Eltern-Ableitung per Trigger** für abhängige Tabellen, **Viewer-Kontext** für Root-/Stammtabellen.

### Default-Strategie in der Brücken-Phase (wichtig)

Das `DEFAULT '__default__'` ist nur das Sicherheitsnetz, damit die `ADD COLUMN NOT NULL`-Migration auf bestehenden Zeilen nicht scheitert. Nach dem Backfill wird **differenziert** vorgegangen, damit der laufende Betrieb (Story 23) nicht bricht:

- **Abhängige Tabellen** (mit tenant-tragendem Eltern-FK: `sales_transactions`, `stock_batches`, `prices`, `slot_assignments`, `machine_profiles`, `invoice_items`, …): `DEFAULT` **entfernen**. Der Brücken-Trigger füllt `tenant_id` aus dem Eltern-Datensatz — auch wenn ein heutiger Schreiber sie nicht mitgibt.
- **Root-/Stammtabellen** (ohne tenant-tragenden Eltern: `machines`, `locations`, `suppliers`, `products`, `invoices`, `nayax_devices`): `DEFAULT` **nicht sofort entfernen**, sondern per `ALTER COLUMN … SET DEFAULT '<realer-mandant>'` auf die **reale Mandanten-ID** umsetzen. So fügen heutige Schreiber (Dashboard-Anlage-Funktionen, WF1/WF2) weiter ohne explizite `tenant_id` ein, ohne zu brechen. Dieser **transiente** Default wird erst in Stufe 2/3 entfernt, sobald die Schreiber `viewer.tenantId` explizit mitgeben.

Damit ist der scheinbare Widerspruch „Default entfernen" vs. „Betrieb darf nicht brechen" sauber aufgelöst: Default weg, wo ein Trigger greift; transienter Real-Mandant-Default, wo es keinen Eltern gibt. (Für `stock_batches`-Inserts ins **Zentrallager** mit der heutigen `machine_id = NULL`-Konvention gilt dasselbe, bis der Schreiber `warehouse_id` setzt: die Ableitung läuft dann über `product_id → products.tenant_id`.)

### Geräte-Registry & Geräte-Claiming (provider-aware)

`nayax_devices` ist ein **Sonderfall** der Blanket-Regel: Ein physisches Gerät gehört **genau einem** Mandanten und darf nicht doppelt beansprucht werden. Daher ist die Eindeutigkeit **global** (nicht pro Mandant):

```sql
ALTER TABLE automatenlager.nayax_devices
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '__default__',
  ADD COLUMN IF NOT EXISTS provider  TEXT NOT NULL DEFAULT 'nayax';
-- Geräte-Claiming: ein externes Gerät systemweit genau einmal:
ALTER TABLE automatenlager.nayax_devices
  ADD CONSTRAINT nayax_devices_claim_unique UNIQUE (provider, nayax_machine_id);
```

Der eigentliche Claiming-Flow (Konflikt → eskalieren, Anbindung über die mandanteneigenen Anbieter-Credentials) ist **eigene geplante Arbeit** (Memory „Nayax-Automaten-Onboarding + Duplikate") und nicht Teil dieser SPEC — diese reserviert nur die Eindeutigkeits-Garantie.

### Zahlungs-/Telemetrie-Anbieter: `provider`-Dimension & VDIL (Vorausentwurf)

Damit später weitere Anbieter additiv andocken:

- **`provider`-Spalte jetzt** auf den einspeisenden Tabellen `sales_transactions` und `nayax_devices` (`TEXT NOT NULL DEFAULT 'nayax'`).
- **Idempotenz-Schlüssel verallgemeinern:** `sales_transactions.nayax_transaction_id` wird fachlich zu `external_transaction_id`, eindeutig je `(tenant_id, provider, external_transaction_id)`. (Physische Umbenennung optional in Stufe 1, damit heutige Schreiber nicht sofort brechen; gemeint ist ab jetzt „externe Transaktions-ID des Anbieters".)
- **Aliase sind bereits flexibel:** `product_aliases.alias_type` (`'nayax_name'`, `'nayax_id'`, …) trägt den Anbieter-Bezug schon heute — ein künftiger Anbieter ergänzt nur neue `alias_type`-Werte.

**Vorausentwurf „Vending Data Integration Layer" (VDIL):** Zielbild ist eine anbieter-agnostische Geräte-Registry (`provider` + `external_device_id` + JSONB für anbieter-spezifische Details) und ein anbieter-agnostisches Transaktions-/Telemetrie-Modell, in das Nayax als *erster* Adapter mündet. Die **vollständige** Schicht (Normalisierung verschiedener Eingangsformate, Anbieter-Parser, Per-Mandant-Anbieter-Credentials) ist eine **eigene spätere SPEC** und bewusst nicht hier gebaut — diese Stufe macht das Schema nur anbieter-bereit.

### Trigger: Mandanten-Vererbung + Brücke für laufende Schreiber

Zwei Wirkungen in einem Mechanismus:

1. **`BEFORE INSERT`-Auto-Fill je betroffener Tabelle:** Wenn ein Insert keine `tenant_id` mitliefert, leitet ein Trigger sie aus dem Eltern-FK ab und setzt `NEW.tenant_id`. Ableitungspfade:
   - `sales_transactions` → über `slot_assignment_id`/`machine_id` → `machines.tenant_id`
   - `stock_batches` → über `product_id` (→ `products`, immer vorhanden) bzw. `machine_id`/`warehouse_id` → deren `tenant_id`
   - `prices` → über `slot_assignment_id` → `slot_assignments.tenant_id`
   - `slot_assignments` → über `machine_id` → `machines.tenant_id`
   - usw. (jede Tabelle mit eindeutigem Mandanten-Eltern-FK)

2. **Bestehende Trigger nachziehen:** `fn_deduct_stock_on_machine_sale` (Migration `0003`) und `fn_update_price_from_sale` (Migration `0005`) werden so erweitert, dass
   - ihre `SELECT … FOR UPDATE`-/`UPDATE`-Statements auf `stock_batches`/`prices` zusätzlich nach `tenant_id` filtern (FIFO/Preis-Logik bleibt **innerhalb** eines Mandanten), und
   - ihre `INSERT`s die `tenant_id` aus dem auslösenden `slot_assignment`/`machine` mitschreiben.

Damit funktioniert der heutige n8n-Schreibpfad ohne sofortige Änderung weiter (Erfüllung von Story 23), und es entstehen **keine** NULL-/Falsch-Tenant-Zeilen.

### Onboarding-Automatik: `fn_create_tenant(...)`

Eine SQL-Funktion kapselt das Anlegen eines Mandanten als **eine** atomare Operation:

1. `INSERT` in `tenants` (ID, Name, Status `aktiv`, Kontaktadresse).
2. `INSERT` in `warehouses` ein Default-Lager `name='Zentrallager', is_default=TRUE`.
3. `INSERT` einer Default-Zeile in `classification_settings` (bzw. Verlass auf den idempotenten `loadEffectiveConfig`-Anleger) + ggf. `settings_thresholds`-Defaults.

Die Funktion ist Teil des **Schemas** (Datenmodell-Scope). **Wer** sie aufrufen darf, ist Stufe 2 (Auth) — hier nicht enthalten.

### Views & Materialized Views

`v_warnings_open`, `v_slot_turnover`, `mv_inventory_value_daily` werden in `dashboard/lib/db-schema.js` als erwartete Relationen geführt, haben aber **keine auffindbare DDL** (vermutlich nicht angelegt oder nur dokumentiert). Entscheidung:

- Bei der Migration wird ihr realer Zustand introspiziert. **Falls vorhanden**, werden sie neu definiert, sodass sie `tenant_id` aus den Basistabellen **mitselektieren**; der MV-Refresh wird mandantenbewusst (Filter/Partition) ausgelegt.
- **Falls nicht vorhanden**, wird ihr fehlender Zustand dokumentiert und ihre korrekte, `tenant_id`-führende Definition als Teil dieser bzw. der Schema-Migration nachgeholt.

### Module/Teilsysteme, die berührt werden (Stufe-0/1-Scope)

- **`dashboard/db-migrations/`** — neue Migrationen `0007+` (neue Tabellen, Spalten, Constraints, Trigger, Backfill). **Deep Module:** die Migration kapselt die gesamte Schema-Komplexität hinter einem klaren „vorher/nachher".
- **`dashboard/lib/db-schema.js`** — `EXPECTED_RELATIONS` um `tenants`, `tenant_users`, `warehouses`, `platform_admins` erweitern; der Contract-/Drift-Guard prüft künftig auch die `tenant_id`-Spalten-Erwartung.
- **`dashboard/lib/category-config.js`** — `mandant_id` → `tenant_id` (Namens-Angleichung; kein Verhaltenswechsel).
- Bestehende Trigger-Migrationen `0003`/`0005` — funktional erweitert (nicht ersetzt).

---

## Testing Decisions

**Was einen guten Test hier ausmacht:** Er prüft **beobachtbare Schema-Invarianten und Daten-Eigenschaften** (externes Verhalten), nicht die Formulierung einzelner SQL-Statements. Vorbild ist die bestehende, bewährte Testfamilie: `dashboard/lib/db-schema.js` (Contract-/Drift-Guard), `dashboard/tests/dashboard-inactive-slot-stock-invariant.test.js` (SQL-Invariante), `dashboard/tests/dashboard-produktart-contract.test.js`, `dashboard/tests/encoding-umlaut-fix.test.js`.

Geprüfte Module/Invarianten:

1. **`tenant_id`-Vollständigkeit (Contract-Guard).** Test stellt sicher, dass **jede** in der SPEC gelistete operative Tabelle eine `tenant_id TEXT NOT NULL`-Spalte besitzt — und schlägt fehl, sobald eine neue Tabelle ohne `tenant_id` hinzukommt (Erweiterung des bestehenden Drift-Guards um eine „Tenant-Pflicht"-Liste).
2. **Mandanten-eindeutige Schlüssel.** Test prüft, dass die fachlichen Unique-Constraints `tenant_id` enthalten — und dass derselbe `product_key`/`batch_key`/`supplier_key` für **zwei** verschiedene `tenant_id` ohne Konflikt einfügbar ist (Story 7).
3. **Lager-Ort-Invariante.** (a) DB-`CHECK`: keine Charge hat gleichzeitig `machine_id` **und** `warehouse_id`. (b) Daten-Invariante (Test): jede **aktive** Charge hat **genau einen** Ort (Automat oder Lager); kein aktiver Bestand ist nach dem Backfill ortlos.
4. **Genau ein Default-Lager je Mandant.** Test verifiziert den partiellen Unique-Index (zweites `is_default` schlägt fehl) und dass `fn_create_tenant` ein Zentrallager miterzeugt.
5. **Trigger-Vererbung.** Test fügt einen Verkauf/eine Charge/einen Preis **ohne** explizite `tenant_id` ein und prüft, dass der korrekte Mandant aus dem Eltern-FK abgeleitet wurde; und dass die FIFO-/Preis-Trigger nur **innerhalb** des Mandanten abbuchen/aktualisieren (zwei Mandanten mit gleichem `product_key` stören sich nicht).
6. **Backfill-Korrektheit & -Idempotenz.** Test über eine Migrations-Sandbox: nach dem Backfill trägt **keine** Zeile mehr `tenant_id = '__default__'`; alle Altzeilen tragen die reale Mandanten-ID; Migration ist wiederholbar (`IF NOT EXISTS`/idempotent); der `'__default__'`-DEFAULT ist bei **abhängigen** Tabellen entfernt und bei **Root-/Stammtabellen** auf die reale Mandanten-ID umgesetzt (transient, bis Stufe 2/3) — siehe „Default-Strategie in der Brücken-Phase".
7. **`db-schema.js`-Drift-Guard grün.** Nach der Migration kennt der Guard die vier neuen Relationen, und es bleiben keine „missing/unexpected relations".

Tests laufen gegen eine **Migrations-Sandbox-DB** (Schema anlegen → Migration `0007+` → Assertions), analog zur bestehenden PG-Testpraxis. Reine Dokumentations-Aussagen werden nicht getestet.

---

## Out of Scope

Bewusst **nicht** Teil dieser SPEC (= Folgestufen 2–8 des Audits bzw. eigene Themen):

- **Scharfschalten der Mandanten-Auflösung:** `resolveViewer` liest echte `tenant_id` aus Login/JWT, echtes `machineTenant()` (Stufe 2).
- **Query-Layer-Filter:** `WHERE tenant_id = $N` in `economics.js`, `economics-live.js`, `overview-monitoring.js`, `assortment-slots.js`, `inventory-mhd.js`, `alert-digest.js` (Stufe 3).
- **IDOR-Hooks scharfstellen** an den Machine-bezogenen Endpunkten (Stufe 4).
- **RLS-Policies** selbst (`FOR ALL USING tenant_id = auth.jwt()->>'tenant_id'`). Diese SPEC macht das Schema **RLS-fertig**, schreibt aber keine Policy (Stufe 5).
- **n8n-Ablösung/Parametrisierung** (pg_cron/Edge Functions, `machine_id=457107528` entfernen) (Stufe 6).
- **Per-Mandant-Credential-Vault** (Nayax/Google-Tokens). Das Modell **reserviert den Platz**, definiert die Secret-Tabellen aber nicht aus (Stufe 7).
- **Frontend-Mandantenkontext** (Indikator/Selektor, State-Reset) (Stufe 8).
- **Geteilter Referenz-Katalog** (Onboarding-Komfort) — spätere, separate, schreibgeschützte Copy-on-Onboard-Struktur, **nicht** Teil der Live-Tabellen.
- **Vollständiger Vending Data Integration Layer / Payment-Provider-Abstraktion** — diese SPEC führt nur die `provider`-Dimension ein; die anbieter-agnostische Registry, Anbieter-Parser/-Normalisierung und Per-Mandant-Anbieter-Credentials sind eine eigene spätere SPEC.
- **Nayax-Geräte-Claiming-Flow** (Konflikt-Erkennung, Eskalation, Onboarding über mandanteneigene Credentials) — eigene geplante Session; hier nur die Eindeutigkeits-Garantie.
- **Mandant löschen / DSGVO-Erasure** bei Kündigung und **Übertragung von Automaten/Betrieb zwischen Mandanten** (Geschäftsverkauf) — bewusst nicht jetzt; der Status `gekuendigt` existiert, die Lösch-/Transfer-Mechanik ist späteres, eigenes Thema.
- **Logik**, die `tenant_users`/`platform_admins` auswertet (Mandanten-Auflösung, Break-Glass-Durchsetzung, Audit des Support-Zugriffs) — Stufe 2/4.
- **Supabase-Plattform-Umzug** selbst (diese SPEC bleibt auf dem heutigen PostgreSQL umsetzbar und ist zugleich Supabase-fertig).

---

## Further Notes

- **Reihenfolge (kritisch):** Die `tenant_id`-DDL muss **vor** dem Code-Rollout und **vor** dem geplanten Mini-Deploy laufen — sonst crasht Code, der die Spalte erwartet, bzw. es entstehen falsch zugeordnete Zeilen. Innerhalb der Migration: erst Spalten + Default `__default__`, dann realen Mandanten anlegen + Backfill, dann FKs + Trigger; Default bei abhängigen Tabellen entfernen, bei Root-/Stammtabellen auf die reale Mandanten-ID umsetzen (transient, bis Stufe 2/3) — siehe „Default-Strategie in der Brücken-Phase".
- **Stufenkette (aus dem Audit):** Diese SPEC ist **Stufe 0**. Es folgen: **1** Schema-Migration (setzt genau dieses Modell um) → **2** Auth/JWT + echtes `machineTenant()` → **3** Query-Filter → **4** IDOR scharf → **5** RLS → **6** n8n-Ablösung → **7** Credential-Vault → **8** Frontend. „Auth vor RLS/Filter" bleibt die wichtigste Reihenfolge-Entscheidung des Audits: ohne dynamische `tenant_id` ist jede Isolation gegen eine Konstante und damit nicht verifizierbar.
- **Vorbild-Tabellen:** `settings_thresholds` (`tenant_id TEXT NOT NULL DEFAULT '__default__'`, `UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id, key)`) und `classification_settings` (`mandant_id TEXT PRIMARY KEY`, JSONB-Config) zeigen das Zielmuster bereits korrekt; alle übrigen Tabellen ziehen nach.
- **Verifikation zur Bauzeit:** Mehrere heutige Tabellen (`sales_transactions`, `guv_daily`, `warnings`, `invoices`, `invoice_items`, `nayax_devices`, `product_aliases`, `product_change_proposals`) existieren ohne Migrations-DDL (von WF/pgw geschrieben). Exakte Spalten-/Constraint-Namen sind beim Migrations-TDD aus dem Live-Schema zu lesen; die Unique-Erweiterungen in der Tabelle oben sind entsprechend mit „zu verifizieren" markiert.
- **Designentscheidung Break-Glass:** Als eigene `platform_admins`-Tabelle modelliert statt als Flag in `tenant_users` — Verfeinerung gegenüber der Planungs-Skizze, weil Support-Zugriff mandantenübergreifend ist. Damit bleibt das Rollenmodell pro Mandant rein und der Break-Glass-Pfad ist ein klar abgegrenztes, standardmäßig leeres Konstrukt.
- **Kein UI-Anteil:** Diese SPEC ist reines Datenmodell. Die spätere Lager-Darstellung (Gesamt-Kurzansicht + Drill-down) und ein etwaiger Mandanten-Indikator sind Frontend-Themen der Stufe 8 und werden dort mit dem v3-Designsystem gebaut.
- **Mandanten-treue Fremdschlüssel** (composite FK über `(tenant_id, parent_id)`) sind die stärkste Härtung dieser SPEC: Sie machen Cross-Tenant-Verkettung auf DB-Ebene unmöglich, nicht nur per Konvention — passend zur Vorgabe „kein Leak, nirgends".
- **Anbieter-Zukunft:** Nayax ist der erste, nicht der einzige Daten-Eingang. Die `provider`-Dimension wird jetzt mitgenommen (billig), die volle Abstraktionsschicht (VDIL) folgt als eigene SPEC. So bleibt Stufe 0 schlank, aber ein zweiter Anbieter erzwingt keinen Schema-Umbau.
- **Integer-Breite (TDD-Hinweis):** Die neuen Tabellen sind mit `BIGSERIAL`/`BIGINT` skizziert, der Bestand nutzt `INTEGER` (SERIAL). Kein Korrektheitsproblem (jedes FK-Paar passt für sich), aber das Migrations-TDD soll bewusst **vereinheitlichen** — Empfehlung: am Bestand orientieren (`INTEGER`), sofern keine >2-Mrd.-Zeilen erwartet werden.
- **`platform_admins` ist absichtlich ohne `tenant_id`** (mandantenübergreifend) und daher von der „Tenant-Pflicht"-Liste des Contract-Guards (Test 1) **ausgenommen** — ebenso ist `tenants.tenant_id` der PK selbst.
