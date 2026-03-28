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
FROM oven/bun:1.2-alpine AS runtime
# universal-ctags (Alpine package `ctags`) so zoekt-index records symbol metadata for sym: queries
# CodeGraphContext (`cgc`) + embedded Kùzu for per-checkout code graphs (KUZUDB_PATH)
# build-base/cmake: pip may compile kuzu / tree-sitter on platforms without prebuilt wheels (e.g. arm64)
RUN apk add --no-cache git ctags python3 py3-pip build-base cmake && \
    python3 -m pip install --no-cache-dir --break-system-packages \
      "codegraphcontext==0.3.1" "kuzu" && \
    python3 -c "import shutil; assert shutil.which('cgc'), 'cgc CLI not on PATH after install'"

WORKDIR /app
ENV CI=true

COPY --from=zoekt-builder /zoekt-bin/zoekt-index /usr/local/bin/zoekt-index
COPY --from=zoekt-builder /zoekt-bin/zoekt-webserver /usr/local/bin/zoekt-webserver

ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/codesearch/node_modules ./apps/codesearch/node_modules
COPY tsconfig.json ./
COPY apps/codesearch/src ./apps/codesearch/src
COPY apps/codesearch/scripts ./apps/codesearch/scripts
COPY apps/codesearch/package.json ./apps/codesearch/package.json
COPY apps/codesearch/tsconfig.json ./apps/codesearch/tsconfig.json

COPY apps/codesearch/start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /data/zoekt-index /data/repo-cache

EXPOSE 3001
CMD ["/start.sh"]

# ── Stage 4: Vitest (reuses runtime Python/CGC; adds devDependencies) ────────
# Build: docker build -f apps/codesearch/Dockerfile --target test -t ctxpipe-codesearch:test .
# Run:   docker run --rm ctxpipe-codesearch:test
FROM runtime AS test
ENV NODE_ENV=development
RUN bun install -g pnpm@10.12.1
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/codesearch/package.json apps/codesearch/package.json
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false
COPY apps/codesearch ./apps/codesearch
WORKDIR /app/apps/codesearch
CMD ["pnpm", "exec", "vitest", "run"]

# Default image (no --target) must stay production; tests use --target test
FROM runtime
