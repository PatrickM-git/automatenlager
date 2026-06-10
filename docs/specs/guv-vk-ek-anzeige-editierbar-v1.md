# SPEC — G&V-Tabelle: VK/EK pro Stück anzeigen + editierbar (v1, #193)

> Status: in Umsetzung. Quelle: Issue #193. Gegen den echten Code/DB-Stand verifiziert
> (economics.js, guv_daily, stock_batches, prices). Finanz-Kontext:
> `docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md`.

## Problem
Die G&V-Tabelle zeigt Umsatz/Marge, aber **nicht VK/EK pro Stück**. Falsche Stammdaten
(z. B. EK-Platzhalter) bleiben unsichtbar. Konkret verifiziert: Lichtenauer **Still** und
**Medium** trugen auf den alten (leeren) Chargen **beide exakt `0.8782`** (Import-Platzhalter
02.05.) → unplausible historische Marge. Die **aktuellen** aktiven Chargen sind korrekt
(Still `0.7140` < Medium `0.9057`). Sichtbares + editierbares VK/EK macht solche
Daten­qualitäts-Fehler sofort erkenn- und korrigierbar.

## Lösung
1. **Anzeige (read-only, risikolos):** je G&V-Produktzeile zusätzlich **VK/Stück** und
   **EK/Stück**, abgeleitet aus den bereits aggregierten `guv_daily`-Werten der Zeile:
   - `vk_per_unit = revenue_gross / quantity_sold`
   - `ek_per_unit = cost_of_goods / quantity_sold`
   Das spiegelt exakt die **gebuchte** GuV (nicht eine separate Preis-Quelle) und hätte den
   `0.8782`-Platzhalter unmittelbar gezeigt. `qty = 0` ⇒ `null` (kein Division-durch-0).
2. **Editierbar (Admin, go-forward):** Korrektur der Stammdaten **durch die Mandanten-Tür**
   (`db.tx`, explizites `tenant_id`, RLS-sauber, Audit-JSONL) — KEIN Direkt-Write:
   - **EK:** `UPDATE stock_batches SET unit_cost_net = $neu` für die **aktive** Charge des
     Produkts (verfügbarer Status, jüngste). Das ist die Daten­qualitäts-Korrektur.
   - **VK:** `UPDATE prices SET sale_price_gross = $neu` für die **aktive** Zeile
     (`valid_to IS NULL`) des Slots.
   - **Wirkung: go-forward** (AC-sanktioniert). Künftige GuV-Aggregate/Anzeigen nutzen den
     korrigierten Wert; bereits gebuchte `guv_daily`-Zeilen bleiben unverändert (historisches
     Restatement ist bewusst getrennt — vgl. #175–#180). Klar dokumentiert + auditiert.

## Schnittstelle
- Read: `parseProductRow` (economics.js) ergänzt `vk_per_unit`, `ek_per_unit` (rein abgeleitet).
- Edit (rein + I/O) `lib/economics-correct.js`:
  - `validateCorrection({ field, value, productKey|slotKey })` → Fehlerliste (field ∈ {ek,vk}, value > 0).
  - `applyEkCorrection(db, tenant, { productKey, unitCostNet })` → `db.tx`, UPDATE aktive Charge.
  - `applyVkCorrection(db, tenant, { slotKey, salePriceGross })` → `db.tx`, UPDATE aktive Preiszeile.
- Endpunkte (admin-only, `canTriggerActions`, `rejectBodyTenant`, Audit):
  `POST /api/v2/economics/correct-ek` `{ product_key, unit_cost_net }`,
  `POST /api/v2/economics/correct-vk` `{ slot_key, sale_price_gross }`.
- Frontend (v3.js): Spalten **VK/Stk** + **EK/Stk** in der G&V-Produkttabelle; Admin: Zelle
  editierbar (Klick → Eingabe → POST → Reload). Gäste: nur Anzeige.

## Tests
- Rein: `vk_per_unit`/`ek_per_unit`-Ableitung (inkl. qty=0 ⇒ null); `validateCorrection`.
- Live durch die Tür (acme/globex, nicht-vakuös): `applyEkCorrection` ändert NUR die aktive
  Charge des eigenen Mandanten; globex unberührt. Analog `applyVkCorrection`.
- qa-browser: Spalten sichtbar; Admin-Edit speichert + spiegelt sich.

## Out of Scope
- Historisches `guv_daily`-Restatement nach EK/VK-Korrektur (getrennt; #175–#180-Mechanik).
- Vollständige Mandanten-Admin-Stammdaten-UI = **Stufe 8**.
- Mehrfach-Chargen-Strategie (welche Charge bei mehreren aktiven): v1 nimmt die jüngste aktive.
