# syntax=docker/dockerfile:1
#
# Original Node/TypeScript backend + React dashboard for a Nito node
# (block height, sync progress, peers, mempool, uptime) - connects to a
# separately-running node's RPC over the network rather than bundling the
# node itself. See saltedlolly-nito's docker-compose.yml for how this is
# wired to Nito-Tools/docker-nito.
#
# Not derived from getumbrel/umbrel-bitcoin's code (PolyForm Noncommercial
# licensed) - inspired by its general approach (poll standard Bitcoin Core
# JSON-RPC, which Nito's fork implements unmodified) but sharing none of
# its code.

FROM --platform=$BUILDPLATFORM node:22-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-slim AS backend-builder
WORKDIR /backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:22-slim
COPY --from=backend-builder /backend/dist /app/dist
COPY --from=backend-builder /backend/node_modules /app/node_modules
COPY --from=backend-builder /backend/package.json /app/package.json
COPY --from=frontend-builder /frontend/dist /app/public

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000
USER node
WORKDIR /app
CMD ["node", "dist/server.js"]
