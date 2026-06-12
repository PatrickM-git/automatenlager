#!/bin/bash
# Cloudflare-Pages-Build (Etappe 3): statisches Output-Verzeichnis zusammenstellen.
# Als "Build command" im Pages-Projekt eintragen, Output-Verzeichnis = cf-dist.
#
#   bash dashboard/deploy/cloudflare/build.sh
#
# SICHERER WEG (Proxy, H2-Fix): Frontend UND API laufen same-origin über
# Cloudflare. Die /api/*-Calls fängt die Pages-Function functions/api/[[path]].js
# ab und proxied sie ans Render-Backend (mit geheimem Origin-Header). config.js
# bleibt deshalb LEER (same-origin) — der v3.js-Fetch-Shim schickt /api/* dann
# an dieselbe Domain, wo die Function sie übernimmt. Kein CORS, kein API-Base.
#
# Render-Backend-URL + Secret werden NICHT hier eingebaut, sondern als
# Cloudflare-Pages-Env-Variablen gesetzt (RENDER_API_BASE, CF_ORIGIN_SECRET) —
# die liest die Function zur Laufzeit. So steht kein Secret im Output/Git.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$HERE/../../public"
OUT="${CF_OUTPUT_DIR:-./cf-dist}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$PUBLIC"/. "$OUT"/

# config.js leer/same-origin (der Proxy hält Frontend+API unter einer Domain).
printf '%s\n' "window.__API_BASE__ = '';" > "$OUT/config.js"

# SPA-Routing + Header.
cp "$HERE/_redirects" "$OUT/_redirects"
cp "$HERE/_headers" "$OUT/_headers"

# Pages-Function (API-Proxy) ins Output-Root.
mkdir -p "$OUT/functions/api"
cp "$HERE/functions/api/[[path]].js" "$OUT/functions/api/[[path]].js"

echo "Cloudflare-Output bereit in $OUT (Proxy-Modus: /api/* → Render via Pages-Function)"
