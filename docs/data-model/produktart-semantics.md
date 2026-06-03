# Produktart (Produktkategorie) — Datenmodell

Bezug: Issue #62 · SPEC `docs/specs/branchen-anker-drehgeschwindigkeit-v1.md` · Glossar-Begriff „Kategorie-Marge".

## Kanonische Quelle: `automatenlager.products.category`

Die Produktkategorie (umgangssprachlich **produktart**: `getraenk`, `snack`, erweiterbar)
ist eine **echte Spalte** in PostgreSQL: `automatenlager.products.category` (Typ `text`).
Sie ist die **single source of truth** und überlebt die Abschaltung der Google Sheets (Issue #9).

Historisch war die produktart nur in Google Sheets gepflegt und floss ausschließlich
über den Sheet-Lesepfad (`server.js`, v2) ein. Die DB-Spalte existierte bereits, war
aber nicht vertraglich abgesichert und enthielt eine Casing-Drift (`Snack` vs. `snack`).

## Regeln (vertraglich abgesichert, `tests/dashboard-produktart-contract.test.js`)

1. **Existenz:** `products.category` existiert als Spalte.
2. **Vollständigkeit:** Jedes Produkt hat eine produktart (kein `NULL`/leer).
3. **Kanonische Form:** Werte sind **lowercase + getrimmt** — keine Casing-Drift
   (`"Snack"` und `"snack"` dürfen nicht als zwei Kategorien auseinanderlaufen).

## Schreibpfade (Sync-Strecke)

- **WF2** (Smart Product Selection) legt neue Produkte an und setzt `category` (Default
  `'snack'`, kanonisch lowercase — vormals fälschlich `'Snack'`). Die feinere
  Zuordnung (Getränk vs. Snack) wird über die Sheets-Pflege bzw. künftig unter
  `/einstellungen` (Issue #66) gesetzt und in die DB synchronisiert.
- Bis zur vollständigen Sheets-Abschaltung bleibt die Sheets-Spalte ein Eingabekanal;
  Ziel ist `products.category` als alleinige Quelle.

## Verbindung zu Kategorie-Stammdaten (Issue #63)

`products.category` trägt den **Kategorie-Schlüssel** (`category_key`). Die Kategorie-
Stammdaten (Label, Marge, Latten) je Mandant liegen in der Kategorie-/Schwellwert-
Konfiguration (Issue #63). Der Schlüssel verbindet Produkt → Kategorie-Marge für die
geldbasierte Drehgeschwindigkeits-Klassifikation (Issue #64).
