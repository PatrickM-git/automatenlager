# SPEC: Auth scharf setzen (Stufe 2) — echte `tenant_id` statt Konstante

> Stufe 2 der Mandantenfähigkeits-Migration. Macht die in Stufe 1 gelegte
> `tenant_id`-Infrastruktur erstmals *wirksam*: der Viewer und die Objekt-Zugriffe
> arbeiten mit dem realen Mandanten aus der Datenbank statt mit der hartcodierten
> Konstante `eigentuemer`. Aktiviert damit die schon gebaute RBAC/IDOR-Architektur.
>
> Vorgänger: `docs/specs/multi-tenant-datenmodell-v1.md` (Stufe 0/1).
> Landkarte: `docs/specs/mandantenfaehigkeit-audit-2026-06-05.md` (Schritt 2 der
> Migrationsreihenfolge). Memory: [[mandantenfaehigkeit-audit]].

## Problem Statement

Das System ist faktisch Single-Tenant, obwohl Stufe 1 das gesamte Datenmodell
mandantenfähig gemacht hat. Die Folge ist ein **stiller Leerlauf** der vorhandenen
Sicherheitsarchitektur:

- `resolveViewer` (Auth-Schicht) liefert die `tenantId` **hartcodiert** als Konstante
  `TENANT_OWNER='eigentuemer'`. Der Viewer weiß nie, zu welchem realen Mandanten der
  eingeloggte Nutzer gehört.
- `machineTenant()` ist ein **Stub**, der ebenfalls immer `eigentuemer` zurückgibt,
  statt den Mandanten einer Maschine aus der DB zu lesen.
- Die beiden bereits verdrahteten IDOR-Hooks (Objekt-Zugriffskontrolle an den
  Endpunkten *slot-change* und *nayax-apply*) vergleichen dadurch nur eine Konstante
  mit sich selbst — sie schützen real nichts.

Gleichzeitig liegen nach dem Stufe-1-Backfill **alle echten Daten unter
`tenant_id='t_faltrix'`** — nicht unter `eigentuemer`. Es besteht also ein latenter,
bereits produktiver **Mismatch**: Der Auth-Layer denkt „eigentuemer", die Daten sagen
„t_faltrix". Heute kracht nichts, weil (a) noch nirgends nach `tenant_id` gefiltert
wird (das ist Stufe 3) und (b) die IDOR-Hooks beide Seiten gegen dieselbe Konstante
prüfen. Aber jeder Versuch, *nur eine* der beiden Funktionen „echt" zu machen, würde
den Eigentümer sofort aus seinen eigenen Maschinen aussperren (404).

Zusätzlich existieren die Zuordnungstabellen `tenant_users` (Login → Mandant) und
`platform_admins` (Support-Notfall-Schlüssel) zwar, sind aber **leer**. Es gibt damit
keinerlei dynamische Quelle für „welche Firma gehört zu diesem Login" und keinen
definierten, sicheren Support-Zugriff für spätere externe Kunden.

Solange dieser Zustand besteht, sind alle nachfolgenden Schutzschichten (Query-Filter,
RLS) **nicht testbar**: Eine Isolation gegen eine Konstante zu prüfen ist sinnlos.

## Solution

Stufe 2 ersetzt die Konstante durch **dynamische, datenbankgestützte Mandanten-Auflösung**
— als reine Verkabelungs- und Verifizierbarkeits-Stufe, ohne neue fachliche Features
und ohne UI.

1. **Login → Mandant** wird aus `tenant_users` aufgelöst. Eine kleine, in sich
   geschlossene **Mandanten-Registry** (Deep Module) lädt die Zuordnung beim Start in
   einen In-Memory-Cache, sodass `resolveViewer` synchron bleibt.
2. **`machineTenant()`** liest den Mandanten einer Maschine real aus der DB
   (cache-gestützt) und liefert bei unbekannter Maschine **`null`** — niemals einen
   Default-Mandanten.
3. **Die Konstante `TENANT_OWNER` wird abgelöst.** `resolveViewer` und `machineTenant()`
   werden **gemeinsam (atomar)** auf den realen Wert (`t_faltrix` für den Eigentümer)
   umgestellt, abgesichert durch einen Regressions-Guard „Eigentümer nicht ausgesperrt".
4. **`objectAccessAllowed` wird gehärtet:** ein fehlender/unbekannter Objekt-Mandant
   führt zu **Zugriff verweigern** statt „gehört dem Eigentümer".
5. **Doppelrolle:** Der Eigentümer-Login steht in `tenant_users` (Alltag als eigener
   Kunde) **und** in `platform_admins` (Break-Glass für spätere Support-Fälle). Beide
   Tabellen werden per Seed-Migration befüllt.
6. **Break-Glass-Support** wird als **bewusste, auditierte, nicht-klebrige
   Support-Sitzung** ermöglicht: ein Plattform-Admin kann einen Ziel-Mandanten pro
   Request explizit über einen Header betreten — **nur-lesend**, erzwungen über die
   bestehende Fähigkeits-Maschine. Das volle Bedien-UI kommt erst in Stufe 8.

Ergebnis: Die vorhandene RBAC/IDOR-Architektur wird erstmals wirksam und gegen zwei
synthetische Test-Mandanten end-to-end verifizierbar. Die Mandanten-Trennung selbst
(flächendeckende Query-Filter, RLS) bleibt bewusst den Folgestufen vorbehalten.

## User Stories

### Mandanten-Auflösung (Login → Mandant)

1. As an Eigentümer, I want that the dashboard recognizes my login as belonging to
   Mandant `t_faltrix`, so that my session operates on my real tenant instead of a
   hardcoded constant.
2. As an Entwickler, I want `resolveViewer` to derive `tenantId` from the database
   (`tenant_users`), so that adding a tenant or moving a login does not require a code
   change.
3. As an Entwickler, I want the login→tenant resolution to stay synchronous, so that the
   many existing synchronous `getViewer`/`resolveViewer` call sites do not have to be
   rewritten into async.
4. As a Betreiber, I want a login that is **not** mapped in `tenant_users` to resolve to
   *no tenant* (and therefore be denied object access), so that an unmapped account can
   never silently inherit the owner's data.

### Maschinen-Mandant (`machineTenant`)

5. As an Entwickler, I want `machineTenant(machineKey)` to return the machine's real
   `tenant_id` from the database, so that the IDOR hooks compare real tenants.
6. As a Betreiber, I want `machineTenant` to return `null` for an unknown machine and
   **never** a default tenant, so that a non-existent or foreign machine is rejected
   rather than accidentally granted.
7. As a Betreiber, I want a machine newly created by n8n (a second writer that bypasses
   the dashboard) to be resolved correctly even if it was not present at startup, so
   that onboarding a machine does not require a dashboard restart.
8. As a Betreiber, I want repeated lookups of non-existent machine IDs to not hammer the
   database, so that the lookup cannot be abused as a probe-amplification vector.

### Ablösung der Konstante (atomare Umstellung)

9. As an Eigentümer, I want `resolveViewer` and `machineTenant` to switch from the
   constant to the real tenant **together**, so that I am never locked out of my own
   machines during the transition.
10. As an Entwickler, I want an explicit regression guard asserting that the owner can
    still access an owned machine through the IDOR hooks, so that the atomic switch is
    proven and stays proven.
11. As a Betreiber, I want a missing or unknown object tenant to be **denied** (not
    treated as the owner), so that the IDOR layer closes instead of leaking.

### Doppelrolle & Seed

12. As an Eigentümer, I want my login mapped to `t_faltrix` in `tenant_users`, so that my
    everyday work happens within my own tenant.
13. As a Plattform-Admin, I want my login additionally registered in `platform_admins`,
    so that I have a separate, explicit support capability for later external customers.
14. As a Betreiber, I want the existing partner and operator logins mapped to
    `t_faltrix` with their roles, so that all current staff continue to work unchanged.
15. As a Betreiber, I want the role to keep coming from the existing environment-variable
    mechanism in this stage, so that the working RBAC is not rebuilt mid-migration.
16. As an Entwickler, I want the dev-local-admin escape hatch (loopback) to also resolve
    to `t_faltrix`, so that lockout recovery keeps working on the Mini.

### Break-Glass-Support (ermöglicht, ohne UI)

17. As a Plattform-Admin, I want to act on my own tenant by default, so that I never
    accidentally operate on another customer's data.
18. As a Plattform-Admin, I want to enter a target tenant only via an explicit,
    per-request header, so that cross-tenant access is always a deliberate act and never
    sticky.
19. As a Plattform-Admin, I want a support session to be **read-only**, so that I can
    diagnose a customer's problem without risking writes to their data.
20. As a Sicherheitsverantwortlicher, I want the override to be honored only when the
    viewer is a platform admin **and** the request arrives over the trusted identity
    path, so that the header cannot be injected by an untrusted peer.
21. As a Sicherheitsverantwortlicher, I want a non-admin who sends the override header to
    have it ignored (acting on their own tenant) and the attempt audited, so that
    privilege escalation attempts are both blocked and visible.
22. As a Sicherheitsverantwortlicher, I want an override to a non-existent tenant to be
    denied and audited, so that probing for tenant existence is recorded.
23. As a Forensiker, I want every break-glass request recorded with timestamp, viewer
    login, viewer's home tenant, target tenant, endpoint, method, outcome, source
    address and a request id, so that a support session can be fully reconstructed
    afterwards.
24. As a Forensiker, I want the break-glass audit to use the existing audit sink, so that
    there is a single place to look for forensics.

### Verifizierbarkeit

25. As an Entwickler, I want the whole stage verified against two synthetic test tenants
    (`acme`, `globex`), so that isolation is tested against real, distinct tenants and
    not against a constant.
26. As a Betreiber, I want the deployment order to apply the seed migration **before**
    the code rollout, so that the new code never starts against an empty `tenant_users`
    and locks the owner out.

### Robustheit & Vertrauensgrenze

27. As a Sicherheitsverantwortlicher, I want a technical lookup failure (DB/cache/refresh)
    to **never** fall back to a default tenant, so that a transient database hiccup cannot
    silently turn every viewer into the owner.
28. As a Betreiber, I want "not found" (`404`) and "technically failed" (`503`) to be
    distinct outcomes, so that an outage is not mistaken for a non-existent object.
29. As a Betreiber, I want a failed periodic cache refresh to keep serving the
    last-known-good snapshot, so that a brief DB blip does not cause a self-inflicted
    total lockout.
30. As a Sicherheitsverantwortlicher, I want `X-Support-Tenant` to be treated as an
    untrusted client header that is only honored on the trusted identity path, so that it
    cannot be injected by an untrusted peer.
31. As a Betreiber, I want it documented that any future reverse proxy/CDN must strip
    inbound trust headers at the edge, so that clients can never supply a forged
    `X-Support-Tenant` or `Tailscale-*` header.

## Implementation Decisions

### Grundprinzip

- Stufe 2 ändert **kein fachliches Verhalten** und **kein UI**. Sie ersetzt eine
  Konstante durch eine datenbankgestützte Auflösung und schaltet damit die vorhandene
  RBAC/IDOR-Architektur scharf.
- Begriffe (durchgängig): **Mandant** = `tenant_id` (opaker String, z. B. `t_faltrix`);
  **Viewer** = das Ergebnis von `resolveViewer`; **Fähigkeit** = Capability;
  **Heimat-Mandant** = der Mandant aus `tenant_users`; **Support-Sitzung** = ein per
  Request aktiver Mandanten-Override eines Plattform-Admins.

### Neues Deep Module: Mandanten-Registry (`tenant-directory`)

Ein in sich geschlossenes Modul kapselt die gesamte Cache-Komplexität hinter einer
kleinen, stabilen Schnittstelle. Es ist die **einzige** Quelle für Mandanten-Auflösung
im Server.

- **Zustand (In-Memory):**
  - `loginToTenant`: Map `login (lowercase) → tenant_id` aus `tenant_users` (aktiv).
  - `platformAdmins`: Set der `login`s aus `platform_admins` (aktiv).
  - `tenantExists`: Set bekannter `tenant_id`s aus `tenants`.
  - `machineToTenant`: Map `machine_key → tenant_id` aus `machines`.
- **Laden:** vollständiger Snapshot beim Start; zusätzlich **TTL-Refresh** (kurzes
  Intervall, konfigurierbar) als Sicherheitsnetz gegen externe Schreiber (n8n schreibt
  direkt in die DB und umgeht den Dashboard); zusätzlich **Reload bei jedem
  dashboard-seitigen Schreibzugriff** auf diese Tabellen.
- **Fehlerverhalten beim Laden (fail-closed):** schlägt der **initiale** Snapshot fehl,
  startet der Server **fail-closed** (tenant-abhängige Endpunkte liefern `503`, sichtbar
  über den Health-Check) statt mit leerem Verzeichnis zu servieren. Schlägt ein
  **TTL-Refresh** fehl, bleibt der **letzte gültige Snapshot** aktiv — niemals auf leer
  zurückfallen (das würde einen transienten DB-Aussetzer in einen Totalausschluss
  verwandeln); der Fehler wird protokolliert/alarmiert.
- **Schnittstelle:**
  - `loginTenant(login) → tenant_id | null` — synchron, rein aus dem Cache. Logins sind
    vollständig aufzählbar; ein unbekannter Login ⇒ `null`.
  - `isPlatformAdmin(login) → boolean` — synchron.
  - `tenantExists(tenant_id) → boolean` — synchron.
  - `machineTenant(machineKey) → Promise<tenant_id | null>` — **asynchron**: erst Cache;
    bei Miss ein **autoritativer Einzel-DB-Recheck** (`SELECT tenant_id FROM machines
    WHERE machine_key = $1`), dann cachen. Maschinen können zur Laufzeit von n8n angelegt
    werden, daher der Miss-Recheck. **Negative-Caching:** ein „nicht gefunden"-Ergebnis
    wird kurz gecacht, damit Wiederholungs-Probing keine DB-Last erzeugt. Schlägt der
    Recheck **technisch** fehl (DB/Verbindung), wird der Fehler **propagiert** (Aufrufer
    liefert `503`) — er wird **nie** als `null`/„nicht gefunden" interpretiert.
  - `refresh()` — vollständiges Neuladen.
- **Asymmetrie-Begründung (bewusst):** `loginTenant` bleibt rein-synchron (kleine,
  aufzählbare Menge, Änderungen kommen über Onboarding/Restart), `machineTenant` ist
  async mit Miss-Recheck (Maschinen wachsen zur Laufzeit über einen Zweitschreiber).

### `resolveViewer` (Auth-Schicht)

- Erhält zusätzlich zur heutigen Eingabe: den **Heimat-Mandanten** via `loginTenant`,
  das **Plattform-Admin-Flag** via `isPlatformAdmin`, den **Override-Header**-Wert und
  die **request-id** (für Audit).
- Liefert einen erweiterten Viewer:
  - `homeTenantId` — der Heimat-Mandant aus `tenant_users` (oder `null`).
  - `tenantId` — der **effektive** Mandant: standardmäßig `homeTenantId`; bei aktiver
    Support-Sitzung der Ziel-Mandant.
  - `isPlatformAdmin` — boolean.
  - `supportSession` — `{ active, targetTenant }` (oder inaktiv).
  - `capabilities` / `can` — wie bisher, aber bei aktiver Support-Sitzung auf die
    **Lese-Teilmenge** reduziert (siehe Capability-Stripping).
- **Rolle bleibt** aus dem bestehenden Env-Mechanismus (`DASHBOARD_ADMIN_LOGIN` etc.);
  `tenant_users.role` bleibt in dieser Stufe ungenutzt/reserviert.
- `resolveViewer` bleibt **synchron**. Die Mandanten-Auflösung erfolgt rein aus dem Cache.

### Ablösung von `TENANT_OWNER` (atomar)

- Die Konstante `TENANT_OWNER='eigentuemer'` wird als Mandanten-Wert **entfernt**.
  `resolveViewer` und `machineTenant` werden in **einem** Schritt umgestellt, sodass für
  den Eigentümer beide Seiten `t_faltrix` liefern.
- Wo bisher `TENANT_OWNER` als „Default-Mandant" diente, gilt fortan: **kein Default**.
  Fehlt der Mandant, ist die Antwort `null`/deny.

### `objectAccessAllowed` (IDOR-Objektprüfung)

- Vertrag neu: `objectAccessAllowed(viewer, objectTenantId)` liefert **nur** dann `true`,
  wenn `viewer.tenantId` nicht-null ist **und** exakt `objectTenantId` entspricht.
- Ein **fehlender/leerer/null** Objekt-Mandant ⇒ **`false`** (deny). Die frühere
  „null ⇒ Eigentümer"-Annahme entfällt.
- **Zwingende Kopplung:** Da `machineTenant` bei unbekannter Maschine `null` liefert,
  muss `objectAccessAllowed` dieses `null` als deny behandeln — sonst würde die
  IDOR-Prüfung das `null` zurück in „Eigentümer" retten. Beide Änderungen gehören in
  denselben Schritt.
- Die beiden bereits verdrahteten Hooks (*slot-change*, *nayax-apply*) bleiben
  unverändert verdrahtet, werden aber durch die jetzt realen Werte erstmals wirksam.
  Ihre Aufrufe von `machineTenant` werden auf `await` umgestellt.

### Fehlerverhalten: fail-closed & Statuscode-Taxonomie

Grundregel: Bei jedem **technischen** Fehler in der Mandanten-Auflösung (DB nicht
erreichbar, Query-Fehler, fehlgeschlagener Cache-Zugriff) wird **niemals** auf einen
Default-Mandanten (`t_faltrix`/`eigentuemer`) zurückgefallen. Kein
`try { … } catch { return <default> }`. Ein technischer Fehler ⇒ **deny / `503`**, nie
„unauffällig durchwinken".

**Drei klar getrennte Fehlermodi** (dürfen nie gleich behandelt werden):

1. **Nicht gefunden / fremder Mandant** (Lookup erfolgreich, aber Objekt unbekannt oder
   gehört einem anderen Mandanten) ⇒ **`404`** (kein Existenz-Leak). Forensik
   unterscheidet „nicht gefunden" und „fremder Mandant" über separate Audit-Ereignisse.
2. **Technischer Lookup-Fehler** (DB/Cache/Verbindung) ⇒ **`503`** (Service Unavailable):
   „später erneut", nicht „existiert nicht", nicht „verboten". Wird protokolliert/
   alarmiert.
3. **Ungültiger Support-Override** ⇒ siehe Break-Glass-Negativregeln (nicht-existenter
   Ziel-Mandant `404`, Schreibversuch unter Override `403`, nicht-berechtigter
   Header-Versuch ignoriert-und-auditiert) — **immer auditiert**.

**Lebenszyklus-Fälle der Registry:**

- **Initialer Load schlägt fehl** ⇒ Server ist **unhealthy/fail-closed**: tenant-abhängige
  Endpunkte liefern `503`, sichtbar über den Health-Check; er serviert **nicht** mit
  leerem Verzeichnis (das würde stillschweigend alle — inkl. Eigentümer — abweisen, wäre
  zwar sicher, aber unsichtbar).
- **TTL-Refresh schlägt fehl** ⇒ **letzter gültiger Snapshot bleibt aktiv** (niemals auf
  leer zurückfallen — ein transienter DB-Aussetzer darf keinen Totalausschluss erzeugen);
  Fehler wird protokolliert.
- **Per-Request Miss-Recheck (`machineTenant`) schlägt technisch fehl** ⇒ Fehler wird
  propagiert, Endpunkt liefert `503` — **nicht** `null`/„nicht gefunden".

### Break-Glass: Mandanten-Override

- **Kanal:** HTTP-Header `X-Support-Tenant: <tenant_id>`. **Bewusst kein Query-Parameter**
  — ein Query-Param landet in Access-Logs, Browser-History, Referrern und Bookmarks und
  würde „ich war in Mandant X" leaken bzw. versehentlich bestehen bleiben.
- **Per-Request, nicht klebrig:** Es gibt **keinen** serverseitigen Sitzungs-Zustand.
  Ohne Header ⇒ sofort wieder Heimat-Mandant. Der Override wird bei jedem Request neu aus
  dem expliziten Signal abgeleitet.
- **Wirksamkeitsbedingungen (alle nötig):** (a) Viewer ist Plattform-Admin
  (`isPlatformAdmin`), **und** (b) der Request kommt über den vertrauenswürdigen
  Identity-Pfad (dieselbe F1-Logik, die auch den Identity-Header vertraut), **und**
  (c) der Ziel-Mandant existiert (`tenantExists`).
- **Negativregeln (mit Statuscode):**
  - Header gesetzt, aber Viewer **kein** Plattform-Admin **oder** untrauter
    Identity-Pfad ⇒ Header **ignoriert**, Viewer arbeitet auf dem Heimat-Mandanten,
    **Versuch wird als `denied`-Ereignis auditiert** (kein stilles Verschlucken). Bewusst
    **kein** harter `403`: ein versehentlich von einer Infrastruktur (Proxy/CDN)
    injizierter Header soll legitime Nicht-Admin-Requests nicht blockieren — die
    App-Schicht entwertet den Header, statt den Nutzer auszusperren. (Strengere
    Alternative, falls gewünscht: hartes `403` bei jeder Header-Präsenz ohne Berechtigung.)
  - Ziel-Mandant existiert nicht ⇒ **`404` + Audit** (bestätigt die Existenz eines
    Mandanten nicht; kein stiller Fallback).
  - Schreibversuch unter aktivem Override ⇒ **`403` + Audit** (Capability-Stripping).
  - **Jeder** aktive Override ⇒ **read-only**, ausnahmslos — auch ein Override auf den
    eigenen Heimat-Mandanten. Regel ist absichtlich simpel und testbar: „Override aktiv
    ⇒ nur lesen".
- **Read-only-Durchsetzung via Capability-Stripping (primär):** Bei aktiver
  Support-Sitzung werden die `capabilities` des Viewers auf die **Lese-Teilmenge**
  reduziert (die `*.lesen`-Fähigkeiten; alle schreibenden Fähigkeiten werden entfernt).
  Damit liefern die **bestehenden** `requireCapability`-Guards an Schreib-Endpunkten
  automatisch `403`. Kein neuer Durchsetzungspfad nötig.
- **Methoden-Riegel (sekundär, Defense-in-Depth):** Zusätzlich werden bei aktiver
  Support-Sitzung zustandsändernde HTTP-Methoden (`POST`/`PUT`/`PATCH`/`DELETE`) hart
  abgewiesen, falls ein Schreib-Endpunkt einmal nicht hinter `requireCapability` läge.

### Header-Hygiene an der Vertrauensgrenze

`X-Support-Tenant` ist ein **client-kontrollierter** Header und gilt grundsätzlich als
**nicht vertrauenswürdig**. Schutz auf zwei Ebenen:

- **App-Schicht (Stufe 2, Code):** Der Header wird nur ausgewertet, wenn der Viewer
  Plattform-Admin ist **und** der Request über den vertrauenswürdigen Identity-Pfad
  kommt (dieselbe F1-Logik wie für die `Tailscale-*`-Identity-Header). Da das
  Admin-Flag transitiv aus dem — auf untrautem Pfad ohnehin verworfenen — Identity-Header
  stammt, ist der Override auf untrautem Pfad nie honorierbar; die explizite
  Pfad-Bedingung ist der zweite Riegel.
- **Infrastruktur-Schicht (dokumentierte Invariante):** Sitzt später ein Reverse-Proxy
  oder CDN davor, **muss** dieser einen von außen eingehenden `X-Support-Tenant` (ebenso
  wie eingehende `Tailscale-*`-Trust-Header) **an der Kante verwerfen** und darf
  Trust-Header ausschließlich **intern** setzen — keine client-kontrollierten
  Trust-Header durchreichen. Dieselbe Klasse wie die bestehende F1-Path-Trust-/
  `DASHBOARD_INTERNAL_PEER_CIDR`-Regel. In Stufe 2 kein neuer Proxy ⇒ Invariante +
  Homelab-Notiz, kein Code.

### Audit-Trail (an bestehende Senke andocken)

- Break-Glass-Ereignisse werden über die **bestehende** Audit-Funktion (`auditAction` /
  `auditDenied`, JSONL-Senke `DASHBOARD_AUDIT_LOG`) geschrieben — **keine** zweite Senke.
- **Pflichtfelder** je Ereignis: `timestamp`, `viewer` (Login), `homeTenant`
  (Heimat-Mandant des Viewers), `targetTenant`, `endpoint`, `method`, `outcome`
  (`allow`/`denied`), `sourceAddress` (`remoteAddress`), `requestId`.
- **Request-id:** Falls noch keine existiert, wird in dieser Stufe eine pro Request
  erzeugt (zufällige ID) und früh im Request angeheftet, sodass alle Audit-Einträge eines
  Requests korreliert werden können. Optional (Notiz): eine Support-Session-ID, die
  mehrere Requests einer Sitzung verklammert — in Stufe 2 nicht erforderlich.
- Auditiert werden mindestens: aktivierter Override (allow), ignorierter Override-Versuch
  durch Nicht-Admin (denied), Override auf nicht-existenten Mandant (denied), an einem
  Override-Request abgewiesener Schreibzugriff (denied).

### `getViewer` / Request-Verkabelung

- `getViewer(req)` wird erweitert, um zusätzlich den `X-Support-Tenant`-Header und die
  request-id an `resolveViewer` durchzureichen (Login und `remoteAddress` werden bereits
  durchgereicht).

### Seed-Migration (`0018`)

- Idempotente Migration befüllt:
  - `tenant_users`: Eigentümer-, Partner- und Auffüller-Login → `t_faltrix` (jeweils mit
    `active=true`; `role` gesetzt, aber in Stufe 2 nicht autoritativ).
  - `platform_admins`: Eigentümer-Login (`active=true`).
- Die konkreten Login-Werte stammen aus den bestehenden Env-Listen bzw. der Mini-Konfig
  (z. B. der Tailscale-Serve-Login). Keine Klartext-Geheimnisse in der Migration.
- **Deploy-Reihenfolge auf dem Mini: Migration `0018` VOR dem Code-Rollout.** Sonst
  startet der neue Code gegen leere `tenant_users`, kann den Eigentümer-Mandanten nicht
  auflösen und sperrt aus (gleiches Prinzip wie „DDL vor Code" in Stufe 1).

### Berührte Module/Teilsysteme

- **`lib/auth.js`** — `resolveViewer` (erweiterter Viewer, Override-Logik,
  Capability-Stripping), `objectAccessAllowed` (Härtung), Ablösung der `TENANT_OWNER`-
  Verwendung als Default; Lese-Teilmenge der Fähigkeiten ableiten.
- **Neues `lib/tenant-directory.js`** (Deep Module) — Cache + Lookups (`loginTenant`,
  `isPlatformAdmin`, `tenantExists`, `machineTenant`, `refresh`).
- **`server.js`** — `machineTenant` ruft die Registry auf (async/`await` an den 2
  Hook-Aufrufstellen); `getViewer` reicht Header + request-id durch; request-id-Erzeugung;
  Audit-Aufrufe für Break-Glass; Registry-Initialisierung beim Start + TTL.
- **`dashboard/db-migrations/0018-seed-tenant-users-platform-admins.sql`** — Seed.

## Testing Decisions

- **Was einen guten Test ausmacht:** Nur **externes Verhalten** prüfen, nicht die
  Implementierung. Für die Auth-Schicht heißt das: Ein- und Ausgaben von `resolveViewer`/
  `objectAccessAllowed`/`machineTenant` und das HTTP-Verhalten der geschützten Endpunkte
  (Statuscodes, Audit-Einträge) — nicht die internen Cache-Datenstrukturen.
- **Prior Art:** die bestehenden `dashboard/tests/dashboard-mt-*.test.js` (Stufe-1-
  Mandanten-Tests) sowie die vorhandenen Auth-/RBAC-Tests rund um `resolveViewer` und
  `requireCapability`. Neue Tests fügen sich in dieselbe Struktur ein.
- **Zwei synthetische Test-Mandanten** (`acme`, `globex`) werden über das
  Sandbox-Harness aus #94 angelegt; die echten Faltrix-Daten werden dabei nicht berührt.

Pflicht-Testfälle:

1. **Login→Mandant:** je Login (Eigentümer/Partner/Auffüller) liefert `resolveViewer` den
   korrekten `tenant_id`; ein **nicht** gemappter Login ⇒ `tenantId = null`.
2. **`machineTenant`:** bekannte Maschine ⇒ ihr `tenant_id`; unbekannte Maschine ⇒
   `null`; eine **nach** dem Start angelegte Maschine ⇒ via Miss-Recheck korrekt; ein
   nicht-existenter Key ⇒ `null` **ohne** wiederholte DB-Last (Negative-Caching).
3. **`objectAccessAllowed`-Härtung:** `null`/unbekannter Objekt-Mandant ⇒ deny; fremder
   Mandant ⇒ deny; eigener Mandant ⇒ allow.
4. **Owner-nicht-ausgesperrt-Regressions-Guard:** Eigentümer-Viewer + eigene Maschine
   über die echten IDOR-Hooks ⇒ **erlaubt** (sichert die atomare Umstellung ab).
5. **Break-Glass-Matrix** (über die geschützten Endpunkte):

   | Viewer | Override | Methode | Erwartung |
   |---|---|---|---|
   | Plattform-Admin | auf `acme` | GET | erlaubt (liest `acme`) |
   | Plattform-Admin | auf `acme` | POST/PUT/PATCH/DELETE | **403** |
   | Nicht-Admin | auf `acme` | beliebig | Override **ignoriert**, agiert als Heimat-Mandant + Versuch auditiert |
   | Plattform-Admin | **kein** Override | beliebig | normaler Heimat-Mandant |
   | Plattform-Admin | auf eigenen Mandanten | POST | **403** (Override aktiv ⇒ read-only) |
   | Plattform-Admin | auf nicht-existenten Mandanten | beliebig | **404 + Audit** |
   | Override + untrauter Identity-Pfad | — | beliebig | Override **ignoriert** + auditiert |

6. **Audit-geschrieben-Assertion:** Für jeden Break-Glass-Fall wird geprüft, dass die
   Audit-Senke einen Eintrag mit den Pflichtfeldern erhält (sonst ist „auditiert"
   ungetestet).
7. **Forensik-Unterscheidung:** „Maschine nicht gefunden" und „fremder Mandant" erzeugen
   unterscheidbare Audit-Ereignisse.
8. **Fail-closed bei technischem Fehler:** Wird der DB-Recheck (bzw. der initiale Load) als
   Fehler simuliert, liefert der betroffene Endpunkt **`503`** — klar abgegrenzt von
   „nicht gefunden ⇒ `404`".
9. **Kein Default bei Fehler:** Unter simuliertem Lookup-Fehler erhält **kein** Viewer
   `t_faltrix`/`eigentuemer` als Fallback (Anti-Regression gegen ein `catch ⇒ default`).
10. **Refresh-Resilienz:** Ein fehlgeschlagener TTL-Refresh lässt den **letzten gültigen
    Snapshot** aktiv; Lookups funktionieren weiter (kein Zurückfallen auf leer).
11. **Header-Injektion:** Ein `X-Support-Tenant` von einem Nicht-Admin bzw. über einen
    untrauten Pfad ändert den effektiven Mandanten **nicht** (bleibt Heimat-Mandant) und
    erzeugt einen Audit-Eintrag.
12. **Live-Smoke-Test auf dem Mini** (nach Migration + Deploy): Eigentümer-Zugriff auf
    eine Faltrix-Maschine funktioniert weiterhin; ein Break-Glass-GET mit gültigem
    Plattform-Admin liefert Lesedaten, ein Break-Glass-POST liefert 403.

## Out of Scope

Bewusst **nicht** Teil dieser Stufe (jeweils einer Folgestufe zugeordnet):

- **Flächendeckende Query-Filter** (`WHERE tenant_id = $1` in allen Query-Funktionen wie
  economics, overview-monitoring, assortment, inventory) → **Stufe 3**.
- **IDOR-Hooks an *weiteren* Endpunkten** → **Stufe 4**. Stufe 2 macht ausschließlich die
  zwei bereits verdrahteten Hooks real wirksam.
- **Supabase Row-Level-Security** → Stufe 5.
- **n8n-Ablösung/Parametrisierung** (tenant-aware Schreibpfade) → Stufe 6.
- **Per-Tenant-Credential-Vault** → Stufe 7.
- **Mandanten-Selektor / Support-Bedien-UI** (Frontend) → Stufe 8. Stufe 2 liefert nur
  den Backend-Mechanismus (Header), kein UI.
- **Umzug der Rolle in die DB** (`tenant_users.role` autoritativ) → spätere
  Onboarding-Phase, wenn die Env-Listen durch echtes Login/Supabase-Auth abgelöst werden.
- **Multi-Instanz-Cache-Kohärenz** (Redis/pub-sub) → erst nötig, wenn mehr als eine
  Dashboard-Instanz läuft (heute genau eine).
- **Konfiguration eines vorgelagerten Reverse-Proxy/CDN** (Trust-Header-Stripping an der
  Kante) → Infra/Homelab. Stufe 2 setzt nur die **App-seitige** Auswertung „Header nur auf
  vertrauenswürdigem Pfad honorieren" um und dokumentiert die Proxy-Invariante.

**Wichtige Einordnung:** Stufe 2 macht das System **nicht** verkaufsfähig für einen
zweiten realen Kunden. Dafür sind zusätzlich Stufe 3 (Query-Filter) und Stufe 5 (RLS)
nötig. Stufe 2 ist *Verkabelung und Verifizierbarkeit*: Mit nur einem realen Mandanten
(Faltrix) leckt nichts, weil es keine zweiten echten Daten gibt; ein zweiter realer Kunde
darf erst nach Stufe 3/5 onboarden.

## Further Notes

- **Cache-Annahme explizit:** Der In-Memory-Cache ist nur korrekt, solange **genau eine**
  Dashboard-Instanz läuft (heute der Fall: ein `homelab-dashboard`-Container auf dem
  Mini). TTL-Refresh und Miss-Recheck sind das Sicherheitsnetz gegen den Zweitschreiber
  n8n; Multi-Instanz-Kohärenz (Redis/pub-sub) ist ein bewusst dokumentiertes Zukunfts-
  Item, kein Stufe-2-Ziel.
- **Warum der Cache überhaupt:** Er existiert primär, damit `resolveViewer` **synchron**
  bleibt (sehr viele Aufrufstellen über `getViewer`), nicht zur DB-Lastsenkung.
- **`tenant_users.role` reserviert:** Die Spalte wird beim Seed gefüllt, aber in Stufe 2
  bewusst nicht als Autorität verwendet — sie wartet auf die Onboarding-Phase.
- **`t_faltrix` als opake ID:** Laut Stufe-1-Migration bei Bedarf später auf eine UUID
  migrierbar; Stufe 2 behandelt die ID als undurchsichtigen String und trifft keine
  Annahme über ihr Format.
- **Dev-Notausgang:** `DASHBOARD_DEV_LOCAL_ADMIN` (Loopback) muss ebenfalls auf
  `t_faltrix` auflösen, damit die Lockout-Recovery auf dem Mini erhalten bleibt.
- **Fail-closed-Prinzip:** Technische Fehler in der Mandanten-Auflösung führen nie zu
  einem Default-Mandanten, sondern zu `503`/deny. „Nicht gefunden" (`404`) und „technisch
  fehlgeschlagen" (`503`) sind strikt getrennt; ein fehlgeschlagener Refresh behält den
  letzten gültigen Snapshot (kein Zurückfallen auf leer).
- **Trust-Header-Hygiene:** `X-Support-Tenant` ist client-kontrolliert und wird nur auf
  dem vertrauenswürdigen Identity-Pfad honoriert; ein künftiger Reverse-Proxy/CDN muss ihn
  (wie `Tailscale-*`) an der Kante verwerfen. Dafür eine Homelab-Notiz/-Issue vorsehen.
- **Projektregeln:** keine Klartext-Geheimnisse in Migration/Code; nach Abschluss
  Handover/`CLAUDE.md` aktualisieren und pushen.
