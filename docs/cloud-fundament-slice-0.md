# Cloud-Fundament (Slice 0, Issue #212) — Ergebnis-Protokoll 2026-06-11

> Gehört zur SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md`.
> AC3 (Secrets-Inventar) und AC4 (Cron-Entscheidung) sind separat dokumentiert:
> `docs/cloud-migration/slice-0-secrets-inventory.md` und
> `docs/cloud-migration/slice-0-cron-quelle-entscheidung.md` (Trigger-Schutz =
> `WORKER_TRIGGER_SECRET`). Hier steht das **Anlage-Ergebnis** (AC1/AC2/AC5).
> Keine Secrets in dieser Datei — Passwörter im Passwortmanager des Betreibers.

## 1. Account-Inventar (alle Gratis-Stufen)

| Dienst | Identität / Login | Inhalt | Status |
| --- | --- | --- | --- |
| **Supabase** | GitHub-SSO `PatrickM-git` | Org `Faltrix-Lösungen`, Projekt **`Faltrix`**, Region **`eu-central-1` (Frankfurt)**, Projekt-Ref `bimftbjpvljjnvorqbtn`, URL `https://bimftbjpvljjnvorqbtn.supabase.co` | ✅ provisioniert (leer; Schema kommt mit #214) |
| **Render** | GitHub-SSO `PatrickM-git` | Workspace angelegt, **noch keine Services** (kommt mit #217) | ✅ |
| **Cloudflare** | Google-SSO `faltrixsolutions@gmail.com` | Zone **`faltrix-solutions.de`** (Free-Plan), zugewiesene NS `martha.ns.cloudflare.com` + `moura.ns.cloudflare.com` | ✅ Zone angelegt, NS-Delegation live |
| **INWX** (Registrar) | `faltrixsolutions@gmail.com`, Kunden-Nr. 251284 | Domain **`faltrix-solutions.de`** registriert 2026-06-11 (3,57 € 1. Jahr, Verlängerung ~4,65 €/Jahr, jährlich), Registrant „Faltrix Solutions UG", **Transfer-Lock aktiv** | ✅ REG SUCCESSFUL |
| **Gmail** | `faltrixsolutions@gmail.com` | Firmen-Postfach/Identität; Wiederherstellung über `patrickzinke@gmx.net` | ✅ |

**Bewusste Abweichung von der SPEC:** Die Domain ist **nicht** beim Cloudflare
Registrar — Cloudflare unterstützt die `.de`-TLD (noch) nicht (live verifiziert
am 2026-06-11: „kann nicht registriert werden, da Cloudflare die .de-Erweiterung
noch nicht unterstützt"). Stattdessen Registrar **INWX** (DENIC-Mitglied,
Berlin) mit **Nameserver-Delegation auf Cloudflare** (kostenloses Domain-Update).
Für die Architektur ändert sich nichts: DNS-Zone, Frontend/Pages und TLS liegen
wie geplant bei Cloudflare; INWX ist nur die Registrierungsstelle.

**Risikostreuung (bewusst):** Cloudflare/INWX (Domain = nicht reproduzierbares
Asset) hängen an der Faltrix-Gmail (Recovery: GMX); Supabase/Render
(reproduzierbare Projekte) am GitHub-Konto. Ein verlorener GitHub-Zugang kostet
damit nicht die Domain.

## 2. Verifikation (AC5, 2026-06-11)

- [x] Supabase-Projekt „Faltrix" in **Frankfurt**, Status „Gesund" nach
  Provisioning. (Erstanlage war versehentlich in `eu-west-1` Irland → gelöscht
  und neu angelegt, solange die DB leer war — sonst ~25 ms Cross-Region-Latenz
  pro DB-Roundtrip gegen das Render-Backend in Frankfurt, und die Tür macht
  mehrere Roundtrips pro Zugriff.)
- [x] Render-Dashboard erreichbar (Service-Assistent bewusst übersprungen).
- [x] Cloudflare-Zone im Free-Plan; Quick-Scan-Records (INWX-Parkseite, 3×A auf
  `185.181.104.242`, proxied) vorerst übernommen — werden in #218 ersetzt.
- [x] Domain registriert (INWX „REG SUCCESSFUL", Laufzeit bis 11.06.2027,
  Transfer-Lock, Verlängerung jährlich).
- [x] **NS-Delegation propagiert:** `nslookup -type=NS faltrix-solutions.de 8.8.8.8`
  liefert `martha.ns.cloudflare.com` + `moura.ns.cloudflare.com` (DENIC-Update
  ging in Minuten durch). Cloudflare aktiviert die Zone beim nächsten
  automatischen Check (Mail an die Faltrix-Gmail).

## 3. Stolpersteine (für die nächsten Slices notiert)

- **INWX-UI-Bug:** Der „Externe Nameserver"-Dialog auf der Domain-Info-Seite ist
  defekt (`inwx.createInput is not a function` — „+ Nameserver hinzufügen" tut
  nichts; Einzelfeld akzeptiert keine kommaseparierte Liste). Funktionierender
  Weg: **Massenaktion → Update → Warenkorb → Bearbeiten → Tab „Nameserver" →
  „Manuelle Nameservereingabe"** (kostenloses Domain-Update, Felder 1+2).
- **Supabase-Regionswahl:** Im Anlage-Dropdown ist die konkrete Region unter
  „Spezifische Regionen" versteckt; die Kontinent-Vorauswahl („Europa") nimmt
  sonst still Irland. Frankfurt = `EU-Central-1`, dort als „EMPFOHLEN" markiert.
- **Supabase-Signup** bietet kein Google-SSO (nur GitHub oder E-Mail/Passwort).
- **Supabase-Sicherheitsoptionen** bei der Projekt-Anlage: „Neue Tabellen
  automatisch offenlegen" (Data-API-Grants) **deaktiviert**, „Automatische RLS"
  fürs `public`-Schema **aktiviert** — beides betrifft nur das (bei uns leere)
  `public`-Schema; die echte Mandanten-RLS kommt aus den eigenen Migrationen
  (Slice 1, #214).
