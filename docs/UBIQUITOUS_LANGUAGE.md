# Ubiquitous Language — Domänen-Glossar

Verbindlicher Wortschatz für Backend, Frontend und Doku des Automatenlager-Systems.
Wenn ein Begriff hier steht, wird er überall **gleich** verwendet (Code-Bezeichner,
UI-Labels, Workflow-Namen, Commit-Messages). Neue Begriffe werden hier ergänzt,
bevor sie sich im Code verteilen.

> Angelegt im Rahmen von Phase „Dashboard v3 Multipage" (Issue v3-H / #8). Quelle
> der Slow-Mover-Definitionen ist `dashboard/lib/slow-mover.js` (`SLOW_MOVER`); die
> Werte hier müssen damit übereinstimmen und werden unter `/einstellungen` angezeigt.

---

## Umschlag / Drehzahl (Slow-Mover-Klassifikation)

**Drehzahl** = wie schnell sich ein Produkt **pro Slot/Automat** verkauft (nicht
global pro Produkt). Kennzahl ist die Verkaufsmenge je Slot über das betrachtete
Fenster (`turnover` / `turnover_count`, gespeist aus `automatenlager.v_slot_turnover`).

Die Klassifikation ist **quartilbasiert** über die aktiven Slots:

| Klasse (`key`) | Label | Definition |
|---|---|---|
| `renner` | **Renner** | Oberstes Quartil der Drehzahl (`turnover ≥ Q3`). Verkauft sich am schnellsten. |
| `normal` | **Normal** | Mittlerer Bereich zwischen unterem und oberem Quartil (`Q1 < turnover < Q3`). |
| `langsam_dreher` | **Langsam-Dreher** | Unterstes Quartil (`turnover ≤ Q1`). Dreht langsam — beobachten. |
| `ladenhueter` | **Ladenhüter** | **0 Verkäufe seit ≥ 30 Tagen** — totes Kapital + MHD-Risiko. Gilt **unabhängig** von der Quartilseinordnung (Override). |

Festlegungen:

- **Granularität:** pro Slot/Automat, nicht pro Produkt.
- **Quartile:** lineare Interpolation (25 %/75 %) über die Drehzahl der *aktiven*
  Slots (Ladenhüter zählen nicht in die Quartilsbasis).
- **Ladenhüter-Schwelle:** `ladenhueterDays = 30`. Grenzfall **genau 30 Tage** zählt
  bereits als Ladenhüter (`≥`). Ein nie verkaufter Slot ist ebenfalls Ladenhüter.
- **Zu wenige Datenpunkte:** unter `minPointsForQuartiles = 4` aktiven Slots (oder
  ohne Streuung, `Q1 = Q3`) sind Quartile nicht aussagekräftig → alle `normal`.
- Die Klassifikationslogik liegt im Backend (`classifyTurnover`); das Frontend
  zeigt nur die gelieferte Klasse als **Badge**.

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
