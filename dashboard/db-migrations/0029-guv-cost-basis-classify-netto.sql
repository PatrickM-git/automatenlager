-- Migration 0029: Bestands-NULL-Zeilen beweisgestützt als 'netto' klassifizieren (Issue #179)
-- SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
--       §"cost_basis-Marker & Klassifizierung (Idempotenz über den NULL-Marker)"
--
-- ERSTE Datenmutation auf guv_daily. Setzt AUSSCHLIESSLICH eindeutig als netto
-- klassifizierbare cost_basis=NULL-Zeilen auf 'netto'. KEIN blindes NULL → netto.
--
-- KLASSIFIZIERUNG (rate-agnostisch, KEIN zweiter MwSt-Wahrheits-Satz):
--   * Eindeutig NETTO  ⇔ revenue_net < revenue_gross (die USt wurde beim Buchen
--     abgezogen) ODER revenue_gross <= 0 (degeneriert, kein Aufschlagsrisiko).
--   * BRUTTO-IMPLIZIEREND ⇔ revenue_gross > 0 UND revenue_net >= revenue_gross
--     (keine USt abgezogen ⇒ sieht bereits brutto aus). Diese Zeilen sind die
--     Exit-1-Bedingung des Preflights (#177) und dürfen NICHT still als netto
--     gesetzt werden.
--
-- Verhalten: existiert auch nur EINE brutto-implizierende NULL-Zeile, bricht die
-- Migration mit klarer Meldung ab (RAISE EXCEPTION) und setzt NICHTS — die
-- Anomalie ist erst per Preflight zu klären. Andernfalls werden alle eindeutig-
-- netto NULL-Zeilen gesetzt.
--
-- Scope NUR cost_basis IS NULL ⇒ vom korrigierten Nacht-Job (#176) bereits
-- gestempelte 'brutto'/'netto'-Zeilen bleiben unberührt; zweiter Lauf ist No-op
-- (idempotent). Zwei-Achsen-Modell: cost_basis ist ein FAKTUM (worauf die Zeile
-- IST), getrennt von der späteren Restatement-Entscheidung (#180, worauf sie soll).

DO $$
DECLARE
  anomaly_count integer;
BEGIN
  SELECT count(*) INTO anomaly_count
    FROM automatenlager.guv_daily
   WHERE cost_basis IS NULL
     AND revenue_gross > 0
     AND revenue_net >= revenue_gross;

  IF anomaly_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0029 abgebrochen: % brutto-implizierende NULL-Zeile(n) in automatenlager.guv_daily (revenue_net >= revenue_gross trotz positivem Umsatz). Erst per Preflight (tools/preflight-guv-daily.js, #177) klaeren — NICHT blind als netto setzen.',
      anomaly_count;
  END IF;

  UPDATE automatenlager.guv_daily
     SET cost_basis = 'netto'
   WHERE cost_basis IS NULL
     AND (revenue_net < revenue_gross OR revenue_gross <= 0);
END $$;
