# EK-Semantik: `unit_cost` / `unit_cost_net` ist NETTO

Issue #51. Diese Datei legt die **eine** systemweite Bedeutung des Einkaufspreises fest.

## Definition

Der Wert in der Google-Sheet-Spalte `Lagerchargen.unit_cost` und in der DB-Spalte
`stock_batches.unit_cost_net` ist der **Netto-Stückpreis** (Einkaufspreis pro
Verkaufseinheit, ohne Mehrwertsteuer). Die MwSt steht separat in `mwst_satz`.

Daraus abgeleitet (kanonisch in [`dashboard/lib/guv-ek.js`](../../dashboard/lib/guv-ek.js)):

| Größe | Formel |
|---|---|
| `ek_preis_netto` | `unit_cost` (direkt) |
| `ek_preis_brutto` | `unit_cost * (1 + mwst_satz/100)` |
| Wareneinsatz / `cost_of_goods` | `menge * unit_cost` (Netto-Basis) |

## Beleg (AC1)

Lieferanten-Rechnung vom **20.05.2026** (Drive `1gJiGZ…`). Die Rechnung weist die
Stückpreise **netto** aus:

- Summe der Zeilenpreise = `NETTO-WARENWERT` (101,16 €); erst darunter wird MwSt
  addiert (`+ 13,73 € = 114,89 € SUMME EUR`). Die Zeilen-/Stückpreise stehen also
  **vor** Steuer.
- Beispiel **Snickers** (Steuergruppe B = 7 %): `EINZEL PREIS 0,520`, nach
  Mengenrabatt `STÜCK INT KD PREIS = 0,480`. Genau diese **0,48** stehen im Sheet
  als `unit_cost` → bestätigt netto.
- Beispiel **Cola Zero** (Steuergruppe A = 19 %): Netto-Stückpreis `0,580`.

> Merkhilfe: Der **bezahlte** Rechnungsbetrag (114,89 €) ist brutto, die
> **Stückpreise** auf der Rechnung sind netto. Das frühere WF8-Verhalten (Stückpreis
> als brutto interpretieren und `/(1+mwst)` rechnen) war daher falsch.

## Verbraucher und Status

| Stelle | Behandlung vor #51 | nach #51 |
|---|---|---|
| WF1 (Rechnungssummen) | netto (addiert MwSt für `totalGross`) | unverändert korrekt |
| WF2 → `stock_batches.unit_cost_net` | netto (`unit_cost_net = unit_cost`) | unverändert korrekt |
| `economics.js` (Live-FIFO) | netto (`cost = menge * unit_cost_net`) | unverändert korrekt; per Test gelockt |
| **WF8** „Code - GuV aggregieren" | **brutto** (Bug) | **netto** — siehe unten |

### WF8-Korrektur

Vorher (fehlerhaft): `ekBrutto = unit_cost`, `ekNetto = ekBrutto / (1 + mwst/100)`.

Nachher: `ekNetto = unit_cost`, `ekBrutto = ekNetto * (1 + mwst/100)`,
`warenein = menge * ekNetto`.

Der gebuchte Wareneinsatz `warenein` bleibt **wertgleich** (`menge * unit_cost`),
nur die abgeleiteten Felder `ek_preis_netto` / `ek_preis_brutto` werden korrekt.

## Auswirkung auf historische `guv_daily` (AC5)

- **`cost_of_goods` und `gross_profit` ändern sich NICHT.** WF8 buchte den
  Wareneinsatz schon vorher als `menge * unit_cost` (empirisch: Snickers
  `cost_of_goods/menge = 0,48`, also der Wert as-is). Die Korrektur lässt diesen
  Buchwert unverändert → **kein Recompute/Backfill von `guv_daily` nötig.**
- Was sich ändert: die von WF8 in die **GuV-Sheet-Zeilen** geschriebenen Felder
  `ek_preis_netto` (war zu niedrig: nochmals durch MwSt geteilt) und `ek_preis_brutto`
  (war = Netto-Wert). Künftige Läufe schreiben sie korrekt.
- Historische GuV-Sheet-Zeilen tragen weiterhin die alten (falschen) `ek_preis_*`-
  Werte. Ein Nachziehen ist rein kosmetisch (DB-Kennzahlen unberührt) und damit
  **out of scope** / nur nach expliziter Freigabe.

## Kostenbasis vs. Besteuerungsmodell (Kleinunternehmer) — geplant, nicht Teil von #51

Die `unit_cost`-Semantik (netto) ist unabhängig vom Besteuerungsmodell. **Welcher**
EK-Wert aber als *echte Kosten* in `cost_of_goods`/Marge gehört, hängt vom
Status ab:

| Status | Vorsteuerabzug | wirtschaftlicher Wareneinsatz |
|---|---|---|
| Kleinunternehmer (§19 UStG) | nein | **brutto** (`ek_preis_brutto`) — gezahlte MwSt ist echte Kosten |
| Regelbesteuert | ja | **netto** (`ek_preis_netto`) — Vorsteuer wird erstattet |

Auf der **Umsatzseite** ist das bereits umgesetzt: WF8 liest `kleinunternehmer_aktiv`
und setzt dann `revenue_net = revenue_gross` (keine MwSt auf den Verkauf).

Auf der **Einkaufsseite** bucht das System aktuell `cost_of_goods` immer netto.
Für einen Kleinunternehmer ist der Wareneinsatz dadurch zu niedrig / die Marge zu
hoch. Geplant (eigenes Issue/SPEC, relevant für die Mandantenfähigkeit beim
Software-Verkauf): ein **klar einstellbares Besteuerungsmodell pro Mandant**, das
steuert, ob `ek_preis_netto` oder `ek_preis_brutto` in `cost_of_goods` fließt.
`guv-ek.js` liefert beide Werte bereits.

## Offener Folgepunkt (nicht Teil von #51)

Der WF1-Extraktions-Prompt fordert aktuell „Netto- **oder** Brutto-Einzelpreis,
wenn eindeutig erkennbar". Das ist mehrdeutig und kann künftig gemischte Daten
erzeugen. Empfehlung: Prompt eindeutig auf **netto** festlegen (falls nur brutto
auf der Rechnung steht → `/(1+mwst)` umrechnen). Eigenes Issue.
