# Build from monorepo root: docker build -f apps/ui/Dockerfile .
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY patches patches
COPY apps/ui/package.json apps/ui/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN bunx pnpm install --frozen-lockfile

FROM oven/bun:1.2-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/ui/node_modules ./apps/ui/node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY apps/ui ./apps/ui
COPY apps/backend/src ./apps/backend/src
RUN bunx pnpm --filter @ctxpipe/ui build

# Production stage — Vinxi outputs a self-contained server bundle
FROM oven/bun:1.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/ui/.output ./.output
EXPOSE 3002
CMD ["bun", "run", ".output/server/index.mjs"]
