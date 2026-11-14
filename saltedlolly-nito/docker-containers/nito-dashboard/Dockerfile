# syntax=docker/dockerfile:1
#
# Original Node/TypeScript backend + React dashboard for a Nito node
# (latest blocks, sync progress, peers and where they are, mempool, charts) -
# connects to a separately-running node's RPC over the network rather than
# bundling the node itself. See saltedlolly-nito's docker-compose.yml for how
# this is wired to Nito-Tools/docker-nito.
#
# Not derived from getumbrel/umbrel-bitcoin's code (PolyForm Noncommercial
# licensed) - inspired by its general approach (poll standard Bitcoin Core
# JSON-RPC, which Nito's fork implements unmodified) but sharing none of
# its code.

FROM --platform=$BUILDPLATFORM node:24-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM node:24-slim AS backend-builder
WORKDIR /backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# DB-IP's free IP-to-country database (CC BY 4.0, https://db-ip.com), for
# placing peers on the map. Looked up offline in the container: peer
# addresses are never sent anywhere. A new file comes out each month; the
# previous month's is used if this month's isn't out yet.
FROM --platform=$BUILDPLATFORM node:24-slim AS geo
WORKDIR /geo
RUN node -e ' \
  const { gunzipSync } = require("node:zlib"); \
  const { writeFileSync } = require("node:fs"); \
  (async () => { \
    const now = new Date(); \
    for (const back of [0, 1, 2]) { \
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); \
      const month = d.toISOString().slice(0, 7); \
      const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`; \
      const res = await fetch(url); \
      if (!res.ok) { console.log(`${url}: HTTP ${res.status}`); continue; } \
      writeFileSync("dbip-country-lite.mmdb", gunzipSync(Buffer.from(await res.arrayBuffer()))); \
      console.log(`Downloaded ${url}`); \
      return; \
    } \
    throw new Error("No DB-IP country database could be downloaded"); \
  })().catch((err) => { console.error(err); process.exit(1); });'

FROM node:24-slim
COPY --from=backend-builder /backend/dist /app/dist
COPY --from=backend-builder /backend/node_modules /app/node_modules
COPY --from=backend-builder /backend/package.json /app/package.json
COPY --from=frontend-builder /frontend/dist /app/public
COPY --from=geo /geo/dbip-country-lite.mmdb /app/geo/dbip-country-lite.mmdb

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000
USER node
WORKDIR /app
CMD ["node", "dist/server.js"]
