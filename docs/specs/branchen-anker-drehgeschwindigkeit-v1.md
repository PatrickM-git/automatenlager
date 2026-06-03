# SPEC: Branchen-Anker – absolute, kategoriebasierte Drehgeschwindigkeits-Klassifikation

Status: Entwurf · Erstellt 2026-06-03 · Bezug: Issue v3-H / #8 (Slow-Mover), #31 (editierbare Schwellwerte), #9 (v2-Abschaltung) · **Abhängig von #56 (Besteuerungsmodell → EK-Kostenbasis)** · Ablösung der relativen Quartil-Methode in `dashboard/lib/slow-mover.js`

---

## Problem Statement

Das Dashboard stuft jeden Slot heute als **Renner / Normal / Langsam-Dreher** ein – aber rein **relativ**: `dashboard/lib/slow-mover.js` schneidet die aktiven Slots eines Automaten nach Drehzahl (`turnover_count`, also reine **Stückzahl**) in Quartile. Das hat drei harte Schwächen:

1. **Relativ lügt.** Es gibt immer ein unterstes Viertel – also immer einen „Langsam-Dreher", selbst wenn der ganze Automat gut läuft. Umgekehrt wird in einem schwachen Automaten der „Beste unter Schlechten" zum Renner geadelt. Es fehlt eine **Messlatte von außen**.
2. **Stückzahl ist der falsche Maßstab.** Ein Energydrink (4×/Woche, hohe Marge) und ein Kaugummi (15×/Woche, Mini-Marge) sind nach Stück nicht vergleichbar. Was für den Betreiber zählt, ist nicht „wie oft dreht der Slot", sondern „**wie viel Geld bringt der Platz**".
3. **Hartcodiert und nicht mandantenfähig.** Die Schwellen (z. B. 30 Ladenhüter-Tage) stehen im Code. Zusätzlich existiert in `dashboard/lib/assortment-slots.js` eine **zweite, abweichende** hartcodierte Definition (`qty>=30 || turnover_count>=20` = Renner). Externe Kunden werden eigene Definitionen erwarten – das ist heute unmöglich.

Hinzu kommt ein latentes Datenrisiko: Die Produktkategorie (`produktart`: `getraenk` / `snack`) ist **nur in Google Sheets** gepflegt und fließt aktuell ausschließlich über den Sheet-gespeisten v2-Lesepfad (`dashboard/server.js`) ein – sie steht **nicht in der SQL-Datenbank**. Beim geplanten Abschalten der Sheets (Issue #9) ginge sie verloren.

## Solution

Die Drehgeschwindigkeits-Klasse wird auf einen **absoluten, kategoriebasierten und mandantenfähigen Maßstab** umgestellt:

- **Maßstab = Deckungsbeitrag (Marge) pro Slot pro Woche**, gemittelt über die **letzten 4 Wochen**, mit **Schonfrist für neue Produkte** (Default 14 Tage). Geld statt Stückzahl macht alle Preisklassen fair vergleichbar.
- **Branchen-Anker als Default-Latte:** Die Schwellen werden aus der **Branchennorm** abgeleitet (gut positionierter Automat ≈ 800 €/Monat Umsatz), heruntergerechnet auf €/Slot/Woche – **nicht** aus den eigenen (schwachen) Ist-Zahlen. Folge bewusst akzeptiert: Ein unterdurchschnittlicher Automat zeigt ehrlich überwiegend „Langsam-Dreher".
- **Kategorie-eigene Latten:** Pro Produktkategorie eine eigene Geld-Latte, abgeleitet aus *Umsatz-Norm pro Slot/Woche × kategoriespezifische Marge*. Startwerte aus der Branchenrecherche: **Getränke 43 %, Snacks 52 %, Default 50 %** (für neue/unbekannte Kategorien wie z. B. Spielzeug).
- **Ladenhüter bleibt ein eigenes, zeitbasiertes Signal** (0 Verkäufe seit ≥ X Tagen, Default 30) – unabhängig von der Marge. „Lohnt sich der Slot?" (Geld) und „Verrottet hier Kapital?" (Zeit) sind zwei getrennte Handlungssignale.
- **Fehlt der Einkaufspreis**, gibt es **keine geratene Klasse**, sondern eine eigene Klasse **„Bewertung nicht möglich – EK fehlt"** (Linie: Lücke sichtbar machen statt schätzen).
- **Editierbar & mandantenfähig:** Kategorien, Margen, Latten und Ladenhüter-Tage gehören zum Mandanten und sind unter `/einstellungen` editierbar. Defaults greifen ab Tag 1, sodass ein neuer Kunde **ohne Konfiguration sofort startklar** ist. Der Mandant kann **eigene Kategorien anlegen, Produkten zuordnen und Margen selbst setzen**.
- **`produktart` wird in die SQL-Datenbank übernommen** (echte Spalte + befüllende Sync-Strecke), damit die Kategorie die Sheets-Abschaltung überlebt. Single source of truth = SQL.

## User Stories

1. As an Automatenbetreiber, I want each slot classified by the money it earns per week (not by unit count), so that a high-margin drink and a low-margin gum are judged fairly.
2. As an Automatenbetreiber, I want the Renner/Langsam thresholds anchored to an external industry norm, so that a well-running machine is not forced to always show a "Langsam-Dreher".
3. As an Automatenbetreiber, I want my underperforming machine to honestly show mostly "Langsam-Dreher", so that I get a true to-do list instead of a flattering "all green".
4. As an Automatenbetreiber, I want each product category to have its own fair money threshold, so that structurally lower-margin categories (drinks as traffic drivers) are not unfairly punished.
5. As an Automatenbetreiber, I want the velocity classification averaged over the last 4 weeks, so that a single good or bad week does not flip a slot's classification.
6. As an Automatenbetreiber, I want newly listed products to be exempt from classification for a grace period (default 14 days), so that good products are not discarded before they had a chance.
7. As an Automatenbetreiber, I want "Ladenhüter" to remain a separate, time-based warning (0 sales since X days), so that dead capital and expiry risk are flagged independently from margin.
8. As an Automatenbetreiber, I want a slot with a missing purchase price (EK) to show "Bewertung nicht möglich – EK fehlt" instead of a guessed class, so that I see exactly where to maintain data and never trust a faked classification.
9. As an Automatenbetreiber, I want to edit thresholds, per-category margins and the Ladenhüter days under /einstellungen, so that I can adapt the anchor to my own reality.
10. As an Automatenbetreiber, I want sensible defaults (industry anchor + 43/52/50 % margins) to apply from day one, so that the system is useful immediately without configuration.
11. As an externer Kunde (Mandant), I want my own categories, margins and thresholds separate from other tenants, so that my definitions do not leak into or out of another operator's data.
12. As an externer Kunde (Mandant), I want to add my own product categories, assign products to them and set their margins, so that the system fits product ranges beyond drinks and snacks.
13. As an Automatenbetreiber, I want the product category (`produktart`) stored in the SQL database, so that turning off Google Sheets does not lose the categorization.
14. As an Automatenbetreiber, I want a single consistent definition of "Renner/Langsam-Dreher" across all views (Bestand, Sortiment, Einstellungen), so that the same slot is never labelled differently in two places.
15. As an Automatenbetreiber, I want the classification to be multi-machine aware (per machine_id), so that the definition scales to N machines without hardcoding one machine.

## Implementation Decisions

### Maßstab & Berechnung
- **Klassifikations-Kennzahl:** Deckungsbeitrag pro Slot pro Woche = (Verkaufte Menge im Fenster × (VK − EK auf der gültigen Kostenbasis)) / Wochen im Fenster, je Slot/Automat.
- **Zeitfenster:** rollierend 4 Wochen (28 Tage). Quelle der Verkäufe: `automatenlager.sales_transactions` (zeitgenau, von WF3 befüllt) bzw. die bestehende `v_slot_turnover`-Semantik, erweitert um ein Datumsfenster. EK über die bestehende EK-Semantik (`dashboard/lib/guv-ek.js`, `unit_cost_net`).
- **Verkaufspreis = tatsächlicher Transaktionspreis:** Der Deckungsbeitrag nutzt den **je Transaktion realisierten** Verkaufspreis aus `sales_transactions`, **nicht** den heutigen Produktpreis. Preisänderungen (`valid_from`/`valid_to`) im Fenster werden so korrekt berücksichtigt; eine spätere Preiserhöhung verfälscht die historische Marge nicht.
- **Netto-Konsistenz (verbindlich):** Die Kennzahl folgt strikt der bestehenden Netto-KPI-Semantik (KPI-Views ab Migration `0016`, vgl. Glossar „Wirtschaftlichkeit"). **Niemals** `gross_profit` direkt durch `revenue_net` teilen; kein Misch aus Brutto-Kosten und Netto-Umsatz.
- **Nur aktive, belegte Slots:** Klassifiziert werden ausschließlich Slots mit `active = TRUE` und zugeordnetem Produkt. Inaktive/leere Slots (Geisterbestand) sind ausgeschlossen — konsistent zum bestehenden Invarianten-Guard (`dashboard/tests/dashboard-inactive-slot-stock-invariant.test.js`).

### Abhängigkeit: EK-Kostenbasis (Issue #56)
- Der Deckungsbeitrag hängt von der **gültigen EK-Kostenbasis** ab, die **Issue #56 (Besteuerungsmodell: Kleinunternehmer vs. regelbesteuert)** festlegt. Bei einem **Kleinunternehmer** ohne Vorsteuerabzug ist der reale Einkaufspreis **brutto**, bei Regelbesteuerung **netto** — das verschiebt die gesamte Renner/Langsam-Einordnung.
- Festlegung: Der Branchen-Anker **konsumiert** die in #56 bestimmte Kostenbasis (eine Quelle), rechnet sie **nicht** selbst neu. Ist #56 noch nicht umgesetzt, gilt die heutige Netto-Annahme als Übergang, klar dokumentiert.
- **Schonfrist Neulinge:** Slots, deren Produkt seit weniger als `graceDays` (Default 14) gelistet ist, werden als `neu` markiert und nicht in Renner/Langsam einsortiert (eigene neutrale Klasse oder Ausschluss aus der Quartil-/Schwellen-Logik).
- **Latten-Ableitung (Branchen-Anker):** Pro Kategorie: erwarteter Deckungsbeitrag/Slot/Woche = (Umsatz-Norm €/Automat/Monat ÷ Slot-Zahl ÷ 4{,}33 Wochen) × Kategorie-Marge. Daraus zwei Schnittpunkte je Kategorie (untere Grenze → Langsam-Dreher, obere Grenze → Renner). Konkrete Default-Faktoren (z. B. Norm 800 €, Faktor für „Renner ab" / „Langsam unter") werden im Default-Konfig-Objekt hinterlegt und sind editierbar.

### Klassen
- `renner`, `normal`, `langsam_dreher` (geldbasiert), `ladenhueter` (zeitbasiert, Vorrang vor den Geld-Klassen), `ek_fehlt` (neutral, keine Bewertung), optional `neu` (Schonfrist). Das Frontend interpretiert nur die gelieferte `turnover_class` als Badge.

### Module
- **`dashboard/lib/slow-mover.js` (Kernumbau, Deep Module):** Reine Funktion `classifyTurnover(slots, config)` bleibt die einzige Wahrheit, wird aber von Quartil auf **absolute, kategoriebasierte Schwellen** umgestellt. Eingabe je Slot um `category`, `margin_per_week` (oder Rohdaten zur Berechnung) und `listedDays` erweitert. `config` trägt pro Kategorie die Latten + globale Defaults (graceDays, ladenhueterDays). Gibt `turnover_class` zurück. DB-frei und testbar.
- **`dashboard/lib/assortment-slots.js`:** Die **zweite, hartcodierte** Renner/Langsam-Definition (`qty>=30 || turnover_count>=20`) wird entfernt und durch die Klasse aus `slow-mover.js` ersetzt → eine einzige Definition. SQL erweitert um Deckungsbeitrag-Bausteine (Verkäufe im 4-Wochen-Fenster + EK-Join) und `produktart`.
- **Settings-Schicht:** `dashboard/lib/` erhält ein Modul, das die mandantenspezifische Konfiguration (Kategorien, Margen, Latten, graceDays, ladenhueterDays) liest/schreibt und mit Defaults auffüllt. Anbindung an die bestehenden Endpunkte `/api/v2/settings/definitions` (GET, heute read-only) + neuen Schreibpfad (Bezug Issue #31).
- **Frontend:** `/lager` und `/einstellungen` (v3) zeigen die neuen Klassen-Badges bzw. die Editierfelder. Strikt bestehende v3-Optik (Tokens/Badges) wiederverwenden, Vanilla-JS, Logik in `lib/`.

### Schema & Daten
- **Neue/erweiterte Tabelle für Produktkategorie:** `produktart` (bzw. `category_key`) wird echte Spalte der `products`-/Produkt-Slot-Struktur in PostgreSQL und über die Sync-Strecke aus Sheets befüllt (solange Sheets noch Eingabekanal ist). Werte initial `getraenk`, `snack`; erweiterbar.
- **Kategorie-Stammdaten pro Mandant:** Tabelle/Struktur `categories` (key, label, margin_pct, mandant-Bezug) – erlaubt mandanteneigene Kategorien + Margen. Default-Seed: getraenk 43 %, snack 52 %, Fallback 50 %.
- **Schwellwert-Konfiguration pro Mandant:** Latten je Kategorie, graceDays, ladenhueterDays, Umsatz-Norm – persistiert, mit Default-Fallback.

### Mandantenfähigkeit (Konstruktions-Spalt, nicht Voll-Tenancy)
- Es existiert heute **kein** Mandanten-Konzept im Code. Diese SPEC baut **keine** vollständige Tenancy, legt aber alle neuen Strukturen (Kategorien, Margen, Latten) **parametrisch über eine `mandant_id`/`tenant`-Dimension** an, sodass echte Mandantenfähigkeit additiv andocken kann. `machine_id` bleibt durchgängig parametrisch (N Automaten).

### Defaults / Onboarding
- Alle Defaults (Branchen-Latte, 43/52/50 %, 28-Tage-Fenster, 14-Tage-Schonfrist, 30-Tage-Ladenhüter) sind so vorbelegt, dass ein neuer Mandant ohne jede Konfiguration sinnvolle Klassen sieht.

## Testing Decisions

- **Gute Tests prüfen externes Verhalten, nicht Implementierungsdetails:** Eingabe = Liste von Slots (mit Kategorie, Marge/Rohdaten, listedDays, daysSinceLastSale) + Config; Ausgabe = `turnover_class` je Slot. Keine Tests gegen Quartil-Interna.
- **`slow-mover.js` (Kern):** Unit-Tests analog zu `dashboard/tests/dashboard-v3-slow-mover.test.js` / `dashboard-v3-turnover-badges.test.js`:
  - Geldbasierte Einordnung: Drink mit wenig Stück aber hoher Marge wird Renner, Kaugummi mit viel Stück aber Mini-Marge nicht.
  - Kategorie-eigene Latten: gleicher €/Woche-Wert fällt je Kategorie in unterschiedliche Klassen.
  - Schonfrist: neues Produkt (< graceDays) wird nie Langsam-Dreher.
  - Ladenhüter hat Vorrang vor Geld-Klassen.
  - Fehlender EK → `ek_fehlt`, niemals geratene Klasse.
  - Default-Config ohne Mandant-Override liefert sinnvolle Klassen (Onboarding).
- **`assortment-slots.js`:** Vertragstest, dass nur **eine** Definition wirkt (kein abweichendes `qty>=30`-Badge mehr) und dass `produktart` durchgereicht wird.
- **Settings/Mandant:** Test, dass Override-Werte greifen und ohne Override auf Defaults zurückgefallen wird; dass Mandant-A-Werte nicht in Mandant-B sichtbar sind (Isolations-Vertrag, sobald `mandant_id` getragen wird).
- **Schema-/Sync-Vertrag:** Guard analog zur bestehenden Schema-Contract-Linie (`dashboard/lib/db-schema.js`), dass `produktart` in der DB existiert und gefüllt wird (kein Sheet-only-Feld mehr).

## Out of Scope

- **Vollständige Multi-Tenancy** (Auth, Mandantentrennung auf Datenebene, Onboarding-Flow) – hier nur als Konstruktions-Spalt vorbereitet.
- **Pro-Automat-Override-UI** für Latten – im Datenmodell vorgesehen, aber keine Bedien-Oberfläche in dieser Phase.
- **Relative/Quartil-Sicht als Zusatzsignal** („überdurchschnittlich für diesen Automaten") – bewusst nicht, Maßstab ist absolut.
- **Automatische Nachkalibrierung** der Branchen-Latte aus Live-Daten.
- **Vollständigkeits-Audit Sheets→DB** (alle weiteren Sheet-Spalten, die noch nicht in der DB stehen) – eigenes, separates Issue (knüpft an `docs/specs/sql-only-migration.md` + Issue #9 an). Diese SPEC schließt nur die `produktart`-Lücke.

## Further Notes

- **Umsatz vs. Marge bewusst getrennt:** Die Branchennorm liegt in **Umsatz** (≈ 800–1200 €/Automat/Monat, BDV-Blend über alle Standorte ≈ 330 €/Monat). Klassifiziert wird in **Marge**; die Umsatz-Norm dient nur als Quelle der Default-Latte (× Kategorie-Marge). Die Margen-Annahme ist sichtbar und editierbar.
- **Branchenrecherche (2026-06-03):** Vending-Rohmarge gesamt 40–60 %; Snacks/Salziges ~55 %, Süßwaren ~46–53 %, Kaugummi ~47 %, Getränke/Energy ~43 %, Healthy/Premium bis +25 %. Quellen: VMFS USA, widermatrix, Bicom Vending (DE), BDV e.V.
- **Bestehende Bausteine wiederverwenden:** `guv-ek.js` (netto-EK), `sales_transactions` (zeitgenaue Verkäufe), `v_slot_turnover` (Slot-Umschlag), `economics.js`/`economics-live.js` (Zeitfenster-Muster).
- **Datenstand:** Backup `guv_check_tmp/backup_2026-05-13.../Produkte.csv` zeigt `produktart` mit 12× `getraenk`, 36× `snack`.
