#!/bin/bash
# #218 Cloudflare-Pages-Build: statisches Output-Verzeichnis zusammenstellen.
# Als "Build command" im Pages-Projekt eintragen (oder lokal ausführen und das
# Ergebnis hochladen). Output-Verzeichnis = ./cf-dist.
#
#   RENDER_BACKEND_URL=https://faltrix-dashboard.onrender.com \
#     bash dashboard/deploy/cloudflare/build.sh
#
# Kopiert public/ (v3.*, login.html, Assets), überschreibt config.js mit der
# Cloud-Variante (Render-URL eingesetzt) und legt _redirects/_headers ins Root.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$HERE/../../public"
OUT="${CF_OUTPUT_DIR:-./cf-dist}"
: "${RENDER_BACKEND_URL:?RENDER_BACKEND_URL muss gesetzt sein (z. B. https://faltrix-dashboard.onrender.com)}"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$PUBLIC"/. "$OUT"/

# config.js mit der echten Render-URL überschreiben (Platzhalter ersetzen).
sed "s#https://RENDER_BACKEND_URL#${RENDER_BACKEND_URL%/}#" "$HERE/config.cloud.js" > "$OUT/config.js"
cp "$HERE/_redirects" "$OUT/_redirects"
cp "$HERE/_headers" "$OUT/_headers"

echo "Cloudflare-Output bereit in $OUT (API-Basis: $RENDER_BACKEND_URL)"
