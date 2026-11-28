# Build from monorepo root: docker build -f apps/ui/Dockerfile .
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
ENV CI=true
RUN npm install -g pnpm@11.28.13
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY patches patches
COPY apps/ui/package.json apps/ui/package.json
COPY apps/backend/package.json apps/backend/package.json
# apps/backend links @ctxpipe/visual-review (workspace:*). pnpm 11.28.13 and
# later stop a frozen install when the manifest of a linked workspace package
# is missing.
COPY packages/visual-review/package.json packages/visual-review/package.json
# The pnpm store is a BuildKit cache mount (scripts/checks/README.md, Builds).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --store-dir /pnpm/store --frozen-lockfile

# The backend and shared files that the UI bundle imports as values
# (scripts/checks/ui-bundled-imports.mjs). The builder copies only these
# files, so a backend change outside them does not rebuild the bundle.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS ui-imports
WORKDIR /app
COPY apps/ui/src apps/ui/src
COPY apps/backend/src apps/backend/src
COPY shared shared
COPY scripts/checks/ui-bundled-imports.mjs scripts/checks/ui-bundled-imports.mjs
RUN node scripts/checks/ui-bundled-imports.mjs /out

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
WORKDIR /app
ENV CI=true
# This stage has the node_modules of the deps stage but no workspace files. Do
# not let pnpm 11 install again before the build (verifyDepsBeforeRun).
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
RUN npm install -g pnpm@11.28.13
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/ui/node_modules ./apps/ui/node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY apps/ui ./apps/ui
COPY --from=ui-imports /out/ ./
ARG VITE_PUBLIC_API_URL=http://localhost:3000
ENV VITE_PUBLIC_API_URL=$VITE_PUBLIC_API_URL
# Node sets a heap limit of about 2 GB on a Docker Desktop VM with 8 GB of
# memory, and the Vite build needs more.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @ctxpipe/ui build

# Production stage — Nitro/Vinxi outputs a self-contained server bundle to .output/
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production
# Nitro defaults to localhost; Railway healthchecks hit the container IP, so bind all interfaces.
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
# Bun closes a silent request after 10 s by default. The backend waits 15 s
# for a page (UI_PROXY_TIMEOUT_MS), so keep the UI server open longer than that.
ENV NITRO_BUN_IDLE_TIMEOUT=30
COPY --from=builder /app/apps/ui/.output ./.output
EXPOSE 3002
CMD ["bun", "run", ".output/server/index.mjs"]
