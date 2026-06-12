FROM node:22-alpine
# #216: PG-17-Clients (pg_dump/pg_restore) für das Off-Site-Backup der
# Supabase-DB (PG 17 — ältere Clients brechen mit "server version mismatch").
RUN apk add --no-cache postgresql17-client
WORKDIR /repo/dashboard
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8787
CMD ["node", "server.js"]
