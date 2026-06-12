#!/bin/bash
# Cloudflare-Pages-Build (Etappe 3): statisches Output-Verzeichnis zusammenstellen.
# Als "Build command" im Pages-Projekt eintragen, Output-Verzeichnis = cf-dist.
#
#   bash dashboard/deploy/cloudflare/build.sh
#
# SICHERER WEG (Proxy, H2-Fix): Frontend UND API laufen same-origin über
# Cloudflare. Ein Advanced-Mode-Worker (_worker.js) im Output-Root fängt ALLE
# Requests ab: /api,/health,/internal → Proxy ans Render-Backend (mit geheimem
# Origin-Header), alles andere → statische Assets mit SPA-Routing. config.js
# bleibt LEER (same-origin); der v3.js-Fetch-Shim schickt /api/* an dieselbe
# Domain, wo der Worker sie übernimmt. Kein CORS, kein API-Base.
#
# Warum _worker.js statt functions/: Cloudflare sucht ein functions/-Verzeichnis
# im PROJEKT-Wurzelverzeichnis (nicht im Build-Output) — aus einem Monorepo-
# Unterordner heraus wird es nicht erkannt. Ein _worker.js im Build-Output-Root
# ist dagegen eindeutig (Advanced Mode). Dabei werden _redirects/_headers
# ignoriert ⇒ SPA-Routing steckt im Worker.
#
# Render-Backend-URL + Secret werden NICHT hier eingebaut, sondern als
# Cloudflare-Pages-Env-Variablen gesetzt (RENDER_API_BASE, CF_ORIGIN_SECRET) —
# die liest der Worker zur Laufzeit. So steht kein Secret im Output/Git.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$HERE/../../public"
OUT="${CF_OUTPUT_DIR:-./cf-dist}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$PUBLIC"/. "$OUT"/

# config.js leer/same-origin (der Proxy hält Frontend+API unter einer Domain).
printf '%s\n' "window.__API_BASE__ = '';" > "$OUT/config.js"

# Advanced-Mode-Worker ins Output-Root (übernimmt Proxy + SPA-Routing).
cp "$HERE/_worker.js" "$OUT/_worker.js"

echo "Cloudflare-Output bereit in $OUT (Advanced-Mode-Worker: /api/* → Render, sonst Assets)"
