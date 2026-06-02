# SPEC: Auth- & Sicherheitskonzept — RBAC, Tailscale Serve/HTTPS, editierbare Schwellwerte (Faltrix)

**Status:** Entwurf, umsetzungsreif
**Bereich:** Zwei Repos — Auth-Layer im Node-Dashboard (`dashboard/server.js`, `github.com/PatrickM-git/automatenlager`) und Tailnet-/Infra-Schicht (`github.com/PatrickM-git/homelab`, lokal `C:\Users\patri\Documents\homelab`)
**Repo / Branch:** github.com/PatrickM-git/automatenlager, `main` (Live-Klon: `C:\Users\patri\Documents\mein-erstes-Projekt`)
**Voraussetzung für:** editierbare Settings (in dieser Phase enthalten), Mandantenfähigkeit (Fundament in dieser Phase), spätere Gegenrichtung „System → Nayax pushen" (nur ermöglicht, nicht gebaut)
**Zielstack später:** Vercel + Supabase (Row-Level-Security als Mandanten-Primitive) — diese Phase legt das Fundament, vollzieht den Umzug aber nicht.

---

## Problem Statement

Das Dashboard hat **keine echte Authentifizierung**. Aus Betreiber-/Eigentümersicht ergeben sich daraus konkrete, belegbare Risiken:

- **„Kein Header → Admin".** Die Viewer-Logik (`getViewer`, `server.js:186`) setzt jeden Zugriff ohne Identitäts-Header auf **Admin**: `isAdmin = !normalizedLogin || ...`. Der `localhost`-Check (`isLocalDashboardHost`) wird dabei nur für das **Anzeige-Label** benutzt, **nicht** für die Admin-Entscheidung. Die Doku (`homelab/docs/runbooks/guest-access.md`, CLAUDE.md) behauptet das Gegenteil („kein Header auf Tailnet-Host = Gast") — Code und Doku widersprechen sich, und der Code ist die gefährlichere Wahrheit.
- **Keine Identitäts-Header im Tailnet.** Das Dashboard wird im Homelab als **roher TCP-Durchlauf** veröffentlicht (`homelab/infra/scripts/wsl-keepalive.ps1:48`: `tailscale serve --bg --tcp=8787 tcp://localhost:8787`). Tailscale injiziert dabei **keinen** `Tailscale-User-Login`-Header. Folge: Jedes per Tailscale eingeladene Gastgerät, das auf Port `8787` zugreift, hat heute **Admin-Rechte** — genau das, was die Read-Only-Gastfreigabe verhindern sollte. n8n daneben macht es bereits richtig (`wsl-keepalive.ps1:47`: `--https=443`).
- **Lauscht auf `0.0.0.0`.** Der Container-Publish `8787:8787` (`homelab/infra/docker/docker-compose.yml:118`) macht den rohen Port im Tailnet erreichbar. In Kombination mit der frei wählbaren Header-Natur heißt das: Wer `:8787` erreicht, kann einfach `Tailscale-User-Login: patrick@…` mitschicken und ist Admin (**Header-Spoofing**).
- **Klartext-HTTP.** Der Tailnet-Zugang läuft über `http://…:8787` ohne TLS.
- **Ungeschützter Secret-Schreibpfad.** `POST /api/config` (`server.js:2336`) schreibt den **n8n-API-Key** in `.dashboard-config.json` — **ohne jede Rollenprüfung** (kein `getViewer`-Aufruf). Heute (jeder = Admin) kann faktisch jeder im Tailnet den n8n-Schlüssel überschreiben.
- **Kein Audit für privilegierte Aktionen.** Geloggt wird heute nur Gast-*Zugriff* (`auditGuestAccess`, JSONL unter `logs/guest-access.jsonl`). Wer wann einen Workflow getriggert, einen Nayax-Apply ausgeführt oder Einstellungen geändert hat, ist nirgends nachvollziehbar.
- **Nur zwei grobe Rollen.** Es gibt ausschließlich Admin (alles) und Gast (read-only). Für den realen Betrieb (Eigentümer, Auffüller, Gast/Kunde) fehlt eine Abstufung, und Schwellwerte sind hart codiert und nicht editierbar.

Wichtig: Das Dashboard ist im Einsatz und wird mobil im Alltag genutzt. Die Lösung darf den laufenden Betrieb nicht gefährden — insbesondere darf sie den Eigentümer nicht aus dem eigenen System aussperren.

## Solution

Ein zusammenhängendes **Auth- & Sicherheitskonzept** über beide Repos, in drei tragenden Säulen plus zwei Härtungen:

1. **Identität echt machen (homelab).** Der rohe Tailnet-Port wird geschlossen und durch **Tailscale Serve mit HTTPS auf eigenem Port `:8443`** ersetzt (n8n behält `443`). Serve terminiert TLS, prüft selbst die Tailnet-Identität, **verwirft client-gesetzte `Tailscale-*`-Header und setzt eigene, echte**, und leitet an `127.0.0.1:8787` weiter. Der Container-Publish wird auf **Loopback** eingeschränkt (`127.0.0.1:8787:8787`), sodass der einzige *Tailnet*-Weg durch Serve führt. Damit sind die `0.0.0.0`-Exposition weg und der Verkehr verschlüsselt. **Wichtig (Sicherheits-Review F1):** Der Loopback-Bind schließt nur den *Host*-Port — andere Container im selben `homelab-network` (n8n, Open WebUI) erreichen den Dashboard-Container weiterhin **direkt** über `homelab-dashboard:8787` unter **Umgehung von Serve**. Header-Spoofing ist daher erst dann wirklich tot, wenn das Dashboard Identity-Header **nur auf dem Serve-Pfad** vertraut (siehe Säule 2) — der Loopback-Bind allein genügt nicht.

2. **Default-Deny statt Default-Admin (automatenlager).** `getViewer` wird umgedreht: **Header vorhanden → Rolle aus exakt hinterlegtem Login** (Standard *Gast*, sofern das Login nicht in der Rollen-Konfiguration steht); **kein Header → Loopback-Zugriff ist Admin nur, wenn ein explizites Entwicklungs-Flag gesetzt ist** (auf der produktiven Mini ist es **aus** — dort gibt es ausschließlich den über Serve authentifizierten Admin-Login). Jeder andere header-lose Zugriff ist **kein Admin**. Die heutige Präfix-Regel (`startsWith('patrick')`) **entfällt ersatzlos** — sie ist ein Fußschuss (`patrick-evil@…` wäre Admin); es gilt nur noch **exakte Allowlist**. Der Header gilt **nur auf dem Serve-Pfad** als vertrauenswürdig: Aufrufe über das Docker-interne Netz (`homelab-network`) **ignorieren `Tailscale-*`-Header vollständig** und gelten als **Gast/read-only**, unabhängig vom Header-Inhalt — sonst könnte ein kompromittierter Nachbar-Container einen Admin-Login fälschen (Sicherheits-Review F1).

3. **Echtes, fähigkeits-basiertes Rollenmodell (RBAC).** Berechtigungen werden als kleine Menge von **Fähigkeiten (Verben)** modelliert, nicht pro Reiter. Ein Reiter wird sichtbar, sobald der Viewer mindestens eine Fähigkeit besitzt, die er braucht; Aktions-Buttons (Trigger, Nayax-Apply, Slot-Editor, Korrektur, Settings) werden je Fähigkeit ein-/ausgeblendet **und** serverseitig erzwungen. Drei Voreinstellungs-Rollen bündeln die Fähigkeiten.

Zusätzlich, weil sie genau den Kern „nicht unbefugt verändert/ausgelesen werden" bedienen und das Fundament für Mandantenfähigkeit legen:

4. **Secret-Handling.** Alle zugangsdaten-tragenden Endpunkte werden an die Fähigkeit `system.verwalten` gebunden. Secrets gehen nie im Klartext an den Browser (immer maskiert, z. B. `••••gesetzt`) und werden nie in Logs/Audit geschrieben. Das Datenmodell trennt Zugangsdaten **je Mandant** — Grundstein für „Nayax-API je Kunde".

5. **Audit-Trail privilegierter Aktionen.** Ein erweitertes, append-only Logbuch hält fest, **wer wann was** getan hat: Workflow-Trigger, Nayax-Apply, Settings-/Schwellwert-Änderung, Rollenvergabe. Secrets erscheinen darin nie.

Quer durch die Lösung ist das Datenmodell **`tenant_id`/`machine_id`-parametrisch** angelegt (globale Default-Zeile + optionale Pro-Automat-Overrides), aber als **ein** Mandant (Eigentümer) betrieben. Damit ist die spätere Mandantenfähigkeit ein Daten-/Konfigurationsschritt statt eines Umbaus — und übersetzt sich 1:1 in Supabase-RLS.

Schließlich werden die heute hart codierten **Schwellwerte editierbar** gemacht — fachlich relevant für den Alltag und gleichzeitig der erste konkrete Anwendungsfall für `system.verwalten` + das mandanten-/automaten-parametrische Settings-Modell.

---

## User Stories

### Identität & Transport (homelab)

1. Als Eigentümer möchte ich das Dashboard im Tailnet ausschließlich über eine **HTTPS-URL** (`https://hp-mini-server.tail573a13.ts.net:8443/`) erreichen, sodass der Verkehr verschlüsselt ist und meine Identität verlässlich erkannt wird.
2. Als Eigentümer möchte ich, dass der rohe Port `8787` **nicht mehr aus dem Tailnet** erreichbar ist, sodass niemand das Dashboard unter Umgehung der Identitätsprüfung anspricht.
3. Als Eigentümer möchte ich, dass Tailscale Serve **client-gesetzte `Tailscale-*`-Header verwirft** und nur seine eigenen setzt, sodass ein eingeladenes Gastgerät sich nicht durch einen selbst gesetzten Header zum Admin machen kann.
4. Als Eigentümer möchte ich, dass die Serve-Konfiguration über das bestehende Keepalive **idempotent persistiert** wird, sodass sie einen Neustart von Mini/WSL überlebt — analog zur bereits funktionierenden n8n-HTTPS-Freigabe.
5. Als eingeladener Gast möchte ich weiterhin nur das Dashboard (jetzt `:8443`) erreichen, nicht n8n/PostgreSQL/Open WebUI/Dashy, sodass die bestehende Dienst-Trennung erhalten bleibt.

### Authentifizierung & Default-Deny (automatenlager)

6. Als Eigentümer möchte ich, dass ein Zugriff **mit** gültigem Identitäts-Header die Rolle aus diesem Header bezieht, sodass ich als Admin erkannt werde und Gäste als Gast.
7. Als Eigentümer möchte ich, dass ein Zugriff **ohne** Header nur dann Admin ist, wenn er lokal/Loopback erfolgt, sodass lokale Entwicklung und der Mini-Eigenbetrieb funktionieren, ein header-loser Tailnet-Zugriff aber **kein** Admin ist.
8. Als Eigentümer möchte ich, dass unbekannte/nicht hinterlegte Logins automatisch als **Gast** behandelt werden, sodass niemand durch bloßes Vorhandensein eines Headers privilegiert wird.
9. Als Eigentümer möchte ich einen klar definierten, dokumentierten **Notausgang** (lokaler Admin-Zugang), sodass ich mich nie durch eine Fehlkonfiguration vollständig aussperren kann.

### Rollenmodell (RBAC)

10. Als Eigentümer möchte ich Berechtigungen als **Fähigkeiten** verwalten — `betrieb.lesen`, `finanzen.lesen`, `bestand.schreiben`, `workflows.starten`, `nayax.schreiben`, `system.verwalten` —, sodass ich fein steuern kann, wer was darf.
11. Als Eigentümer möchte ich **drei Voreinstellungs-Rollen** — **Eigentümer** (alle Fähigkeiten), **Auffüller/Operator** (`betrieb.lesen` + `bestand.schreiben`, optional `workflows.starten`; **kein** `finanzen.lesen`, **kein** `system.verwalten`, **kein** `nayax.schreiben`), **Gast** (nur `betrieb.lesen`) —, sodass ich nicht jedes Mal einzelne Schalter umlegen muss.
12. Als Nutzer möchte ich nur die Reiter sehen, für die ich mindestens eine passende Fähigkeit habe, sodass die Oberfläche zu meiner Rolle passt (z. B. **GuV** nur mit `finanzen.lesen`, **Einstellungen** nur mit `system.verwalten`).
13. Als Nutzer möchte ich, dass Aktions-Buttons, die ich nicht ausführen darf, ausgeblendet sind, sodass ich nicht in Aktionen gerate, die mir ohnehin verwehrt werden.
14. Als Eigentümer möchte ich, dass jede privilegierte Aktion **serverseitig** gegen die nötige Fähigkeit geprüft wird (nicht nur im Frontend ausgeblendet), sodass ein direkter API-Aufruf ohne Berechtigung mit `403` abgewiesen wird.
15. Als Auffüller möchte ich Bestände korrigieren, Slots pflegen und Onboarding durchführen können (`bestand.schreiben`), ohne Umsätze/Margen zu sehen oder an System-Einstellungen/Nayax-Schreibzugriff zu kommen, sodass ich meine Arbeit erledige, ohne Vertrauliches einzusehen oder Riskantes auszulösen.
16. Als Gast möchte ich das Tagesgeschäft ansehen können (`betrieb.lesen`), aber keine schreibenden oder auslösenden Aktionen, sodass ich gefahrlos Einblick bekomme.

### Editierbare Schwellwerte in `/einstellungen`

17. Als Eigentümer möchte ich die **Ladenhüter-Tage** (Default 30) in den Einstellungen ändern, sodass die Slow-Mover-Klassifikation zu meinem Sortiment passt.
18. Als Eigentümer möchte ich das **MHD-Risiko-Fenster** (Default 30 Tage) ändern, sodass die MHD-Vorwarnung konsistent über Cockpit-KPI, Bestandsliste und Monitoring zu meinem Bedarf passt.
19. Als Eigentümer möchte ich pro Schwellwert ein **„auf Standard zurücksetzen"** (↺) und zusätzlich ein globales **„alle auf Standard zurücksetzen"**, sodass ich Experimente jederzeit rückgängig machen kann.
20. Als Eigentümer möchte ich Schwellwerte **global** voreinstellen, sodass sie für alle Automaten gelten, solange kein Automat abweicht.
21. Als Eigentümer möchte ich Schwellwerte **pro Automat überschreiben**, sodass ein einzelner Standort (z. B. Krankenhaus) ein anderes MHD-Fenster bekommen kann als ein anderer (z. B. Fitnessstudio).
22. Als Eigentümer möchte ich, dass nur `system.verwalten` Schwellwerte ändern darf, sodass ein Auffüller oder Gast die Warn-Logik nicht verstellen kann.
23. Als Eigentümer möchte ich, dass „Experten-Internas" (Quartil-Grenzen 25/75 %, `minPointsForQuartiles`) **nicht** Teil der normalen Editier-Oberfläche sind, sodass die fachlich klaren Werte nicht im Technik-Detail untergehen.

### Secret-Handling

24. Als Eigentümer möchte ich, dass das Speichern/Ändern von Zugangsdaten (z. B. n8n-API-Key über `POST /api/config`) nur mit `system.verwalten` möglich ist, sodass niemand sonst meine Schlüssel überschreibt.
25. Als Eigentümer möchte ich, dass gespeicherte Secrets **nie im Klartext** an den Browser zurückkommen (nur maskiert), sodass sie nicht über die Oberfläche oder den Netzwerkmitschnitt abfließen.
26. Als Eigentümer möchte ich, dass Secrets **nie in Logs oder im Audit-Trail** erscheinen, sodass ein Logfile kein Schlüsselversteck wird.
27. Als zukünftiger Anbieter möchte ich, dass Zugangsdaten im Datenmodell **je Mandant getrennt** vorgesehen sind, sodass „Nayax-API je Kunde" später ohne Umbau möglich ist.

### Audit-Trail

28. Als Eigentümer möchte ich, dass jede privilegierte Aktion (Workflow-Trigger, Nayax-Apply, Settings-/Schwellwert-Änderung, Rollenvergabe) mit **Zeitpunkt, Login, Rolle/Mandant und Aktion** festgehalten wird, sodass ich im Verdachts- oder Fehlerfall nachvollziehen kann, wer was getan hat.
29. Als Eigentümer möchte ich, dass der Audit-Eintrag das **Ergebnis** (Erfolg/abgewiesen) enthält, sodass abgewiesene Versuche (z. B. `403`) ebenfalls sichtbar sind.
30. Als Eigentümer möchte ich, dass das Audit-Format zum bestehenden Gast-Zugriffs-Log (JSONL) passt, sodass Auswertung und späterer Umzug in eine Datenbank einfach bleiben.

### Migration / Betrieb

31. Als Eigentümer möchte ich eine **klare Cutover-Reihenfolge**, sodass ich zuerst Serve+HTTPS ausrolle, meinen eigenen Admin-Zugang verifiziere und **erst dann** Default-Deny scharfschalte — ohne Selbst-Aussperrung.
32. Als Eigentümer möchte ich, dass interne Dienst-zu-Dienst-Aufrufe (z. B. `WF-Monitor` → Dashboard über das Docker-Netz, ohne Identitäts-Header) eine **definierte, eng begrenzte Regel** bekommen, sodass die Überwachung weiterläuft, ohne ein neues Loch zu reißen.

### Härtung aus dem Sicherheits-Review (Standards-Abgleich)

33. Als Eigentümer möchte ich, dass ausschließlich **exakt hinterlegte Logins** erhöhte Rollen erhalten (keine Präfix-Regel), sodass kein ähnlich aussehendes Fremd-Login (`patrick-evil@…`) privilegiert wird.
34. Als Eigentümer möchte ich, dass der **Loopback-Admin-Notausgang in Produktion deaktiviert** ist (nur per explizitem Entwicklungs-Flag aktiv), sodass kein lokaler Prozess oder Nachbarcontainer auf der Mini ohne echte Identität Admin-Rechte erlangt.
35. Als Eigentümer möchte ich, dass lesende und schreibende Endpunkte prüfen, dass ein angefragtes `machine_id` (oder andere Objekt-ID) zum **Mandanten des Viewers** gehört, sodass niemand über IDs auf fremde Daten zugreift (Objekt-Ebene, nicht nur Endpunkt-Ebene).
36. Als Eigentümer möchte ich, dass das **Audit-Log gegen nachträgliche Manipulation geschützt** ist (restriktive Dateirechte, append-only, perspektivisch off-host), sodass es im Ernstfall belastbar bleibt.
37. Als zukünftiger Anbieter möchte ich, dass spätestens mit dem **ersten echten zweiten Mandanten** ein Secret-Vault verbindlich wird, sodass nicht mehrere Kundenschlüssel im Klartext an einem Ort liegen.

### Härtung aus der zweiten Sicherheits-Meinung (F1–F7)

38. Als Eigentümer möchte ich, dass Identity-Header **nur auf dem Tailscale-Serve-Pfad** vertraut werden und Aufrufe aus dem Docker-internen Netz immer als Gast/read-only gelten, sodass ein kompromittierter Nachbar-Container (n8n, Open WebUI) keinen Admin-Login fälschen und das Dashboard unter Umgehung von Serve übernehmen kann.
39. Als Eigentümer möchte ich beim Cutover den **realen Login-Wert abgreifen, den Serve emittiert**, und meine Allowlist exakt darauf setzen, sodass ich mich beim Scharfschalten von Default-Deny nicht selbst aussperre.
40. Als Eigentümer möchte ich, dass die auf `0.0.0.0` publizierten Nachbardienste (n8n, Open WebUI) entweder auf Loopback beschränkt werden oder das LAN-Vertrauen ausdrücklich dokumentiert ist, sodass die „nur über Tailscale erreichbar"-Annahme nicht stillschweigend gebrochen wird.

---

## Implementation Decisions

### Säule 1 — Tailscale Serve / HTTPS / Binding (homelab)

- **Dashboard erhält eigenen HTTPS-Port `:8443`** über Tailscale Serve (`tailscale serve --https=8443 http://localhost:8787`). n8n behält `443`. Begründung: 443 ist belegt; ein Unterpfad auf 443 würde das Umschreiben aller absoluten App-Pfade erzwingen (fehleranfällig) — eigener Port ist risikoarm und ändert nur die sichtbare Port-Nummer.
- **Keepalive-Skript** (`wsl-keepalive.ps1`) wird angepasst: Die Zeile `--tcp=8787 tcp://localhost:8787` wird durch die HTTPS-Serve-Variante ersetzt; der netsh-Loopback-Portproxy-Block (Ports 8080/5678/8787) wird entsprechend mitgezogen/geprüft. Die Persistenz bleibt **idempotent** (mehrfaches Ausführen verändert den Zielzustand nicht).
- **docker-compose-Publish** für den Dashboard-Container wird von `8787:8787` auf `127.0.0.1:8787:8787` eingeschränkt. Container-interne Erreichbarkeit (Docker-DNS `homelab-dashboard:8787`) bleibt davon unberührt.
- **Gast-ACL** wird von `100.68.148.46:8787` auf den neuen HTTPS-Port (`:8443`) umgestellt; alle übrigen Dienste bleiben für Gäste gesperrt.
- **Doku/Runbooks** (`guest-access.md`, `homelab/CLAUDE.md`, `homelab-architecture-v1.md`) werden auf den neuen URL/Port und das korrigierte Auth-Verhalten gebracht; der bestehende Widerspruch (Doku sagt „kein Header = Gast", Code sagte „= Admin") wird aufgelöst.

### Säule 2 — Auth-Layer / Default-Deny (automatenlager)

- **`getViewer` (Deep Module).** Die Identitäts-/Rollenauflösung bleibt der **eine** Knotenpunkt für Identität → Rolle/Fähigkeiten/Mandant. Verhalten neu:
  - Header vorhanden → Login wird normalisiert und **exakt** gegen die Rollen-Konfiguration geprüft (**keine Präfix-Regel** mehr; `startsWith('patrick')` entfällt); unbekannt ⇒ **Gast**.
  - Kein Header **und** Loopback **und** explizites Entwicklungs-Flag gesetzt ⇒ **Eigentümer/Admin** (Notausgang, nur lokal/Dev). Auf der produktiven Mini ist das Flag **aus**.
  - Kein Header (sonst, inkl. produktiver Loopback ohne Flag) ⇒ **Gast** (kein Admin). Der frühere `!normalizedLogin → Admin`-Pfad **und** die Präfix-Regel entfallen.
- **Schnittstelle nach außen stabil.** `getViewer` liefert künftig `{ login, role, capabilities: Set<string>, tenantId, can(capability) }`. Bestehende Felder (`role`, ein boolescher „darf auslösen") bleiben abwärtskompatibel ableitbar (`canTriggerActions` = `can('workflows.starten')`), damit vorhandene Aufrufstellen nicht brechen.
- **Zentrale Durchsetzung.** Eine kleine Guard-Funktion (z. B. `requireCapability(viewer, cap)`) wird vor jedem privilegierten Endpunkt aufgerufen und antwortet bei Fehlen mit `403`. Betroffene Endpunkte u. a.: Workflow-Trigger (`/api/actions/:id/trigger`, `/api/v2/refill/trigger`), Nayax-Apply (`/api/v2/nayax-abgleich/apply`), Korrektur/Slot-/Onboarding-Schreibpfade, **`POST /api/config`** (heute ohne Rollen-Check; in Produktion nur durch die `N8N_API_KEY`-Env-Präzedenz mit `409` entschärft — **Sicherheits-Review F3**: diese fragile Kontrolle wird **nicht** als Sicherheit gewertet, der `system.verwalten`-Guard kommt unabhängig davon dazu), die neuen Settings-Schreibpfade.
- **Pfad-basiertes Vertrauen (Sicherheits-Review F1, Kern-Fix).** Identity-Header werden **ausschließlich auf dem Serve-Pfad** ausgewertet. Aufrufe, die über das Docker-interne Netz (`homelab-network`, z. B. `WF-Monitor` → `homelab-dashboard:8787`) eintreffen, werden **immer als Gast/read-only** behandelt und ihre `Tailscale-*`-Header **verworfen** — egal welcher Login darin steht. Damit kann ein kompromittierter Nachbar-Container (n8n, Open WebUI) keinen Admin-Login fälschen. Unterscheidung der Pfade über die Verbindungs-Quelladresse (`req.socket.remoteAddress`: Docker-Gateway/Host-Loopback = Serve-Pfad vs. Peer-Container-IP = intern) **oder** über zwei getrennte Listener (ein identitäts-tragender, Serve-zugewandter; ein interner, der nur Lese-/Health-Routen bedient). `WF-Monitor` (read-only) funktioniert unter beiden Varianten weiter; schreibende/auslösende Endpunkte und Secret-Ausgaben sind auf dem internen Pfad nicht erreichbar. Die konkrete Umsetzungsvariante wird beim Implementieren gewählt; die SPEC schreibt die **Eigenschaft** fest (interner Pfad ⇒ keine Identität, read-only).

### Säule 3 — RBAC-Modell

- **Fähigkeiten (Verben), kanonisch:** `betrieb.lesen`, `finanzen.lesen`, `bestand.schreiben`, `workflows.starten`, `nayax.schreiben`, `system.verwalten`.
- **Reiter-↔-Fähigkeit-Mapping:** Heute/Bestand/Monitoring/Automaten ⇒ `betrieb.lesen`; GuV ⇒ `finanzen.lesen`; Monitoring-Korrektur + Sortiment/Slots + Onboarding (Schreibteile) ⇒ `bestand.schreiben`; der Nayax-Abgleich-Apply-Knopf (sitzt auf Heute + Onboarding) ⇒ `nayax.schreiben`; Einstellungen ⇒ `system.verwalten`; Workflow-Trigger ⇒ `workflows.starten` (querschnittlich).
- **Drei Rollen als Fähigkeits-Bündel:** Eigentümer = alle; Auffüller = `betrieb.lesen` + `bestand.schreiben` (+ optional `workflows.starten`); Gast = `betrieb.lesen`. Rollen-/Login-Zuordnung wird konfigurativ gehalten (erweiterte Nachfolge von `DASHBOARD_ADMIN_LOGIN`), damit zusätzliche Logins ohne Code-Änderung zugewiesen werden können.
- **Frontend.** Die v3-Shell rendert Navigation und Aktions-Buttons anhand der vom Server gelieferten Fähigkeiten. Sichtbarkeit ist **Komfort**, nicht Schutz — die Autorität liegt serverseitig. UI strikt in v3-Optik (Tokens/Klassen wiederverwenden, Vanilla-JS/SVG, Logik in `lib/`).

### Schwellwerte / Settings-Modell

- **Editierbar (fachlich):** Ladenhüter-Tage (heute `slow-mover.js`, Default 30); MHD-Risiko-Fenster (heute hartes SQL-Literal `INTERVAL '30 days'`, an mehreren Stellen). Das MHD-Fenster wird **parametrisiert** und aus einer einzigen Quelle gespeist, damit Cockpit-KPI, Bestandsliste und Monitoring konsistent bleiben.
- **Fix/„Erweitert":** Quartil-Grenzen (25/75 %) und `minPointsForQuartiles` bleiben unverändert und sind kein Teil der normalen Editier-UI.
- **Persistenz:** neue PostgreSQL-Relation im Schema `automatenlager` (z. B. eine Settings-Relation mit `tenant_id`, `machine_id` *nullable*, Schlüssel, Wert). **Globale Default-Zeile** = `machine_id IS NULL`; **Pro-Automat-Override** = Zeile mit gesetztem `machine_id`. Auflösung: Override schlägt Default. Die neue Relation wird im **Drift-Guard `db-schema.js` (`EXPECTED_RELATIONS`)** deklariert.
- **API-Contract:** `GET /api/v2/settings` liefert effektive Werte (inkl. Default vs. Override-Herkunft) und Metadaten (Default, Min/Max, Einheit) für die UI; `PUT/POST` schreibt einen Wert (global oder je `machine_id`); ein Reset-Aufruf entfernt den Override bzw. setzt auf Default zurück (pro Wert und „alles"). Alle Schreibpfade erfordern `system.verwalten`. `GET /api/v2/settings/definitions` (read-only, bestehend) bleibt als Glossar-/Definitionsquelle erhalten.
- **Lese-Pfad.** `slow-mover.js` nimmt bereits `opts.ladenhueterDays`/`opts.minPointsForQuartiles` entgegen — die effektiven Werte werden künftig aus dem Settings-Modell gespeist statt aus den Konstanten. Die Konstanten bleiben als **Defaults** (Quelle der „Standard"-Werte für Reset).

### Secret-Handling

- Secret-tragende Endpunkte (`POST /api/config`, künftige Nayax-Credential-Pfade) erfordern `system.verwalten`.
- Rückgaben nur maskiert (`hasApiKey`/`apiKeyMasked` bereits vorhanden — Muster wird durchgängig angewandt).
- Secrets erscheinen nicht im Audit/Log.
- Das Zugangsdaten-Datenmodell wird **je Mandant** vorgesehen (Design-Note: Pro-Mandant-Zugangsdaten als Grundstein „Nayax je Kunde"; tatsächliche Migration der n8n-Credentials in eine DB ist **nicht** Teil dieser Phase — Env-Var-Vorrang und `.dashboard-config.json` bleiben für den Single-Tenant-Betrieb bestehen).

### Audit-Trail

- Erweiterung des bestehenden JSONL-Audits (`auditGuestAccess`-Muster) zu einem allgemeinen `auditAction(viewer, event, details, outcome)`.
- Erfasst: Workflow-Trigger, Nayax-Apply, Settings-/Schwellwert-Änderung (alt→neu, **ohne** Secret-Werte), Rollenvergabe; jeweils mit Zeitstempel (Europe/Berlin-konform zur bestehenden Formatierung), Login, Rolle/Mandant, Aktion, Ergebnis (ok/`403`/Fehler).
- Pfad/Format konsistent zum bestehenden Gast-Log; konfigurierbar über `DASHBOARD_AUDIT_LOG`.

### Mandanten-Parametrik (Fundament)

- `tenant_id` wird als Konzept eingeführt (heute nirgends vorhanden). In dieser Phase: ein fester Mandant (Eigentümer). `getViewer` liefert `tenantId`; das Settings-Modell und das Zugangsdaten-Modell tragen `tenant_id`. Datenpfade werden so geschrieben, dass eine spätere Mehr-Mandanten-Filterung (bzw. Supabase-RLS) ein Konfigurations-/Policy-Schritt ist, kein Umbau.

### Härtung aus dem Sicherheits-Review

- **Exakte Allowlist statt Präfix:** Rollen-/Login-Zuordnung erfolgt ausschließlich über exakten Login-Abgleich. Die `startsWith('patrick')`-Regel wird entfernt (Risiko: ähnlich benannte Fremd-Logins).
- **Loopback-Admin nur in Entwicklung:** Der „kein Header + Loopback = Admin"-Pfad ist hinter ein explizites Entwicklungs-Flag (z. B. `DASHBOARD_DEV_LOCAL_ADMIN`) gelegt, das in der produktiven Mini-Umgebung **nicht** gesetzt ist. Begründung: Sonst wäre jeder lokale Prozess/Nachbarcontainer auf der Mini ohne Identität Admin („Generalschlüssel im Heizungskeller"). In Produktion gibt es nur den über Serve authentifizierten, exakt hinterlegten Admin-Login.
- **Objekt-/Mandanten-Ebene (IDOR-Schutz):** API-Pfade, die ein `machine_id` (oder andere Objekt-IDs) entgegennehmen, validieren vor Lesen/Schreiben, dass die ID zum `tenantId` des Viewers gehört. Im Single-Tenant-Betrieb ein quasi-No-Op-Guard, aber als **verbindliches Pattern** etabliert (zweite Hälfte der Zugriffskontrolle neben RBAC; verhindert IDOR, sobald >1 Mandant). Bildet später Supabase-RLS ab.
- **Audit-Log-Integrität (Sicherheits-Review F4):** Heute kehrt `auditGuestAccess` bei `role !== 'guest'` sofort zurück — **Admin-Aktionen werden gar nicht protokolliert**. Der neue Audit-Trail erfasst **alle** privilegierten Aktionen inkl. **abgewiesener** Versuche (`403`) **und** Aufrufe über den internen Pfad. Audit-/Log-Dateien erhalten restriktive Dateirechte (nur der Dashboard-Prozess schreibt) und werden append-only behandelt; Off-host-Versand als nächste Ausbaustufe notiert. Ein Log, das der lokale Admin frei editieren kann, ist im Ernstfall abstreitbar.
- **n8n-Key als Kronjuwel:** `system.verwalten` + `workflows.starten` haben die größte Sprengkraft (faktische Kontrolle über n8n und damit perspektivisch die Nayax-/Zahlungsseite). Diese Fähigkeiten/Endpunkte werden als höchste Schutzklasse benannt, besonders streng geprüft und lückenlos auditiert.
- **LAN-Exposition der Nachbardienste (Sicherheits-Review F2):** `n8n` (`5678:5678`) und `open-webui` (`8080:8080`) publizieren auf `0.0.0.0` — im selben LAN wie die Mini sind sie an der Tailscale-ACL **vorbei** erreichbar. Maßnahme: Host-Publishes ebenfalls auf `127.0.0.1` beschränken (Zugriff nur über Serve) **oder** explizit dokumentieren/bestätigen, dass die Mini in einem vertrauenswürdigen, isolierten Netz steht. Gehört in diese Sicherheits-Phase (homelab-Repo), auch wenn es nicht das Dashboard selbst ist.
- **n8n Secure-Cookie (Sicherheits-Review F7):** Bei der HTTPS-/Serve-Umstellung prüfen, ob `N8N_SECURE_COOKIE` von `false` auf `true` gesetzt werden kann. Adjazent, niedrige Priorität.

---

## Testing Decisions

**Was einen guten Test ausmacht:** Getestet wird **externes Verhalten** über die HTTP-Schnittstelle und die reinen `lib/`-Funktionen — nicht interne Implementierungsdetails. Prior Art ist `dashboard/tests/dashboard-auth.test.js` (startet den echten Server auf `127.0.0.1:0`, mockt n8n, injiziert/lässt Header weg und prüft Rolle/Buttons/`403`) sowie `dashboard-v3-einstellungen.test.js`. Test-Runner: `node --test`. DB-abhängige Tests folgen dem Muster von `dashboard-db-schema.test.js` (offline überspringbar).

- **Auth/Default-Deny (HTTP, Prior Art `dashboard-auth.test.js`):**
  - Header mit exaktem Admin-Login ⇒ Admin/volle Fähigkeiten; Header mit Fremd-Login ⇒ Gast; **kein Header + Loopback + Dev-Flag** ⇒ Admin; **kein Header + Loopback ohne Dev-Flag** ⇒ Gast; **kein Header + nicht-lokal** ⇒ Gast (Kern-Regression gegen den alten `!header → Admin`-Fehler).
  - **Exakte Allowlist:** ein Login, das mit `patrick` beginnt, aber nicht exakt hinterlegt ist (z. B. `patrick-evil@…`), ⇒ **Gast** (Regression gegen die entfernte Präfix-Regel).
  - **Header-Spoofing-Regression:** ein client-gesetzter `Tailscale-User-Login` darf ohne Serve nicht zu Admin führen (Loopback+Dev-Flag ausgenommen) — sichert die Default-Deny-Semantik ab, die Serve voraussetzt.
- **Objekt-/Mandanten-Ebene:** Ein Aufruf mit einem `machine_id`, das nicht zum `tenantId` des Viewers gehört, wird abgewiesen (bzw. liefert leer); im Single-Tenant-Betrieb prüft der Test, dass der Guard vorhanden ist und passende IDs durchlässt.
- **Audit-Integrität:** Audit-Datei wird mit restriktiven Rechten angelegt; Secret-Werte erscheinen nicht im Eintrag (bereits oben), Einträge werden nur angehängt; eine privilegierte **und** eine abgewiesene Aktion erzeugen jeweils einen Eintrag.
- **Pfad-basiertes Vertrauen (F1, Kern-Regression):** Ein Aufruf, der den internen Pfad simuliert (Peer-Container-Quelladresse) und einen **gefälschten** `Tailscale-User-Login: <Admin>` mitschickt, wird als **Gast/read-only** behandelt (Header ignoriert); ein schreibender/auslösender Endpunkt über den internen Pfad ⇒ `403`; ein read-only Health-/Lese-Aufruf (wie `WF-Monitor`) ⇒ erfolgreich. Gegenprobe: derselbe Header über den Serve-Pfad ⇒ Admin. Prior Art: Quelladress-/Header-Steuerung in `dashboard-auth.test.js`.
- **RBAC-Durchsetzung (HTTP):** Für jede Fähigkeit je ein Positiv-/Negativ-Fall an einem repräsentativen Endpunkt; insbesondere `POST /api/config` ohne `system.verwalten` ⇒ `403` (heute fehlende Prüfung). Nav-/Button-Sichtbarkeit wird über die vom Server gelieferten Fähigkeiten geprüft.
- **Schwellwerte (lib + HTTP):** Default-Auflösung (kein Override ⇒ Default), Pro-Automat-Override schlägt Default, Reset pro Wert und „alles"; `slow-mover`-Klassifikation reagiert auf geänderte Ladenhüter-Tage; MHD-Fenster-Parametrisierung liefert konsistente Werte über die betroffenen Lesepfade. Schreibpfade nur mit `system.verwalten`.
- **Secret-Handling:** Schreiben nur mit `system.verwalten`; Rückgabe maskiert; Audit-Eintrag enthält **keinen** Secret-Wert.
- **Audit-Trail:** Privilegierte Aktion erzeugt einen JSONL-Eintrag mit erwarteten Feldern; abgewiesener Versuch (`403`) wird ebenfalls protokolliert; keine Secret-Leckage.
- **Schema-Drift:** Die neue Settings-Relation ist in `EXPECTED_RELATIONS` deklariert; `dashboard-db-schema.test.js` bleibt grün (bzw. offline übersprungen).
- **homelab-Infra:** Test/Prüfung analog zu `infra/scripts/test-dashboard-migration.sh` — Serve nutzt `--https=8443`, docker-compose publiziert nur auf `127.0.0.1`, ACL zeigt auf `:8443`, kein roher `8787`-Publish mehr. Idempotenz des Keepalive-Skripts wird geprüft.
- **Regressionsschutz Bestand:** Die bestehende Test-Suite (Stand zuletzt 564/564) muss grün bleiben; bestehende Endpunkte verhalten sich für berechtigte Rollen unverändert.

---

## Out of Scope

- **Kunden-Selbstregistrierung, App-Logins mit Passwort, 2FA.** Kommt erst mit dem Internet-Umzug (Vercel/Supabase). Diese Phase bleibt identitäts-basiert über Tailscale.
- **Der Umzug nach Vercel/Supabase** selbst (Hosting, Supabase-Auth, RLS-Policies, Migration des Servers in Serverless-Funktionen, n8n-Hosting-Entscheidung).
- **Das Feature „System → Nayax pushen"** (Gegenrichtung). Diese Phase **ermöglicht** es (Rolle `nayax.schreiben`, Audit, mandanten-getrennte Secrets), baut es aber nicht.
- **Tatsächlicher Mehr-Mandanten-Betrieb** (mehrere echte Kunden, Mandanten-Onboarding-UI). Es bleibt bei einem Mandanten; nur die Parametrik wird gelegt.
- **Migration der n8n-Credentials von Datei in eine DB.** Env-Var-Vorrang und `.dashboard-config.json` bleiben für den Single-Tenant-Betrieb; nur Zugriffsschutz/Maskierung werden gehärtet.
- **Editierbarkeit der Quartil-Internas** (25/75 %, `minPointsForQuartiles`) in der normalen UI.
- **Verschlüsselung at-rest / Secret-Vault.** Für Homelab-Single-Tenant akzeptierter Trade-off; der echte Vault kommt mit Supabase. **Harte Bedingung:** Sobald die echten Zugangsdaten eines **zweiten Mandanten** gespeichert werden, wird der Vault verbindlich — mehrere Kundenschlüssel dürfen nicht im Klartext an einem Ort liegen.
- **Rate-Limiting / Brute-Force-Schutz, CSRF-Schutz, MFA.** Für die identitäts-basierte Tailnet-Postur ohne Cookie-/Passwort-Login derzeit nicht erforderlich; werden mit dem Internet-/Login-Schritt (Supabase) Pflicht und sind dort umzusetzen.

---

## Further Notes

- **Cutover-Reihenfolge ist sicherheitskritisch (Selbst-Aussperr-Schutz):** (1) Serve+HTTPS `:8443` ausrollen und persistieren; (2) eigenen Admin-Zugang über die neue HTTPS-URL verifizieren und dabei den **exakten Login-String abgreifen, den Serve im `Tailscale-User-Login`-Header emittiert**, und `DASHBOARD_ADMIN_LOGIN` **exakt** darauf setzen (**Sicherheits-Review F6**: weicht der reale Wert — z. B. Tailnet-Handle vs. E-Mail — vom konfigurierten ab, sperrt die exakte Allowlist dich selbst aus); (3) Loopback-Publish + ACL umstellen; (4) **erst dann** Default-Deny im Dashboard scharfschalten. Der lokale Loopback-Admin (Dev-Flag) bleibt während des Cutovers als Notausgang erhalten. Falls Schritt 2 fehlschlägt, wird Default-Deny **nicht** aktiviert.
- **Zwei-Repo-Koordination:** Die homelab-Änderungen (Serve/Publish/ACL/Keepalive) und die automatenlager-Änderungen (Default-Deny/RBAC) hängen zusammen; die Issues sollten die Reihenfolge explizit referenzieren.
- **`WF-Monitor`** ist durch den Loopback-Publish **nicht** betroffen (Docker-internes DNS), braucht aber die definierte read-only-Regel; das ist beim Scharfschalten von Default-Deny mitzuverifizieren.
- **Doku-Konsistenz:** Der aufgelöste Widerspruch (Doku vs. Code) sollte in `homelab/CLAUDE.md` und `guest-access.md` als korrigiert festgehalten werden, damit das Auth-Verhalten künftig eindeutig dokumentiert ist.
- **Forward-Kompatibilität Supabase:** Fähigkeiten-Modell + `tenant_id`/`machine_id`-Parametrik sind bewusst so gewählt, dass sie sich auf einen Supabase-Role-Claim + RLS-Policies abbilden lassen; der teure spätere Schritt ist dann Hosting/Login, nicht das Datenmodell.
- **Standards-Abgleich:** Die SPEC wurde gegen OWASP ASVS, OWASP Top 10 (A01 Broken Access Control) und Fail-Secure-/Least-Privilege-Prinzipien geprüft. Für die Homelab-/Tailnet-Postur erfüllt sie diese; die für eine internetfähige SaaS-Postur zusätzlich nötigen Kontrollen (App-Login/MFA, Rate-Limiting, CSRF, Secret-Vault, RLS-Durchsetzung) sind bewusst und benannt auf die Supabase-Phase verschoben — mit den oben festgeschriebenen harten Bedingungen, ab wann sie verbindlich werden.
- **Zweite unabhängige Sicherheits-Meinung (security-review):** Ein eigener defensiver Review hat die Funde F1–F7 ergänzt. **F1 (Hoch, Kern):** Der Docker-interne Pfad umgeht Tailscale Serve — der Loopback-Bind allein verhindert Header-Spoofing nicht; Identity-Header dürfen nur auf dem Serve-Pfad zählen. **F3:** `POST /api/config` ist in Produktion durch Env-Präzedenz entschärft (Korrektur einer früheren Annahme), bekommt aber dennoch einen `system.verwalten`-Guard. **F6:** Cutover muss den realen Serve-Header-Wert exakt in die Allowlist übernehmen (Aussperr-Falle). F2/F4/F7 als Hardening-Notizen aufgenommen. **Offene Verifikationspunkte vor Inbetriebnahme:** (a) überschreibt `tailscale serve --https` client-gesetzte `Tailscale-*`-Header zuverlässig; (b) steht die Mini in einem vertrauenswürdigen LAN; (c) exakter von Serve emittierter Login-String.
