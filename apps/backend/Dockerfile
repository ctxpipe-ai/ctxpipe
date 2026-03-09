# Build from monorepo root: docker build -f apps/backend/Dockerfile .
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/backend/package.json apps/backend/package.json
RUN pnpm install --frozen-lockfile --prod

# Production stage — Bun runs TypeScript natively, no tsc compilation needed
FROM oven/bun:1.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY tsconfig.json ./
COPY apps/backend/src ./apps/backend/src
COPY apps/backend/migrations ./apps/backend/migrations
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/backend/tsconfig.json ./apps/backend/tsconfig.json
EXPOSE 3000
CMD ["sh", "-c", "bun run apps/backend/src/db/migrate.ts && bun run apps/backend/src/server.ts"]
