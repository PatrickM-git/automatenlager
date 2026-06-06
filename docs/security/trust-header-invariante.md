# Trust-Header-Invariante (Vertrauensgrenze)

> Stufe 2 der Mandantenfähigkeit (Issues #117/#118). SPEC:
> `docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md`.

## Welche Header sind „Trust-Header"?

Header, deren bloße Präsenz dem Aufrufer Identität oder Rechte verleiht und die
deshalb **client-kontrolliert nicht vertrauenswürdig** sind:

- `Tailscale-User-Login` — die Identität (→ Rolle/Mandant). Quelle der gesamten Auth.
- `X-Support-Tenant` — der Break-Glass-Mandanten-Override eines Plattform-Admins (#118).

## App-seitiger Schutz (in Stufe 2 umgesetzt)

`dashboard/lib/auth.js` honoriert diese Header **nur auf dem vertrauenswürdigen
Identity-Pfad** (F1, `isTrustedIdentityPath`): über einen nicht vertrauenswürdigen
Pfad (`DASHBOARD_INTERNAL_PEER_CIDR`) wird der `Tailscale-*`-Login verworfen, und
ein `X-Support-Tenant`-Override wird ignoriert (`denyReason = 'untrusted_path'`) und
auditiert. Da das Plattform-Admin-Flag transitiv aus dem — auf untrautem Pfad
ohnehin verworfenen — Identity-Header stammt, ist der Override auf untrautem Pfad
nie honorierbar; die explizite Pfad-Bedingung ist der zweite Riegel.

## Infrastruktur-Invariante (PFLICHT für jeden künftigen Reverse-Proxy / CDN)

Sobald ein Reverse-Proxy, Load-Balancer oder CDN **vor** das Dashboard gesetzt wird,
**muss** dieser:

1. **Eingehende Trust-Header an der Kante verwerfen** — jeder von außen kommende
   `X-Support-Tenant`, `Tailscale-*` (und gleichartige Identity-/Trust-Header) wird
   gelöscht, *bevor* die Anfrage das Dashboard erreicht. Ein Client darf niemals
   einen dieser Header durchreichen können.
2. **Trust-Header nur intern setzen** — die vertrauenswürdige Identität wird
   ausschließlich vom Proxy selbst (nach echter Authentifizierung) gesetzt.
3. Dieselbe Klasse wie die bestehende F1-Pfad-Trust- / `DASHBOARD_INTERNAL_PEER_CIDR`-
   Regel: interne Docker-Peers gelten als read-only, ihre Header werden verworfen.

Wird (1) verletzt, kann ein beliebiger Client `Tailscale-User-Login` (Identitäts-
Spoofing) oder `X-Support-Tenant` (Cross-Tenant-Lesezugriff) fälschen.

**Status:** In Stufe 2 läuft KEIN neuer Proxy — der Tailscale-Serve-Pfad ist der
einzige Eingang (Loopback/Serve-IP = vertrauenswürdig). Diese Invariante ist eine
**Vorab-Verpflichtung** für den Tag, an dem ein Proxy/CDN eingeführt wird; bis dahin
genügt der App-seitige Schutz. Eigene Homelab-Notiz/-Issue beim Proxy-Aufbau vorsehen.
