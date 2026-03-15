# Build from monorepo root: docker build -f apps/codesearch/Dockerfile .

# ── Stage 1: Build Zoekt Go binaries ─────────────────────────────────────────
FROM golang:1.22-alpine AS zoekt-builder
RUN apk add --no-cache git
RUN GOTOOLCHAIN=auto GOBIN=/zoekt-bin \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-index@latest && \
    GOTOOLCHAIN=auto GOBIN=/zoekt-bin \
    go install github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest

# ── Stage 2: Install Node dependencies ───────────────────────────────────────
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
ENV CI=true
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# ── Stage 3: Production runtime ──────────────────────────────────────────────
FROM oven/bun:1.2-alpine
RUN apk add --no-cache git

WORKDIR /app
ENV CI=true

COPY --from=zoekt-builder /zoekt-bin/zoekt-index /usr/local/bin/zoekt-index
COPY --from=zoekt-builder /zoekt-bin/zoekt-webserver /usr/local/bin/zoekt-webserver

ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/codesearch/node_modules ./apps/codesearch/node_modules
COPY tsconfig.json ./
COPY apps/codesearch/src ./apps/codesearch/src
COPY apps/codesearch/package.json ./apps/codesearch/package.json
COPY apps/codesearch/tsconfig.json ./apps/codesearch/tsconfig.json

COPY apps/codesearch/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /data/zoekt-index /data/repo-cache

EXPOSE 3001
CMD ["/start.sh"]
