# Ubiquitous Language — Domänen-Glossar

Verbindlicher Wortschatz für Backend, Frontend und Doku des Automatenlager-Systems.
Wenn ein Begriff hier steht, wird er überall **gleich** verwendet (Code-Bezeichner,
UI-Labels, Workflow-Namen, Commit-Messages). Neue Begriffe werden hier ergänzt,
bevor sie sich im Code verteilen.

> Angelegt im Rahmen von Phase „Dashboard v3 Multipage" (Issue v3-H / #8). Quelle
> der Slow-Mover-Definitionen ist `dashboard/lib/slow-mover.js` (`SLOW_MOVER`); die
> Werte hier müssen damit übereinstimmen und werden unter `/einstellungen` angezeigt.

---

## Drehgeschwindigkeit (Branchen-Anker-Klassifikation) *(aktualisiert)*

> Umgestellt von relativer Quartil-/Stückzahl-Logik auf einen **absoluten,
> kategoriebasierten Maßstab**. Quelle: SPEC `docs/specs/branchen-anker-drehgeschwindigkeit-v1.md`.
> Bevorzugter Cluster-Name: **Drehgeschwindigkeit** (*zu vermeiden als Synonym: „Drehzahl",
> „Umschlag" als Klassen­begriff*). Logik liegt im Backend (`classifyTurnover`,
> `dashboard/lib/slow-mover.js`); das Frontend zeigt nur die gelieferte `turnover_class` als **Badge**.

**Drehgeschwindigkeits-Klasse** = wie wirtschaftlich sich ein **Slot/Automat** dreht, gemessen am
**Deckungsbeitrag pro Slot pro Woche** (nicht an Stückzahl, nicht global pro Produkt):

| Klasse (`key`) | Label | Definition |
|---|---|---|
| `renner` | **Renner** | Deckungsbeitrag/Slot/Woche **über** der kategorie­spezifischen oberen Latte. Der Platz verdient überdurchschnittlich. |
| `normal` | **Normal** | Deckungsbeitrag/Slot/Woche **zwischen** unterer und oberer Latte. |
| `langsam_dreher` | **Langsam-Dreher** | Deckungsbeitrag/Slot/Woche **unter** der unteren Latte. Der Platz verdient zu wenig — tauschen erwägen. |
| `ladenhueter` | **Ladenhüter** | **0 Verkäufe seit ≥ `ladenhueterDays` (Default 30) Tagen** — totes Kapital + MHD-Risiko. **Zeitbasiert, Vorrang** vor den Geld-Klassen. |
| `ek_fehlt` | **Bewertung nicht möglich (EK fehlt)** *(neu)* | Kein Einkaufspreis hinterlegt → Deckungsbeitrag nicht berechenbar → **keine geratene Klasse**, sondern neutraler Hinweis (= Nachpflege-Arbeitsvorrat). |
| `neu` | **Neuling (Schonfrist)** *(neu)* | Produkt seit weniger als `graceDays` (Default 14) gelistet → von Renner/Langsam ausgenommen, damit Neulinge nicht vorschnell aussortiert werden. |

Festlegungen:

- **Granularität:** pro Slot/Automat, nicht pro Produkt; durchgängig `machine_id`-parametrisch (N Automaten).
- **Zeitfenster:** rollierend **4 Wochen (28 Tage)**; Verkäufe aus `automatenlager.sales_transactions`,
  EK-Netto über `dashboard/lib/guv-ek.js`.
- **Zwei getrennte Signale:** **Drehgeschwindigkeit** (Geld, „lohnt sich der Slot?") und **Ladenhüter**
  (Zeit, „verrottet hier Kapital?") sind bewusst unabhängig.
- Alle Schwellen (Latten, `graceDays`, `ladenhueterDays`) sind **editierbar und mandantenspezifisch**;
  Defaults greifen ab Tag 1 (Onboarding ohne Konfiguration).

---

## Branchen-Anker, Kategorie-Marge & Produktkategorie *(neu)*

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Branchen-Anker** | Die **von außen** (aus der Branchennorm) gesetzte Default-Latte für die Drehgeschwindigkeit — **nicht** aus den eigenen Ist-Zahlen abgeleitet. | „relativer Vergleich", „eigener Schnitt" |
| **Deckungsbeitrag pro Slot/Woche** | Klassifikations-Kennzahl: `(Menge im 4-Wochen-Fenster × (VK_netto − EK_netto)) ÷ Wochen`, je Slot. | „Drehzahl", „Umsatz pro Slot" |
| **Umsatz-Norm** | Branchenüblicher Umsatz eines gut positionierten Automaten (≈ 800–1200 €/Monat); **Quelle** der Default-Latte (× Kategorie-Marge), nicht selbst die Latte. | „Zielumsatz" |
| **Kategorie-Marge** | Kategoriespezifischer Rohmargen-Anteil zum Ableiten der Latte. Defaults: **Getränke 43 %, Snacks 52 %, Fallback 50 %**. | „Aufschlag" |
| **Produktkategorie (`produktart`)** | Warengruppe eines Produkts (`getraenk`, `snack`, …); mandantenerweiterbar. Wird aus Google Sheets **in die SQL-DB übernommen** (Single source of truth). | „Typ" (kollidiert mit Automaten-`type`) |
| **Latte (untere/obere)** | Der kategoriespezifische Schwellwert des Deckungsbeitrags/Slot/Woche: **unter** der unteren Latte = Langsam-Dreher, **über** der oberen = Renner, dazwischen = Normal. Der Default jeder Latte ist der Branchen-Anker. | „Grenze", „Cutoff", „Quartil" |

Beziehungen: Produkt **hat** genau eine Produktkategorie · Kategorie **trägt** eine Kategorie-Marge ·
Umsatz-Norm × Kategorie-Marge **ergibt** den Branchen-Anker (Default-Latte) je Kategorie ·
Mandant **kann** eigene Kategorien anlegen, zuordnen und deren Marge setzen.

---

## Slot, MDB-Code & Etagen-Konvention

- **Slot** = ein Verkaufsplatz in einem Automaten, adressiert über `machine_id`
  (Automat) + `mdb_code` (Position laut MDB-Protokoll).
- **MDB-Slot-Code-Schema:** Die **erste Ziffer** des MDB-Codes = **Etage**, die
  **folgenden Ziffern** = **Position innerhalb der Etage** (z. B. `12` = Etage 1,
  Position 2).
- **Etagen-Konvention:** **oberste Reihe zuerst** — Etage 1 ist oben, höhere
  Etagennummern liegen darunter. Die Slot-Position wird, sofern nicht explizit
  gespeichert, rückwärtskompatibel aus dem Slot-Code abgeleitet.
- **`product_slot_id` / aktive Zuordnung:** WF4 ist die einzige Quelle der
  Wahrheit für aktive MDB/Slot-Zuordnungen (`active = TRUE/FALSE`,
  `valid_from`/`valid_to`). `active = TRUE` bedeutet **aktive Slot-Zuordnung**,
  nicht bloße Produktexistenz.

---

## Wirtschaftlichkeit: Deckungsbeitrag & Marge

- **Umsatz (netto / brutto):** `revenue_net` ist netto, `revenue_gross` ist brutto.
- **Deckungsbeitrag (DB, netto):** `db_net` = Netto-Umsatz − Netto-Wareneinsatz.
  Der Netto-Wareneinsatz wird über den MwSt-Faktor `revenue_net / revenue_gross`
  aus den Brutto-Kosten abgeleitet (ab Migration `0016`, exakt da Einkaufs-MwSt =
  Verkaufs-MwSt je Produktart).
- **Marge:** `margin_pct` = `db_net / revenue_net × 100`.
- **Achtung Spaltennamen:** In `guv_daily` sind `revenue_gross` und
  `cost_of_goods` **brutto**, `gross_profit` ist eine **Brutto**-Differenz. Für
  netto-konsistente KPIs immer die KPI-Views ab `0016` nutzen — **nie**
  `gross_profit` direkt durch `revenue_net` teilen.

---

## Standort-Status

- **aktiv / inaktiv / geplant** — Betriebsstatus eines Standorts. Im normalisierten
  PG-Schema ohne eigene Spalte; lesend aus der Maschinen-Aktivität abgeleitet
  (≥ 1 aktive Maschine → `aktiv`, Maschinen aber keine aktiv → `inaktiv`, keine →
  `geplant`). Siehe `dashboard/lib/location-profiles.js`.

---

## Zugriffsrollen & Fähigkeiten (RBAC)

> Quelle: SPEC `docs/specs/auth-sicherheitskonzept-v1.md`. Berechtigungen werden als
> **Fähigkeiten (Verben)** modelliert, nicht pro Reiter. Ein Reiter wird sichtbar,
> sobald der Viewer **mindestens eine** passende Fähigkeit hat. Durchsetzung erfolgt
> **serverseitig** (HTTP `403` bei fehlender Fähigkeit); das Ausblenden in der UI ist
> nur Komfort, nicht der Schutz.

- **Fähigkeit (Verb):** Eine einzelne, benannte Berechtigung. Kanonisch genau sechs:
  - **`betrieb.lesen`** — Tagesgeschäft ansehen (Reiter Heute, Bestand, Monitoring, Automaten).
  - **`finanzen.lesen`** — GuV/Umsatz/Marge sehen (Reiter GuV). Eigener Vertraulichkeits-Schalter.
  - **`bestand.schreiben`** — Korrektur, Slot-Editor, Onboarding, Refill schreiben (Wahrheitsquelle WF4).
  - **`workflows.starten`** — n8n-Workflows triggern (querschnittlich, kein einzelner Reiter).
  - **`nayax.schreiben`** — Nayax-Apply/Push ausführen. **Höchstes Risiko.**
  - **`system.verwalten`** — Einstellungen + Zugangsdaten verwalten. **Master-Fähigkeit.**
- **Rolle:** Ein benanntes **Bündel** von Fähigkeiten (Voreinstellung). Kanonisch drei:
  - **Eigentümer** — alle sechs Fähigkeiten.
  - **Auffüller** (*Synonym Operator; bevorzugt: Auffüller*) — `betrieb.lesen` + `bestand.schreiben`
    (optional `workflows.starten`); **kein** `finanzen.lesen`, `system.verwalten`, `nayax.schreiben`.
  - **Gast** — nur `betrieb.lesen` (read-only). *Zu vermeiden: „Read-Only-Benutzer" als Rollenname.*
- **Viewer** *(aktualisiert)***:** Das vom Server pro Anfrage aufgelöste Subjekt (`getViewer`) mit Login,
  Rolle, Fähigkeiten, **Heimat-Mandant** und **effektivem** `tenantId` (Trennung siehe Cluster „Auth scharf").
  Einziger Knotenpunkt der Identitätsauflösung.

Beziehungen: Rolle **bündelt** 1..n Fähigkeiten · Reiter/Endpunkt **fordert** 1..n Fähigkeiten ·
Viewer **hat** genau eine Rolle (und damit deren Fähigkeiten).

---

## Authentifizierung & Vertrauen

> Identität ist nur dann vertrauenswürdig, wenn sie über den richtigen **Pfad** kommt
> (Sicherheits-Review **F1**). Der Loopback-Bind allein genügt nicht gegen Spoofing.

- **Identity-Header:** Der `Tailscale-User-Login`-Header. Nur **Tailscale Serve** setzt
  bzw. überschreibt ihn vertrauenswürdig; client-gesetzte Werte werden dort verworfen.
- **Serve-Pfad:** Zugriff über **Tailscale Serve, HTTPS auf `:8443`**. **Nur hier** wird
  der Identity-Header ausgewertet. *Zu vermeiden: roher TCP-Zugang auf `:8787`.*
- **Interner Pfad:** Zugriff übers Docker-Netz `homelab-network` (z. B.
  `homelab-dashboard:8787`, etwa durch WF-Monitor). `Tailscale-*`-Header werden hier
  **verworfen**; der Aufruf gilt **immer als Gast/read-only**. = **pfad-basiertes Vertrauen**.
- **Default-Deny:** „Kein Identity-Header → **kein** Admin." Kehrt das frühere
  Fehlverhalten (`!header → Admin`) um. *Zu vermeiden: „Operator-Trust".*
- **Loopback-Notausgang (Dev-Flag):** Kein Header + lokaler Loopback ⇒ Admin **nur**, wenn
  `DASHBOARD_DEV_LOCAL_ADMIN` gesetzt ist (Entwicklung). In Produktion **aus**.
- **Exakte Allowlist:** Nur **exakt** hinterlegte Logins erhalten eine Rolle. Die alte
  Präfix-Regel (`startsWith('patrick')`) entfällt ersatzlos.

---

## Mandant & editierbare Schwellwerte

- **Mandant / `tenant_id`** *(aktualisiert)***:** Ein **Betrieb/eine Firma** als logische Eigentümer-Einheit
  der Daten — **nicht** eine Person; mehrere Logins können zu einem Mandanten gehören (z. B. eine Firma
  mit zwei Eigentümern = zwei Logins, **ein** Mandant). `tenant_id` ist der **einheitliche, kanonische
  Spaltenname auf jeder operativen Tabelle** (denormalisiert, RLS-fertig); die frühere Abweichung
  `classification_settings.mandant_id` wird darauf angeglichen. Im UI/Fachsprech bleibt „Mandant".
  *Zu vermeiden: „Kunde" als Code-Begriff; „Mandant = Login".*
- **Schwellwert (editierbar):** In `/einstellungen` (`system.verwalten`) änderbarer Wert. Kanonisch:
  **Ladenhüter-Tage** (Default 30, vgl. Slow-Mover-Cluster) und **MHD-Risiko-Fenster** (Default 30 Tage).
- **Globaler Default vs. Pro-Automat-Override:** Ein Schwellwert gilt **global**, solange kein
  Automat per `machine_id` abweicht; ein **Override** ist eine Wert-pro-Automat-Festlegung, die den
  globalen Default schlägt.
- **„Auf Standard zurücksetzen":** Reset eines Schwellwerts auf den Code-Default — **pro Wert** (↺)
  und als **globale** Aktion (alles zurücksetzen).
- **Editierbar je Mandant** sind neben den Schwellwerten auch **Kategorien**, **Kategorie-Margen** und
  die **Latten** der Drehgeschwindigkeit (siehe Branchen-Anker-Cluster).

---

## Mandantenfähigkeit: Standort, Lager & Mitgliedschaft *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-datenmodell-v1.md` (Stufe 0). Grundsatz: **eine** Isolations-Regel —
> jede operative Tabelle trägt `tenant_id` (denormalisiert, RLS-fertig), keine geteilten Zeilen.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Standort (`locations`)** | Aufstellort von Automaten; gehört genau einem Mandanten, ein Automat hängt an genau einem Standort. Wird **nie** über Mandanten geteilt (gleiches Gebäude, zwei Betreiber = zwei Einträge). | „Lager" (ein Standort ist kein Backstock-Ort) |
| **Lager (`warehouses`)** | Benannter Backstock-Ort, der dem Mandanten gehört (eigene Tabelle), optional einem Standort zuordenbar. | „Standort"; „Zentrallager" als Oberbegriff |
| **Zentrallager** | Das automatisch beim Mandanten-Anlegen erzeugte Default-Lager (`is_default = TRUE`, genau eines je Mandant). Löst das frühere namenlose „`machine_id = NULL`" ab. | „Hauptlager" |
| **Mitgliedschaft (`tenant_users`)** | Zuordnung Login + Mandant + Rolle (Eigentümer/Auffüller/Gast); ein Mandant kann mehrere Mitglieder haben (zwei Eigentümer = zwei Mitgliedschaften). | „Benutzerkonto", „Account" |
| **Notfall-Schlüssel / Break-Glass (`platform_admins`)** *(aktualisiert)* | MandantenÜBERGREIFENDER Support-Zugriff (Plattform-Betreiber), als eigene Tabelle modelliert (keine Rolle *innerhalb* eines Mandanten); standardmäßig **leer = niemand übergreift**, jeder Zugriff protokolliert. Wird in **Stufe 2 (Auth scharf)** als nur-lesende **Support-Sitzung** scharfgeschaltet (siehe Cluster „Auth scharf"). | mit Rolle „Eigentümer/Auffüller/Gast" verwechseln; „Superadmin-Rolle" |
| **Mandanten-treuer Fremdschlüssel (composite FK)** | Zusammengesetzter FK `(tenant_id, parent_id)` statt nur `parent_id`; die DB garantiert, dass ein Kind nur auf einen Eltern **desselben** Mandanten zeigt. | „normaler Fremdschlüssel" als Schutz |
| **`__default__`** | Transienter Platzhalter-Mandant **nur** während der Migration — nie Besitzer echter Daten; Altdaten ziehen auf den realen Mandanten um. | als echten Mandanten/Besitzer verwenden |

Beziehungen: Mandant **hat** 1..n Mitgliedschaften · Mandant **hat** 1..n Standorte, 1..n Lager (mind. 1 Zentrallager),
1..n Automaten · Automat **steht an** genau einem Standort · Lager **kann** einem Standort zugeordnet sein ·
Charge **liegt in** höchstens einem Ort (**Automat ODER Lager**; aktive Charge: genau einem, verbrauchte/ausgesonderte darf ortlos sein).

---

## Mandantenfähigkeit: Auth scharf (Stufe 2) *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md`. Stufe 2 ersetzt die
> hartcodierte Konstante durch dynamische, DB-gestützte Mandanten-Auflösung und schaltet
> damit die schon gebaute RBAC/IDOR-Architektur scharf. Verkabelung, kein neues Feature/UI.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Heimat-Mandant (`homeTenantId`)** | Der Mandant, dem ein Login laut `tenant_users` dauerhaft angehört — der Alltagskontext. | „der Mandant" pauschal (verdeckt die Heimat/effektiv-Trennung) |
| **Effektiver Mandant (`tenantId`)** | Der Mandant, auf dem ein Request **tatsächlich** operiert; standardmäßig = Heimat-Mandant, bei aktiver Support-Sitzung = Ziel-Mandant. | `tenantId` als „immer = Heimat" lesen |
| **Plattform-Admin** | Ein in `platform_admins` eingetragener Login mit der Befugnis, im Supportfall fremde Mandanten zu betreten; **getrennt** von Mandanten-Mitgliedschaft und RBAC-Rolle (Doppelrolle möglich). | „Superadmin-Rolle"; mit Eigentümer-Rolle vermischen |
| **Support-Sitzung (Break-Glass, scharf)** | Die **zur Laufzeit aktivierte** Form des Notfall-Schlüssels: bewusster, per-Request-expliziter, **nicht-klebriger**, **nur-lesender** Cross-Tenant-Zugriff eines Plattform-Admins; Default bleibt immer der eigene Mandant. | „Support-Modus" als dauerhafter Zustand; „Impersonation" mit Schreibrechten |
| **Mandanten-Override (`X-Support-Tenant`)** | Das explizite Header-Signal, das eine Support-Sitzung pro Request aktiviert; nur wirksam bei Plattform-Admin **und** vertrauenswürdigem Identity-Pfad **und** existierendem Ziel-Mandant. Client-kontrolliert ⇒ untrusted by default. | `?tenant_override`-Query-Param; „Tenant-Switch" als Sitzungszustand |
| **Mandanten-Registry (`tenant-directory`)** | Das Deep Module, das Login→Mandant, Plattform-Admin-Status, Mandanten-Existenz und Maschine→Mandant aus der DB in einen In-Memory-Cache lädt und als **einzige** Auflösungsquelle dient (`resolveViewer` bleibt synchron). | „der Cache" pauschal; Auflösung verstreut in Endpunkten |
| **Maschinen-Mandant (`machineTenant`)** | Auflösung `machine → tenant_id`; liefert bei unbekannter Maschine **`null`** (nie einen Default), zwingend gekoppelt an `objectAccessAllowed` (`null` ⇒ deny). | unbekannte Maschine ⇒ Eigentümer/`t_faltrix` |
| **Capability-Stripping** | Durchsetzung von read-only: bei aktiver Support-Sitzung werden die Fähigkeiten des Viewers auf die **Lese-Teilmenge** (`*.lesen`) reduziert, sodass bestehende `requireCapability`-Guards Schreibzugriffe automatisch mit `403` abweisen. | read-only nur über HTTP-Methode prüfen |
| **fail-closed** | Jeder **technische** Fehler der Mandanten-Auflösung (DB/Cache) ⇒ deny/`503`, **nie** ein Default-Mandant. Strikte Trennung: „nicht gefunden/fremd" ⇒ `404`, „technisch fehlgeschlagen" ⇒ `503`. | `catch ⇒ Default-Mandant`; `404` und `503` vermischen |

Beziehungen: Login **hat** genau einen Heimat-Mandanten (über Mitgliedschaft) · Plattform-Admin **kann** je Request eine Support-Sitzung auf einen fremden Mandanten öffnen ·
Support-Sitzung **setzt** den effektiven Mandanten ≠ Heimat-Mandant **und** erzwingt read-only · Mandanten-Registry **ist** die einzige Quelle für Heimat-Mandant, Plattform-Admin-Status und Maschinen-Mandant.

---

## Mandantenfähigkeit: Query-Filter / Lese-Isolation (Stufe 3) *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-query-filter-stufe-3-v1.md`. Stufe 3 trennt die
> **Lese-Pfade** flächendeckend nach Mandant — über **eine** zentrale Tür statt 40 einzelner
> Filter. Baut auf dem **effektiven Mandanten** aus dem „Auth scharf"-Cluster (Stufe 2) auf.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Lese-Isolation** | Mandanten-Trennung der Lese-Pfade: jede Abfrage liefert nur Daten des **effektiven Mandanten**. | „Filter" pauschal |
| **Mandanten-Tür** | Der zentrale, **fail-closed**, mandanten-bewusste Datenzugriffs-Helfer — die **einzige** legitime Stelle für mandanten-bezogene Lese-Queries; ohne gesetzten Mandanten führt sie nichts aus; bündelt den DB-Zugriff und ist der Haken für RLS (Stufe 5). | „DB-Wrapper" pauschal; „jeder filtert selbst" |
| **No-Bypass-Invariante** | Direkte DB-Reads **außerhalb** der Tür (eigener `pg.Client`/`client.query`) sind **verboten** und werden vom Wächter als Verstoß markiert. | „bitte die Tür nutzen" (zu weich) |
| **Query-Filter-Contract-Guard (`#107`-Wächter)** | Automatischer Suite-Test, der mandanten-bezogene Reads **ohne** `tenant_id`-Bindung, **an der Tür vorbei** oder als **ungefiltertes Aggregat** fängt. | „Linter"; „Warnung" |
| **Melde-Modus → build-blocking** | Transienter Berichts-Zustand des Wächters (listet ungefilterte Reads) vs. scharfer Endzustand, der den **Build bricht**; die Ausnahmeliste **schrumpft** pro Slice. | Wächter dauerhaft „nur warnend" lassen |
| **Echt-globale Tabelle** | Tabelle **ohne** kundenspezifische Information, bewusst mandantenübergreifend (Verzeichnis `tenants`/`tenant_users`/`platform_admins`, reine Provider-/Lookup-Tabellen) — von der Filterung ausgenommen. | `machines`/`locations`/`settings_thresholds` als „global" |
| **Mandantenpflichtige Tabelle** | Default: jede Tabelle mit kundenspezifischem Inhalt (u. a. `machines`, `locations`, `settings_thresholds`, `nayax_devices`-**Zuordnung**) **muss** tenant-gefiltert werden. | „ist ja nur Stammdaten" |
| **Aggregations-Leck** | Ein ungefiltertes Aggregat (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`) leckt genauso wie `SELECT *` — fremde Summen sind ein vollwertiges Datenleck. | Aggregate als „harmlos" einstufen |
| **(Mat)View-Bypass** | Eine (Mat)View muss `tenant_id` **enthalten** **oder** nur über eine tenant-filternde View/die Tür gelesen werden — **nie roh**, sonst Umgehungspfad. | MatView „ist ja schon getrennt" |
| **Vertikaler Slice (Häppchen)** | Bereichsweiser Rollout-Schritt: Queries eines Bereichs durch die Tür + Test gegen synthetische Mandanten `acme`/`globex` (#94-Sandbox) + Live-Check, dann Wächter für den Bereich scharf. | „Big-Bang-Migration" |
| **Hintergrund-/zeitgesteuerter Lesepfad** | Lesepfad **ohne** Viewer (z. B. `alert-digest`, Monitoring-Jobs); braucht eine **explizite Mandanten-Quelle**, läuft **pro Mandant**, fällt **nie** auf einen Default zurück. | Job „ohne Mandant"/mit Default laufen lassen |

Beziehungen: Jeder Lese-Pfad **liest durch** die Mandanten-Tür · Tür **erzwingt** den effektiven Mandanten
(kein Mandant ⇒ 0 Zeilen, kein Default) · Wächter **bewacht** No-Bypass-Invariante + Filter-Vollständigkeit (inkl. Aggregate & (Mat)Views) ·
Tür **setzt** in Stufe 5 zusätzlich die RLS-Sitzungsvariable · Lese-Isolation (Stufe 3) **schützt** das Sehen, Schreib-Isolation (Stufe 4) das Verändern.

---

## Mandantenfähigkeit: Schreib-Isolation (Stufe 4) *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-write-isolation-stufe-4-v1.md`. Stufe 4 trennt die
> **Schreib-Pfade** (INSERT/UPDATE/DELETE/UPSERT) und jede schreib-auslösende **Autorisierung**
> nach Mandant. Leitprinzip: **Autorisierung** (wem gehört das Objekt? → künftige Render-Schicht)
> und **Datenzugriff** (Schreiben → Supabase + RLS Stufe 5) sind **zwei getrennte, cloud-agnostische
> Schichten**. Anders als Stufe 3 enthält Stufe 4 **DDL**. Baut auf Tür (Stufe 3) + effektivem Mandanten (Stufe 2) auf.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Schreib-Isolation** | Mandanten-Trennung der Schreib-Pfade: jede Schreibung wirkt nur auf Daten des effektiven Mandanten; ein mandantenübergreifender `UPDATE`/`DELETE` ist unmöglich. | „Filter" pauschal; mit Lese-Isolation gleichsetzen |
| **Mandanten-Tür (Schreib-Modus)** | Die `write()`-Seite der Tür: einzige legitime Stelle für mandanten-bezogene Schreibungen; Mandant als `$1`, INSERT setzt `tenant_id`, UPDATE/DELETE tragen `WHERE tenant_id = $1`, UPSERT trägt `tenant_id` im Konflikt-Ziel. | roher `client.query` für Writes |
| **fail-closed-werfend** | Verhalten der Tür beim **Schreiben** ohne Mandant: sie **wirft** einen harten Fehler (≠ Lesen, das fail-closed-**leer** zurückgibt) — nie ein falsches „gespeichert". | stilles `{rowCount:0}` beim Schreiben; „leer = ok" |
| **Transaktionaler Schreib-Modus (`db.tx`)** | Tür-Modus, der **Parent-Prüfung + Schreibung atomar** auf einem Client in einer Transaktion ausführt; schließt die Prüf-dann-Schreib-Lücke und ist der Steckplatz für den RLS-Haken (Stufe 5). | Prüfung und Write lose nacheinander |
| **Prüf-dann-Schreib-Lücke (TOCTOU)** | Zeitfenster zwischen „Parent gehört dem Mandanten?" und der Schreibung, in dem sich der Zustand ändern kann; durch den transaktionalen Modus geschlossen. | „passiert schon nichts" |
| **Autorisierungs-Tor** | Die Eigentums-Prüfung **vor** jeder schreib-auslösenden Aktion: generisch `requireObjectAccess(viewer, objectTenantId)`, Maschinen-Spezialfall `requireMachineAccess`; fremd/unbekannt ⇒ 404 + Audit. Eigene Schicht, getrennt vom Datenzugriff. | „IDOR-Check" pauschal; alles über Maschinenlogik ziehen |
| **Parent-Matrix** | Die explizite Zuordnung Endpunkt → korrekter Parent-Typ → Mandanten-Auflösung: `machine_id`→Registry, `case_id`→`correction_cases.tenant_id`, `product_key`→`products.tenant_id`. Verhindert, dass Korrektur/Onboarding fälschlich als „Maschine" geprüft werden. | „überall machine_id" |
| **Webhook-Weiterleiter** | Schreib-auslösender Endpunkt, der eine Objekt-ID an n8n weiterreicht (eigentlicher Write = **Stufe 6**); seine **Autorisierung** ist die einzige Stufe-4-Verteidigung und überlebt den n8n→Render-Wechsel unverändert. | „der schreibt ja nicht" (Autorisierung trotzdem nötig) |
| **`tenant_id`-im-Body-Verbot** | Ein client-geliefertes `tenant_id`/`mandant_id` im Request-Body wird **hart abgelehnt** (400) + auditiert; der Mandant kommt **immer** aus dem Viewer. | Feld still ignorieren; Mandant aus Payload lesen |
| **Break-Glass-Schreib-Sperre** | Bestätigung der Stufe-2-Garantie: unter aktiver Support-Sitzung bleibt Schreiben mit **403** (`SUPPORT_SESSION_READ_ONLY`) geblockt + Audit `break_glass_write_blocked` — auch an den neuen Schreib-Endpunkten. | Support-Sitzung darf schreiben |
| **DDL-Vorab-Check (Beißer)** | Idempotenter Migrations-Guard, der tatsächlich kippen kann: `tenant_id` **befüllt + NOT NULL** (Backfill `__default__`) und `ON CONFLICT`-Ziel **im selben Schritt** auf den neuen Constraint umstellen (`UNIQUE NULLS NOT DISTINCT (tenant_id, <key>)`). | Duplikat-Prüfung als „der" Check (Erweitern ist nur Lockerung) |

Beziehungen: Jeder Schreib-Pfad **schreibt durch** die Tür (Schreib-Modus) · Tür **wirft** ohne Mandant (fail-closed-werfend) ·
transaktionaler Modus **bündelt** Parent-Prüfung + Schreibung (TOCTOU-Schutz) **und** **trägt** den RLS-Haken (Stufe 5) ·
Autorisierungs-Tor **prüft** Objekt-Eigentum vor dem Auslösen (Parent-Matrix bestimmt den Parent-Typ) · Webhook-Weiterleiter **autorisiert** in Stufe 4, **schreibt** in Stufe 6 ·
Wächter **bewacht** No-Bypass auch für Writes (build-blocking) · RLS (Stufe 5) **ist** der unumgehbare Laufzeit-Backstop.

---

## Mandantenfähigkeit: RLS-Backstop (Stufe 5) *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-rls-stufe-5-v1.md`. Stufe 5 schaltet **PostgreSQL Row-Level-Security**
> als unumgehbaren Laufzeit-Backstop scharf — für **Lesen UND Schreiben**. App-Filter (Stufe 3) und
> [#107-Wächter](#) sind App-Logik und fehlbar; RLS greift, **selbst wenn beide versagen**. Baut auf
> Mandanten-Tür (Stufe 3/4) + effektivem Mandanten (Stufe 2) auf. **Vorbedingung:** Hotfix [#141](https://github.com/PatrickM-git/automatenlager/issues/141).

| Term | Definition | Aliases to avoid |
|---|---|---|
| **RLS-Backstop** | Die **datenbank-erzwungene** Mandanten-Trennung, die fremde Zeilen abweist, bevor sie die App erreichen — der unumgehbare Schutz **unterhalb** von App-Filter und Wächter. | „RLS = der Filter"; „Backstop" für App-Logik |
| **App-Rolle (`automatenlager_app`)** | Die eingeengte DB-Rolle für allen Dashboard-Verkehr: **kein** `BYPASSRLS`, **kein** Tabellen-Eigentum, voll RLS-unterworfen. | „die DB-Verbindung" pauschal; Owner-Rolle als App nutzen |
| **Infra-/`BYPASSRLS`-Verbindung** | Die separate, RLS-umgehende Verbindung **nur** für Bootstrap (Verzeichnis-Lookup), Migrationen und MatView-`REFRESH` — nie für normalen Mandantenverkehr. | „Admin-Connection" für App-Reads |
| **RLS-Sitzungsvariable / GUC (`automatenlager.current_tenant`)** | Der **transaktionslokal** gesetzte aktive Mandant, gegen den jede Policy prüft; gesetzt **nur** in der Mandanten-Tür. | `app.current_tenant`; session-weites `SET` |
| **`set_config(..., $1, true)`** | Die **einzige** erlaubte Form, den GUC zu setzen: parametrisiert (kein Injection-Korridor) + transaktionslokal (`true`). | string-interpoliertes `SET automatenlager.current_tenant = …` |
| **Einarmiges `current_setting`** | `current_setting('automatenlager.current_tenant')` (ohne 2. Argument) → fehlender GUC **wirft** (laut), statt still leer zu liefern. | zweiarmiges `current_setting(…, true)` im Normalpfad (NULL = stilles Leck) |
| **`USING` / `WITH CHECK`-Policy** | `USING` regelt **Sichtbarkeit** (Lesen/sehen welche Zeilen), `WITH CHECK` verbietet **Schreiben** einer Zeile in einen fremden Mandanten — beides nötig. | nur `USING` (lässt Cross-Tenant-Insert zu) |
| **`FORCE ROW LEVEL SECURITY`** | Zwingt RLS auch dem Tabelleneigentümer auf (Zusatzschutz); die **primäre** Absicherung ist aber, dass die App-Rolle **nicht** Eigentümer ist. | `FORCE` als alleinige Absicherung |
| **Vereinigungs-Policy** | Config-Sonderfall: Lesen erlaubt `<spalte> = current_tenant` **ODER** `= '__default__'`, Schreiben strikt nur `current_tenant` — hält die geteilte Vorlage sichtbar, ohne fremde Config zu zeigen. | naive `= current_tenant`-Policy (versteckt `__default__`) |
| **`security_barrier`-View** | Vorgelagerte View über eine MatView mit fest eingebautem GUC-Filter; die App-Rolle liest **nur** die View, nie die rohe MatView (die selbst keine RLS tragen kann). | rohe MatView der App-Rolle freigeben |
| **`security_invoker`-View** | Normale View (PG ≥ 15), die die Basistabellen-RLS unter der **abfragenden** Rolle auswertet statt unter dem View-Eigentümer. | View ohne `security_invoker` (läuft als Eigentümer ⇒ umgeht RLS) |
| **Henne-Ei-Bootstrap-Split** | Trennung: Login→Mandant-Auflösung läuft auf der Infra-Verbindung (kein GUC setzbar, **bevor** der Mandant feststeht), Mandantendaten auf dem App-Rollen-Pool. | Verzeichnis + Tür über **eine** Verbindung |
| **Gestaffelte Scharfschaltung** | Rollout je **Tabellengruppe** (`ENABLE`+`FORCE`+Gruppen-Smoke), nicht Big Bang — eine falsche Policy legt nicht alles gleichzeitig lahm. | „alle Tabellen in einer Migration scharf" |
| **`DISABLE-RLS`-Rollback (diszipliniert)** | Notausstieg: **nur** Infra-Rolle, auditiert, **temporär**, erzeugt Remediation-Aufgabe, **kein** zweiter Mandant währenddessen. | `DISABLE RLS` als stiller Dauer-Bypass |
| **n8n-Bypass-Korridor** | Bewusste Stufe-5-Grenze: n8n schreibt vorerst auf der Infra-/Bypass-Verbindung **außerhalb** des Backstops (Absicherung/Ablösung = Stufe 6) → **kein zweiter echter Kunde vor Stufe 6**. | Backstop als „systemweit dicht" verkaufen, solange n8n bypasst |

Beziehungen: App-Rolle **verbindet** mandanten-bewusst, ist RLS-unterworfen · Mandanten-Tür **setzt** je Transaktion den GUC (`set_config`) · Policy **prüft** `tenant_id = current_setting(...)` (`USING`+`WITH CHECK`) ·
fehlender GUC ⇒ **harter Fehler** (einarmig) · Infra-Verbindung **umgeht** RLS (`BYPASSRLS`) nur für Bootstrap/Migrationen/Refresh · `security_barrier`/`security_invoker`-View **dehnt** den Backstop auf (Mat)Views aus ·
RLS (Stufe 5) **ist** der Laufzeit-Backstop unter App-Filter (Stufe 3) + Wächter · n8n **bleibt** bis Stufe 6 außerhalb.

---

## Mandantenfähigkeit: n8n-Ablösung (Stufe 6) *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md` (gegen die **echten WF-JSONs + Dashboard-Code**
> verifiziert). Stufe 6 **ersetzt alle n8n-Workflows durch eigenen Backend-Code** und schaltet n8n ab; danach verliert
> `n8n_app` `BYPASSRLS` → der RLS-Backstop (Stufe 5) ist **erst jetzt** systemweit dicht. Baut auf Mandanten-Tür
> (Stufe 3/4) + RLS (Stufe 5) auf und ist Voraussetzung für die Cloud-Migration (Phase B).

| Term | Definition | Aliases to avoid |
|---|---|---|
| **n8n-Ablösung** | Vollständiger **Ersatz** aller n8n-Workflows durch eigenen, getesteten Backend-Code — nicht „n8n absichern/tenant-aware machen", sondern entfernen. | „n8n-Absicherung", „n8n-Härtung" |
| **RLS systemweit** | Endzustand: **kein** Schreibpfad umgeht mehr RLS — `n8n_app` verliert `BYPASSRLS`, ein Schreiben ohne GUC kracht. Hauptsicherheitsgewinn von Stufe 6; erst damit ist der Backstop lückenlos. | „RLS ist schon dicht" (gilt erst nach Stufe 6) |
| **Job-Modul (`lib/jobs/*`)** | Ein als **Deep Module** gekapselter Ex-Workflow mit kleiner Schnittstelle `(db, kontext, opts) → ergebnis`, **einzeln** aufrufbar (`node jobs/<name>.js`) **und** in-process; Vorbild `lib/alert-digest.js`. | „Skript", „n8n-Workflow im Code" |
| **Worker-Dienst** | Separater Prozess mit **`node-cron`** als eigener docker-compose-Service (`restart: always`, self-healing), getrennt vom Web-Prozess; ersetzt n8n als **Scheduler**; 1:1 nach Render (Background Worker / Cron Job) portierbar. | „Cron im Web-Prozess"; „n8n-Ersatz" pauschal |
| **Schattenbetrieb** | Cutover-Art für **datenkritische Ingestion** (WF3/WF1/WF2): der neue Job rechnet die beabsichtigten Writes parallel zu n8n und **vergleicht** (Compute-+-Compare), schreibt aber **nicht** — erst bei Deckungsgleichheit Cutover. | „parallel laufen lassen" (= Doppel-Schreiben) |
| **Trigger-Umlegung** | Cutover-Art für **benutzerausgelöste** Webhooks: das Dashboard ruft statt `fetch(n8n-Webhook)` direkt das In-Process-Modul auf (WF7/WF9); n8n-WF danach aus, Rückweg = Trigger zurücklegen. | „Webhook abschalten" |
| **Direkter Wechsel** | Cutover-Art für **idempotente/ableitbare** Prozesse (WF8/MatView-Refresh/Val/Monitor/Devices-Sync): portieren → Smoke → n8n-WF aus, kein Schatten nötig. | „einfach umstellen" pauschal |
| **WF-PGW / `pgw_write()`** | Der zentrale n8n-Schreib-**Durchreicher**: ein Sub-Workflow, der nur `automatenlager.pgw_write(event_type, batch_run_id, data jsonb)` aufruft — die echte Schreiblogik liegt in dieser **out-of-band DB-Funktion** (nicht im Repo). Wird im Abschluss stillgelegt. | „PostgreSQL Writer" als Black Box belassen |
| **Event-Typ (`event_type`)** | Diskriminator eines `pgw_write`-Aufrufs (u. a. `slot_assignment`, `stock_movement`, `invoice`/`invoice_item`, `guv_daily`, `warning`); jeder wird in Stufe 6 ein **typisierter Schreibpfad durch die Tür**. | „Payload-Typ" pauschal |
| **Lauf-Telemetrie (`audit.workflow_runs`)** | Die **bereits existierende** Tabelle (Start/Ende/Status/Fehler je Lauf, `workflow_key`), die der Worker künftig **schreibt** — Ersatz für n8ns internes `execution_entity`, das Monitoring/Konsistenz heute lesen. Ohne `tenant_id` (geteilte Pipeline-Telemetrie). | n8n `execution_entity` weiter als Quelle annehmen |
| **Disposition (PORT / MERGE / DROP)** | Einstufung jedes der 17 Workflows: **PORT** (neu als Job/Endpunkt), **MERGE** (Leseseite/Trigger existiert schon im Dashboard, nur Schreib-/Plan-Teil ergänzen), **DROP** (obsolet: WF0, WF-Update-Check, WF-Drift-Check). | „alle 17 werden 1:1 portiert" |
| **Pre-Flight-Dump** | Pflichtschritt vor dem Portieren: reale `pgw_write()`-Definition (`pg_get_functiondef`) + echte n8n-Trigger/Credentials aus der Mini-DB ziehen — gegen Realität bauen, nicht gegen Doku (Lehre aus Stufe 5). | „die SPEC/Doku reicht" |
| **Drive-Polling-Job** | Backend-Ersatz für n8ns `googleDriveTrigger` (WF1/WF9 ziehen PDFs aus Drive-Ordnern): ein Job pollt den Ordner, erhält das gewohnte „PDF ablegen". Upload-Endpunkt statt Drive = spätere, cloud-agnostischere Zukunft. | „Drive-Trigger" als Code-Begriff |

Beziehungen: n8n-Ablösung **ersetzt** alle Workflows durch Job-Module + Worker-Dienst + Trigger-Endpunkte · alle laufen **durch** die Mandanten-Tür
(per-Mandant GUC; mandantenübergreifende Pflege wie MatView-`REFRESH` über die Infra-/`BYPASSRLS`-Verbindung) · die **Cutover-Art** richtet sich nach Risiko:
Schattenbetrieb (datenkritisch) · Trigger-Umlegung (benutzerausgelöst) · direkter Wechsel (idempotent) · WF-PGW/`pgw_write()` **wird abgelöst** durch typisierte
Schreibpfade je Event-Typ · Worker **schreibt** Lauf-Telemetrie (Ersatz für `execution_entity`) · der Abschluss **entzieht** `n8n_app` `BYPASSRLS` ⇒ **RLS systemweit**
(+ #108 tenantColumn-Brücke/`__default__`-Abbau, + #111 globale Uniques → `ON CONFLICT (tenant_id, key)`).

---

## Cloud-Migration (3-Schichten) & Betriebsreife (Phase B + A3) *(neu)*

> Quelle: SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md` (gegen **echten Code** verifiziert).
> Inkrementeller Umzug Heim-Mini → Cloud; das cloud-agnostische Fundament (Mandanten-Tür, GUC, RLS,
> SQL-only) **zieht direkt mit** — der harte Teil ist die **Auth-Naht** und die **Plattform-Verkabelung**
> (Rollen-Abbildung, GUC-Vorregistrierung, Cron, flüchtiges FS). Setzt die n8n-Ablösung (Stufe 6) voraus.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **3-Schichten-Cloud** | Die Zielplattform: **Supabase** (Postgres + RLS + Auth) · **Render** (Backend + Jobs) · **Cloudflare** (Frontend + Domain). Eine Schicht je Anbieter. | „die Cloud" pauschal; Anbieter als Synonym der Schicht |
| **Auth-Naht** | Der Austausch des **Identitäts-Eingangs**: ein verifiziertes **Supabase-JWT** ersetzt den wegfallenden `Tailscale-User-Login`-Header — die **Mandanten-Tür und das RLS-Modell bleiben unverändert**, nur die Identitätsquelle wechselt. | „Auth neu bauen"; „Login-Umbau" (es ist nur der Eingang) |
| **Identitäts-Eingang** | Die eine Stelle, an der die Roh-Identität ins System kommt (heute Header, künftig JWT) und in einen `Viewer` mündet; davon getrennt bleibt die **Autorisierung** (Rollen/Fähigkeiten) und der **Datenzugriff** (RLS-Tür). | Identität und Autorisierung vermischen |
| **Rollen-Abbildung (Supabase)** | Der Stufe-5-Rollen-Split auf Supabase: **Infra-Pool** → RLS-umgehende Rolle (`service_role`-Äquivalent, da Custom-`BYPASSRLS` auf Supabase verboten ist) · **App-Pool** → `automatenlager_app`-Äquivalent (RLS-unterworfen). | „BYPASSRLS-Rolle anlegen" (geht auf Supabase nicht) |
| **GUC-Vorregistrierung** | Pflichtschritt auf Supabase: den Custom-GUC `automatenlager.current_tenant` als DB-Default vorregistrieren (`ALTER DATABASE … SET`), sonst wirft jede einarmige Policy `current_setting(...)` Fehler **42704**. **Fail-closed bleibt erhalten.** | „GUC funktioniert schon"; missing_ok als Workaround |
| **Gratis-Stufen-Cron** | Auslöser der Nachtjobs **ohne** Render-Cron (Gratis): geschützte Trigger-Endpunkte, angestoßen von **Supabase `pg_cron`** oder **Cloudflare Cron Trigger**. Die Job-Logik (`lib/jobs/*`) bleibt identisch — nur der **Auslöser** wird cloud-tauglich. | „Render-Cron" (auf Gratis nicht vorhanden) |
| **Flüchtiges Dateisystem** | Eigenschaft der Cloud-Container (Render): lokal geschriebene Dateien überleben einen Neustart **nicht** → **Audit-/Guest-Access-Log** und `.dashboard-config.json` müssen in die **DB/Env** wandern. | „Logdatei schreiben" wie auf dem Mini |
| **Off-Site-Backup** | Geplanter externer `pg_dump` der Supabase-DB **mit Alarm bei Fehler** (Resend/Sentry), Restore real geprobt — ersetzt das auf Gratis fehlende Supabase-Auto-Backup; löst das A3-Backup-Ziel cloud-nativ. | „Backup" pauschal; auf Supabase-Auto-Backup vertrauen (Gratis hat keins) |
| **Migrations-Slice (Cloud)** | Eine **einzeln deploybare, live-verifizierbare, rückwegsfähige** Stufe des Umzugs (Fundament/Domain → DB → Auth-Naht → Backend → Frontend → Betriebsreife/Cutover). Erbt das Slice-Prinzip aus Stufe 3–6. | „Big-Bang-Umzug"; „alles auf einmal" |
| **Rückfall-Option (Mini)** | Der Heim-Mini läuft **parallel** weiter, bis die Cloud verifiziert ist; Rollback je Slice = **DNS/Env zurückdrehen**. | „Mini sofort abschalten" |

Beziehungen: 3-Schichten-Cloud **trägt** das unveränderte cloud-agnostische Fundament · Auth-Naht **ersetzt** nur den
Identitäts-Eingang (Tür/RLS bleiben) · Rollen-Abbildung **reproduziert** den Infra-/App-Split ohne Custom-`BYPASSRLS` ·
GUC-Vorregistrierung **ist Vorbedingung**, sonst kracht jede Tür-Query (42704) · Gratis-Stufen-Cron **löst** dieselben
`lib/jobs/*` aus wie der Worker-Dienst · flüchtiges Dateisystem **zwingt** Audit-Log/Config in die DB · Off-Site-Backup
**ersetzt** das fehlende Auto-Backup · jede Migrations-Slice **ist** rückwegsfähig, solange die Rückfall-Option (Mini) steht.

---

## GuV-Kostenbasis & Besteuerungsmodell (Kleinunternehmer) *(neu)*

> Quelle: SPEC `docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md`. Das Besteuerungsmodell
> entscheidet, ob der Wareneinsatz **brutto** oder **netto** gebucht wird; eine Schlüssel-Schreibweise-Divergenz
> (camelCase vs. snake_case) hatte Live-Anzeige (brutto) und gebuchte Nacht-GuV (netto) auseinanderlaufen lassen.
> Reconciliation mit Cluster „Wirtschaftlichkeit": die dortige Aussage „`cost_of_goods` ist brutto" ist die
> **Soll-Semantik** für einen Kleinunternehmer — vom Bug auf netto gebrochen, von dieser SPEC (Restatement) wiederhergestellt.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Kleinunternehmer (§19 UStG)** | Betreiber, der **keine** USt auf den Umsatz erhebt → `revenue_net = revenue_gross`; zahlt aber USt auf Einkäufe **ohne** Vorsteuerabzug → Wareneinsatz **brutto**. | „umsatzsteuerbefreit" pauschal |
| **Regelbesteuert** | Betreiber **mit** Vorsteuerabzug → Wareneinsatz **netto** (gezahlte Vorsteuer wird erstattet, netto ist der echte Aufwand). | „normal besteuert" als Code-Begriff |
| **Kostenbasis (`cost_basis`)** | Spalte auf `guv_daily` (`netto`/`brutto`, nullable): **Faktum**, auf welcher Basis `cost_of_goods` der Zeile berechnet **ist** — getrennt von der Frage, welche Basis sie haben **soll**. | mit der Restatement-Entscheidung gleichsetzen |
| **Restatement** | In-place-Korrektur bereits gebuchter Netto-Zeilen auf brutto (`cost_of_goods × (1+Kategorie-MwSt/100)`, `gross_profit` neu, `revenue_net = revenue_gross`), **beleg-treu ohne** FIFO-Neulauf, auditiert + reversibel. | „neu berechnen", „FIFO-Recompute" |
| **Klassifizierung über NULL-Marker** | Altzeilen (`cost_basis IS NULL`) werden vor dem Restatement als `netto` eingestuft; restated wird **nur** `cost_basis = 'netto'`. Grundsatz: **Quelle hilft klassifizieren, `cost_basis` entscheidet das Restatement.** | nach `source` pauschal restaten |
| **Kategorie-Satz (kanonische MwSt-Quelle)** | Der Brutto-Aufschlag nutzt **überall** (Live, Nacht-GuV, Restatement) den Kategorie-MwSt aus `classification_settings` (Snack 7 / Getränk 19 / Fallback 19); `products.vat_rate_pct` (Legacy-Freitext) soll ihn nur **spiegeln** (Preflight-Reconciliation). | `vat_rate_pct` als zweite Wahrheit |
| **Nacht-GuV (`wf8_guv_aggregator`)** | Der per-Mandant-Job `lib/jobs/guv-aggregate.js` (vormals WF8, deaktiviert) — **einziger** Schreiber von `guv_daily`. | „WF8" als laufender Workflow |
| **`historic_backfill`** | Einmalig nachgetragene Vor-WF8-Zeit (Okt 2025 – 10.05.2026 = Steuerjahr 2025), netto gebucht, im GuV-Panel ausgeblendet (Sichtbarkeit = [#172](https://github.com/PatrickM-git/automatenlager/issues/172)). | „Altdaten" pauschal |
| **Live-/provisorische Posten** | Flüchtige „heute"-Berechnung in `economics.js`; schreibt **nie** nach `guv_daily` (rein Anzeige). Deshalb existieren **keine** persistierten Brutto-/Live-Zeilen. | „Live-Zeilen in guv_daily" |
| **Restatement-Logbuch (`audit.guv_restatement_log`)** | Audit-Tabelle je restateter Zeile mit `restatement_run_id` + Alt/Neu-Werten (`cost_of_goods`/`gross_profit`/`revenue_net`) + `vat_rate`/`factor` — Nachweis + exakter (Teil-)Rollback. | „Log" pauschal |

Beziehungen: Besteuerungsmodell (Kleinunternehmer/Regelbesteuert) **bestimmt** die Soll-Kostenbasis · `cost_basis` **markiert** die Ist-Basis je Zeile ·
Restatement **hebt** `cost_basis='netto'`-Zeilen eines Kleinunternehmer-Mandanten auf brutto **und** setzt `revenue_net = revenue_gross` · Kategorie-Satz **ist** die **eine** MwSt-Quelle für Live, Nacht-GuV und Restatement ·
Restatement-Logbuch **protokolliert** jede Änderung (rückwegsfähig) · Live-Posten **fließen nie** in `guv_daily` (kein Doppel-Brutto-Risiko).

---

## Anbieter-Integration: `provider` & Vending Data Integration Layer *(neu)*

> Nayax ist der **erste**, nicht der einzige Daten-Eingang. Stufe 0 nimmt nur die `provider`-Dimension mit;
> die volle anbieter-agnostische Schicht ist eine eigene spätere SPEC.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Anbieter (`provider`)** | Quelle der eingespeisten Vending-Daten (heute nur `'nayax'`, Default); Dimension auf `sales_transactions` und `nayax_devices`. | „Nayax" als Synonym für „Anbieter" |
| **Vending Data Integration Layer (VDIL)** | Zielbild einer anbieter-agnostischen Schicht, in die Nayax als erster Adapter mündet (volle Schicht = spätere SPEC). | — (Synonym „PPAL" nur informell) |
| **Geräte-Claiming** | Ein physisches Gerät gehört **genau einem** Mandanten — systemweite Eindeutigkeit `nayax_devices UNIQUE(provider, nayax_machine_id)`. | „Geräte-Zuordnung" (zu schwach) |
| **Externe Transaktions-ID (`external_transaction_id`)** | Anbieter-agnostischer Idempotenz-Schlüssel eines Verkaufs (verallgemeinert `nayax_transaction_id`), eindeutig je `(tenant_id, provider, external_transaction_id)`. | „Nayax-Transaktions-ID" als Code-Feld |

Beziehungen: Anbieter **speist** Verkäufe und Geräte ein · Gerät **gehört** genau einem Mandanten (Claiming) ·
Verkauf **ist eindeutig** je (Mandant, Anbieter, externe Transaktions-ID).

---

## Beispiel-Dialog (Branchen-Anker) *(neu)*

> **Dev:** „Der Kaugummi-Slot verkauft 12×/Woche, der Cola-Slot nur 4×. Ist Kaugummi der Renner?"
> **Domain Expert:** „Nein — wir messen **Deckungsbeitrag pro Slot/Woche**, nicht Stück. Cola macht
> mehr Marge pro Stück, also kann Cola trotz weniger Verkäufen der Renner sein."
> **Dev:** „Und wenn ein Slot unter der Latte liegt — automatisch Langsam-Dreher?"
> **Domain Expert:** „Nur wenn der EK hinterlegt ist. Ohne EK gibt's `ek_fehlt`, keine geratene Klasse.
> Und ein **Neuling** in der Schonfrist bleibt außen vor."
> **Dev:** „Woher kommt die Latte selbst?"
> **Domain Expert:** „Aus dem **Branchen-Anker** — Umsatz-Norm × Kategorie-Marge — nicht aus unseren
> eigenen schwachen Zahlen. Deshalb darf unser Automat ehrlich überwiegend Langsam-Dreher zeigen."

## Beispiel-Dialog (Mandantenfähigkeit) *(neu)*

> **Dev:** „Deine Firma hat zwei Eigentümer — sind das zwei Mandanten?"
> **Domain Expert:** „Nein. Ein **Mandant ist der Betrieb**, nicht die Person. Zwei Eigentümer sind zwei
> **Mitgliedschaften** im selben Mandanten, beide sehen alles."
> **Dev:** „Eine Charge liegt im Zentrallager — wie speichere ich den Ort?"
> **Domain Expert:** „Über `warehouse_id`, das aufs **Zentrallager** zeigt. Eine Charge ist **entweder** im
> Automaten **oder** im Lager — nie beides."
> **Dev:** „Ein Standort und ein Lager — ist das nicht dasselbe?"
> **Domain Expert:** „Nein. Der **Standort** ist, wo Automaten stehen; das **Lager** ist, wo Backstock liegt.
> Manchmal am selben Ort — dann hängt man das Lager optional an den Standort, muss man aber nicht."
> **Dev:** „Wenn ein Kunde Hilfe braucht, schaue ich einfach in seine Daten?"
> **Domain Expert:** „Nur über den **Notfall-Schlüssel** (`platform_admins`) — standardmäßig aus, jeder Zugriff
> protokolliert. Das ist keine normale Rolle, sondern bewusst der Ausnahmeweg."
> **Dev:** „Zwei Kunden haben denselben Nayax-Automaten in der Liste — erlaubt?"
> **Domain Expert:** „Nein, **Geräte-Claiming**: ein Gerät gehört genau einem Mandanten, systemweit eindeutig.
> Der zweite läuft in einen Konflikt."

## Beispiel-Dialog (Auth scharf) *(neu)*

> **Dev:** „Ich bin Plattform-Admin — sehe ich dann immer alle Kunden?"
> **Domain Expert:** „Nein. Standardmäßig bist du in deinem **Heimat-Mandanten**. Fremde Daten siehst du nur in
> einer **Support-Sitzung**, die du **pro Request** explizit über den Header `X-Support-Tenant` öffnest — und nur **lesend**."
> **Dev:** „Was, wenn ich den Header weglasse?"
> **Domain Expert:** „Dann bist du sofort wieder in deinem eigenen Mandanten. Die Sitzung **klebt nicht** — es gibt keinen dauerhaften Support-Modus."
> **Dev:** „Und wenn die DB beim Auflösen kurz weg ist — wird der Request dann dem Eigentümer zugeschlagen?"
> **Domain Expert:** „Niemals. **fail-closed**: technischer Fehler ⇒ `503`, kein Default-Mandant. Eine *unbekannte* Maschine ist was anderes — die gibt `null` und damit `404`."
> **Dev:** „Wie wird read-only erzwungen — blocke ich einfach POST?"
> **Domain Expert:** „Primär über **Capability-Stripping**: in der Support-Sitzung bleiben nur die Lese-Fähigkeiten, also liefern die bestehenden Guards bei Schreibzugriff automatisch `403`. Der Methoden-Block ist nur der zweite Riegel."

## Beispiel-Dialog (Query-Filter / Stufe 3) *(neu)*

> **Dev:** „Ich häng an jede Query ein `WHERE tenant_id = …` — reicht das?"
> **Domain Expert:** „Nein, genau das vergisst man unter 40 Modulen einmal. Alles geht durch **eine Mandanten-Tür**, und die **No-Bypass-Invariante** verbietet jeden direkten DB-Read außerhalb — der **Wächter** markiert ihn."
> **Dev:** „`SELECT SUM(revenue) FROM sales` ist doch nur eine Zahl, kein Leck?"
> **Domain Expert:** „Doch — ein **Aggregations-Leck**. Eine fremde Summe ist genauso schlimm wie fremde Einzelzeilen."
> **Dev:** „`machines` sind doch Stammdaten — die kann ich global lassen?"
> **Domain Expert:** „Nein, **mandantenpflichtig**. Global ist nur, was **keine** Kundendaten trägt — Verzeichnis und reine Lookups. Sobald Kundeninfo drin ist, wird gefiltert."
> **Dev:** „Die Alert-Mail läuft nachts ohne eingeloggten Nutzer — welchen Mandanten nimmt die?"
> **Domain Expert:** „Eine **explizite** Quelle, **pro Mandant** eine Mail — nie einen Default. Sonst mailt sie fremde Warnungen."
> **Dev:** „Und der Wächter — bleibt der eine Warnung?"
> **Domain Expert:** „Am Ende **build-blocking**: ein neuer ungefilterter Read bricht den Build."

## Beispiel-Dialog (Schreib-Isolation / Stufe 4) *(neu)*

> **Dev:** „Beim Speichern ohne Mandant gebe ich einfach `rowCount: 0` zurück, oder?"
> **Domain Expert:** „Nein — beim **Schreiben** ist das **fail-closed-werfend**. Sonst meldet der Endpunkt ‚gespeichert', obwohl nichts geschrieben wurde. Nur das **Lesen** darf leer zurückgeben."
> **Dev:** „Ich prüfe erst, ob der Standort dem Mandanten gehört, dann lege ich die Maschine an — zwei Queries."
> **Domain Expert:** „Pack beides in den **transaktionalen Schreib-Modus**. Sonst hast du die **Prüf-dann-Schreib-Lücke** — und genau diese Transaktion ist später der Platz für den RLS-Haken."
> **Dev:** „Onboarding bekommt eine `machine_id`? Dann nehme ich `requireMachineAccess`."
> **Domain Expert:** „Nein. Schau in die **Parent-Matrix**: Onboarding hängt am **`product_key`** → `products.tenant_id` über `requireObjectAccess`. Nur Refill und Slot-Assign sind Maschinen."
> **Dev:** „Der Client schickt `tenant_id` mit — praktisch, dann muss ich's nicht auflösen."
> **Domain Expert:** „Auf keinen Fall. **`tenant_id` im Body** ⇒ **400 + Audit**. Der Mandant kommt **immer** aus dem Viewer, nie aus dem Payload."
> **Dev:** „Der Refill-Endpunkt schreibt doch eh nur über n8n — den kann ich offen lassen?"
> **Domain Expert:** „Nein. Er ist ein **Webhook-Weiterleiter**: der Write ist Stufe 6, aber die **Autorisierung** ist Stufe 4 — sonst löst ein Mandant einen Refill auf einer fremden Maschine aus."

## Beispiel-Dialog (RLS-Backstop / Stufe 5) *(neu)*

> **Dev:** „Wir filtern doch schon überall nach `tenant_id` und haben den Wächter — wozu noch RLS?"
> **Domain Expert:** „Weil beides App-Logik ist und Lücken hat — wir haben gerade zwei ungefilterte Reads gefunden (#141). Der **RLS-Backstop** greift in der DB, **selbst wenn** Filter und Wächter versagen."
> **Dev:** „Dann setze ich den Mandanten einmal beim Verbinden per `SET`, das spart Arbeit."
> **Domain Expert:** „Auf keinen Fall — bei einem Pool **klebt** das an der Verbindung und der nächste Request liest mit deinem Mandanten weiter. Nur **`set_config(..., $1, true)`**, transaktionslokal, in der Tür."
> **Dev:** „Und wenn der Mandant mal nicht gesetzt ist — gibt's dann halt keine Zeilen?"
> **Domain Expert:** „Nein, **einarmiges `current_setting`** ⇒ es **kracht laut**. Ein stilles Leer sieht aus wie ein legitim leeres Ergebnis — den Bypass würdest du nie bemerken."
> **Dev:** „Schalte ich RLS dann einfach für alle Tabellen in einer Migration an?"
> **Domain Expert:** „Nein — **gestaffelt pro Gruppe** mit Smoke-Test, sonst legt eine falsche Policy das ganze Dashboard lahm. Und `automatenlager_app` darf die Tabellen **nicht besitzen**, sonst umgeht sie RLS sowieso."
> **Dev:** „Schreibt n8n dann auch durch RLS?"
> **Domain Expert:** „Nein, **n8n-Bypass-Korridor**: n8n bleibt bis Stufe 6 außerhalb, damit `FORCE RLS` die Produktion nicht bricht. Genau deshalb: **kein zweiter echter Kunde vor Stufe 6**."

## Beispiel-Dialog (n8n-Ablösung / Stufe 6) *(neu)*

> **Dev:** „Wir machen n8n einfach tenant-aware, dann ist der Bypass weg, oder?"
> **Domain Expert:** „Nein — Stufe 6 ist **n8n-Ablösung**, nicht -Absicherung. Wir ersetzen die Workflows durch **Job-Module** und einen **Worker-Dienst**; dann fällt n8ns Bypass ganz weg."
> **Dev:** „Dann porte ich alle 17 Workflows 1:1?"
> **Domain Expert:** „Nein, schau auf die **Disposition**. WF0, Update-Check und Drift-Check sind obsolet — **DROP**. WF5/WF7/WF4 haben ihre Leseseite/Trigger schon im Dashboard — **MERGE**. Nur der Rest wird echt **PORT**iert."
> **Dev:** „Den Nayax-Verkaufs-Import stell ich direkt um?"
> **Domain Expert:** „Auf keinen Fall direkt — datenkritisch. **Schattenbetrieb**: parallel rechnen und gegen n8n vergleichen, **ohne** zu schreiben, erst bei Deckungsgleichheit umschalten. **Direkter Wechsel** nur bei idempotenten Sachen wie dem MatView-Refresh."
> **Dev:** „Die eigentliche Schreiblogik kopier ich aus dem WF-PGW-JSON?"
> **Domain Expert:** „Die steht da nicht — WF-PGW ruft nur **`pgw_write()`** auf, eine DB-Funktion außerhalb des Repos. Erst **Pre-Flight-Dump** ziehen, sonst baust du gegen eine Doku-Annahme."
> **Dev:** „Woran sehe ich am Ende, dass es wirklich dicht ist?"
> **Domain Expert:** „`n8n_app` verliert **`BYPASSRLS`**, und ein Schreiben ohne gesetzte GUC **kracht**. Das ist der Nachweis **RLS systemweit** — der eigentliche Gewinn."

## Beispiel-Dialog (GuV-Kostenbasis / Kleinunternehmer) *(neu)*

> **Dev:** „Der Nayax-Umsatz ist 1,20 € — rechne ich die 7 % MwSt für den Netto-Umsatz raus?"
> **Domain Expert:** „Nein. Als **Kleinunternehmer** erheben wir keine USt — im Preis steckt keine. `revenue_net = revenue_gross`. Rausrechnen würde den Umsatz fälschlich kleinrechnen."
> **Dev:** „Und der Einkauf? In den Stammdaten steht netto."
> **Domain Expert:** „Auf die **Kosten** kommt die MwSt **drauf** (brutto), weil wir sie zahlen und nicht zurückbekommen: `cost_of_goods × (1 + Kategorie-MwSt/100)`. Nur die Kosten, nie der Umsatz."
> **Dev:** „Dann rechne ich alle gebuchten Zeilen × 1,07 — fertig?"
> **Domain Expert:** „Nicht nach Quelle pauschal. **Quelle hilft klassifizieren, `cost_basis` entscheidet.** Wir markieren erst jede Zeile, und das **Restatement** fasst nur `cost_basis='netto'` an — sonst wird's beim zweiten Lauf doppelt brutto."
> **Dev:** „Welchen MwSt-Satz nehme ich — den pro Produkt eingetragenen?"
> **Domain Expert:** „Den **Kategorie-Satz** (Snack 7, Getränk 19). Der pro-Produkt-`vat_rate_pct` soll ihn nur spiegeln; der Preflight vergleicht beide und meldet Abweichungen als nachzupflegende Altdaten."

## Beispiel-Dialog (Cloud-Migration / Phase B) *(neu)*

> **Dev:** „In der Cloud baue ich die ganze Auth neu — Login, Rollen, Mandantenzuordnung, oder?"
> **Domain Expert:** „Nein, nur die **Auth-Naht**. Es wechselt **allein der Identitäts-Eingang**: statt Tailscale-Header kommt ein verifiziertes **Supabase-JWT**. Die Mandanten-Tür, die Rollen und RLS bleiben **unverändert** — die Identität mündet wie heute in einen `Viewer`."
> **Dev:** „Dann lege ich `automatenlager_app` auf Supabase einfach mit `BYPASSRLS` für die Infra-Sachen an."
> **Domain Expert:** „Geht nicht — Custom-Rollen kriegen auf Supabase **kein** `BYPASSRLS`. **Rollen-Abbildung**: Infra-Pool auf das `service_role`-Äquivalent, App-Pool auf `automatenlager_app` **ohne** Bypass. Der Split bleibt, nur die Mittel ändern sich."
> **Dev:** „Ich migriere das Schema, starte die App gegen Supabase — und die erste Query liefert leer."
> **Domain Expert:** „Sie **kracht** sogar mit 42704 — du hast die **GUC-Vorregistrierung** vergessen. `automatenlager.current_tenant` muss als DB-Default gesetzt sein, sonst wirft jede einarmige Policy. Das ist Absicht: fail-closed, kein stilles Leck."
> **Dev:** „Die Nachtjobs hänge ich an Render-Cron."
> **Domain Expert:** „Auf der Gratis-Stufe gibt's keinen Render-Cron. **Gratis-Stufen-Cron**: `pg_cron` oder Cloudflare Cron stößt geschützte Trigger-Endpunkte an — die `lib/jobs/*` bleiben identisch, nur der Auslöser ist anders."
> **Dev:** „Das Guest-Access-Log schreibe ich wie bisher als JSONL-Datei."
> **Domain Expert:** „Nicht in der Cloud — **flüchtiges Dateisystem**. Beim nächsten Neustart ist die Datei weg, und die Anomalie-Erkennung liest ins Leere. Audit-Log und Config müssen in die **DB**. Und solange wir testen, bleibt der **Mini als Rückfall-Option** stehen."

## Markierte Unklarheiten *(neu)*

- **Cloud-Slice-Reihenfolge & Übergangs-Schalter** (Phase B): ob der Doppelpfad Tailscale-Header **oder** JWT
  per Env-Flag umschaltbar bleibt, bis alle Slices grün sind — Empfehlung: Flag, harter Stichtag erst nach Frontend-Cutover.
- **`service_role`-Nutzung für den Infra-Pool** (Phase B): ob der Infra-Pool wirklich `service_role` nutzt oder eine
  eigene erhöhte Rolle — in der Umsetzung gegen Supabases Rollenmodell fixieren; Bypass nur für Bootstrap/Migrationen/Refresh.
- **GUC-Vorregistrierung vs. Default-Wert** (Phase B): `ALTER DATABASE … SET automatenlager.current_tenant = ''`
  (leerer Default) muss mit dem **einarmigen** `current_setting` (fail-closed) verträglich bleiben — in der DB-Slice live verifizieren (leerer Mandant ⇒ keine Zeilen/Fehler).
- **Cron-Quelle** (Phase B): Supabase `pg_cron` vs. Cloudflare Cron Trigger für die Nachtjobs — in Slice 0 festlegen;
  Schutz der Trigger-Endpunkte über gemeinsames Secret in beiden Fällen.
- **Persistenzziel für Audit-/Guest-Access-Log** (Phase B): eigene Tabelle unter Schema `audit` vs. bestehende
  Telemetrie — Empfehlung: eigene `audit`-Tabelle, damit die Anomalie-Erkennung weiter eine Quelle hat.
- **Mini-Abschalt-Kriterium** (Phase B): wie viele saubere Cloud-Tage (Nachtjobs in `audit.workflow_runs`) vor der
  endgültigen Mini-Abschaltung — Empfehlung: mindestens ein voller Tag aller Nachtjobs grün, dann N Tage Parallelbetrieb.

- **Slot-Zahl pro Automat** für die Latten-Ableitung (Umsatz-Norm ÷ Slot-Zahl): Quelle aus den
  Stammdaten ist in der Umsetzung (TDD) zu fixieren — Empfehlung: aktive Slots je `machine_id`.
- **Persistenzort der Mandanten-Konfiguration** (Kategorien/Margen/Latten): DB-Tabelle vs. bestehende
  Settings-Datei — Empfehlung: DB-Tabelle mit `tenant_id`, konsistent zum Single-source-of-truth-Ziel.
- **Format der `tenant_id`** (opaker Slug vs. UUID): in der Schema-Migration (TDD) zu fixieren —
  Empfehlung: opake, **stabile** ID (unveränderlich), Anzeigename strikt getrennt.
- **Physische Umbenennung `nayax_transaction_id` → `external_transaction_id`:** in Stufe 1 optional,
  um heutige Schreiber (n8n) nicht sofort zu brechen — Zeitpunkt der Umbenennung festlegen.
- **Antwort auf nicht-berechtigten `X-Support-Tenant`** (Stufe 2): ignorieren-und-auditieren
  (proxy-resilient) vs. striktes `403` — SPEC empfiehlt ignorieren + `denied`-Audit; finale Wahl in der Umsetzung bestätigen.
- **Exakte Lese-Teilmenge für Capability-Stripping** (Stufe 2): welche der sechs Fähigkeiten als „lesen" gelten —
  in der Umsetzung (TDD) fixieren; Empfehlung: genau `betrieb.lesen` + `finanzen.lesen`.
- **Konkreter Modulname der Mandanten-Tür** (Stufe 3): z. B. `lib/tenant-db.js` — in der Umsetzung (TDD) festziehen.
- **Pool-Zentralisierung vs. eigener Slice** (Stufe 3): ob der geteilte DB-Pool Teil des Tür-Fundaments oder ein
  separater Schritt ist — Empfehlung: gemeinsam im Fundament-Slice (Tür bringt den Pool gleich mit).
- **Finale Liste der echt-globalen Tabellen** (Stufe 3): Default ist mandantenpflichtig; die Allowlist (Verzeichnis +
  reine Lookups) in der Umsetzung **explizit reviewen** und je Eintrag begründen.
- **Signatur des transaktionalen Schreib-Modus** (Stufe 4): z. B. `db.tx(viewer, async txDoor => {…})` —
  Schnittstelle in der Umsetzung (TDD) festziehen; Empfehlung: tür-gebundenes Objekt mit `read`+`write` in derselben Transaktion.
- **Onboarding-Parent: Produkt vs. Katalog-Kontext** (Stufe 4): ob `product_key` strikt über `products.tenant_id`
  oder über einen weiteren „erlaubten Katalog"-Kontext autorisiert wird — in der Umsetzung klären; Empfehlung: `products.tenant_id`, Katalog-Sonderfälle separat.
- **write-off-Parent-Auflösung** (Stufe 4): `batch_key` → Mandant der Charge; sicherstellen, dass `stock_batches`
  die `tenant_id` trägt und betroffene `warnings` mandanten-gebunden aufgelöst werden — in der Umsetzung bestätigen.
- **Fehlercode „Schreiben ohne Mandant"** (Stufe 4): 403 vs. 500 für den fail-closed-werfenden Fall — in der Umsetzung
  festlegen; Empfehlung: konsistent zur bestehenden Taxonomie (403 bei fehlender Berechtigung, 503 bei technischem Fehler).
- **Name der App-Rolle** (Stufe 5): `automatenlager_app` als Arbeitsname — finalen Rollennamen + Namenskonvention (z. B. zusätzliche `_readonly`-Rolle) in der Umsetzung festziehen.
- **Read als eigene Transaktion pro Aufruf vs. gebündelt** (Stufe 5): jeder Read öffnet eine eigene `BEGIN READ ONLY`-Transaktion — Pool-Auslastung (`max: 5`) gegen `EXPLAIN`/Lasttest prüfen; Empfehlung: pro-Aufruf-Transaktion, Poolgröße bei Bedarf nachziehen.
- **`security_invoker`-Verfügbarkeit** (Stufe 5): setzt PG ≥ 15 voraus — Mini-DB-Version vor dem Rollout explizit verifizieren (Deploy-Checkliste).
- **n8n-DB-Rolle Pre-Flight** (Stufe 5): die **tatsächliche** Rolle, mit der n8n verbindet, vor `FORCE RLS` verifizieren und bewusst auf die `BYPASSRLS`-Infra-Verbindung legen — sonst brechen WF3/WF7-Writes.
- **`tenant_id`-Index-Nutzung unter dem RLS-Prädikat** (Stufe 5): pro heißer Tabelle (`products`, `stock_batches`, `sales_transactions`, `slot_assignments`, `stock_movements`) gegen `EXPLAIN` gegenprüfen, statt den 0009-Index blind anzunehmen.
- **Exakte `event_type`-Liste + Zieltabellen/Konfliktschlüssel von `pgw_write()`** (Stufe 6): erst nach dem **Pre-Flight-Dump** verbindlich fixierbar — bis dahin Arbeitsannahme aus den WF-Vorbereitungs-Nodes (z. B. `slot_assignment`, `stock_movement`, `invoice`/`invoice_item`, `guv_daily`, `warning`).
- **Drive-Trigger-Ersatz** (Stufe 6): **Drive-Polling-Job** (Verhalten erhalten) vs. **Upload-Endpunkt** (cloud-agnostischer) — Empfehlung: Polling in Stufe 6, Upload-UI später (A4/Phase C).
- **WF4-Cutover-Art** (Stufe 6): benutzerausgelöst, aber datenkritisch (Slot-Autorität) — Empfehlung: **direkter Wechsel** mit starken Tests + Rückweg „Trigger zurück auf n8n" statt Schattenbetrieb; in der Umsetzung bestätigen.
- **E-Mail-Transport nach n8n** (Stufe 6): Gmail beibehalten vs. **Mailer-Modul** mit späterem Postmark/Brevo — Empfehlung: Versand in ein Mailer-Modul kapseln, Transport zunächst Gmail (Wechsel = ROADMAP A4).
- **Scheduling-Quelle des Workers** (Stufe 6): `node-cron`-Ausdrücke im Code (versioniert) vs. konfigurierbar — Empfehlung: im Code; pro-Mandant-Zeitpläne erst bei Bedarf (späterer Ausbau).
- **Verbleib von WF-Monitor/WF-Val** (Stufe 6): die n8n-spezifischen Teile (n8n-`execution_entity`-Checks, WF3-Neustart per n8n-API) **entfallen**; Container-/Heartbeat-/Backup-Checks bleiben und gehören perspektivisch in die Betriebsreife (ROADMAP A3) — Schnitt in der Umsetzung schärfen.

## Secret-Handling & Audit

- **Secret-Handling:** Zugangsdaten (z. B. n8n-API-Key) sind **nur mit `system.verwalten`**
  editierbar, gehen **nie im Klartext** an den Browser (immer maskiert, z. B. `••••gesetzt`),
  erscheinen **nie in Logs/Audit** und werden im Datenmodell **je Mandant** getrennt gehalten.
- **Audit-Trail:** Append-only-Protokoll **aller** privilegierten Aktionen (Workflow-Trigger,
  Nayax-Apply, Settings-/Schwellwert-Änderung, Rollenvergabe) inkl. **abgewiesener** Versuche
  (`403`) und interner-Pfad-Aufrufe. Erweitert das bisherige Gast-Zugriffs-Log (`auditGuestAccess`),
  das heute nur Gäste erfasst. *Zu vermeiden: „Logging" für diesen sicherheitsrelevanten Trail.*
