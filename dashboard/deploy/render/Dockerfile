# Render-Build (Issue #217) — Docker-Image für den Cloud-Web-Service.
# ---------------------------------------------------------------------------
# Spiegelt den Mini-Betrieb EXAKT: dort ist das GANZE Repo unter /repo gemountet
# (Bind-Mount) und WORKDIR=/repo/dashboard. Server.js liest einige Legacy-Dateien
# aus dem Repo-Root (ROOT = /repo: WF*.json, XLSX) — deshalb nimmt dieses Image
# das ganze Repo mit (Build-Context = Repo-Root), nicht nur dashboard/. So gibt
# es in der Cloud keinerlei „Datei fehlt"-Überraschung gegenüber dem Mini.
#
# Der Mini behält sein schlankes dashboard/Dockerfile (Context=dashboard) —
# dieses hier ist NUR für Render (render.yaml zeigt darauf).
FROM node:22-alpine

# PG-17-Client (Backup-Job; auf Render i. d. R. inaktiv, aber harmlos vorhanden).
RUN apk add --no-cache postgresql17-client

WORKDIR /repo

# Erst nur die Manifest-Dateien kopieren (Docker-Layer-Cache: npm ci läuft nur neu,
# wenn sich package.json/package-lock.json ändern).
COPY dashboard/package*.json dashboard/
RUN cd dashboard && npm ci --omit=dev

# Dann das ganze Repo (WF*.json, XLSX im Root + dashboard/ inkl. public/, lib/, …).
COPY . .

WORKDIR /repo/dashboard
EXPOSE 8787
CMD ["node", "server.js"]
