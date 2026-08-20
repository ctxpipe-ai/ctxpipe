# Build from monorepo root: docker build -f apps/backend/Dockerfile .
FROM node:22-alpine AS opencode
RUN npm install -g opencode-ai

FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
ENV CI=true
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/backend/package.json apps/backend/package.json
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# Production stage — Bun runs TypeScript natively, no tsc compilation needed
FROM oven/bun:1.2-alpine
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:${PATH}"
# GNU find: TanStack sandbox watch on Linux exec-polls with `find -printf`.
# OpenCode: `opencodeText` spawns `opencode serve` in the local-process sandbox.
RUN apk add --no-cache findutils
COPY --from=opencode /usr/local/bin/ /usr/local/bin/
COPY --from=opencode /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY tsconfig.json ./
COPY apps/backend/src ./apps/backend/src
COPY apps/backend/public ./apps/backend/public
COPY apps/backend/migrations ./apps/backend/migrations
COPY apps/backend/openworkflow.config.ts ./apps/backend/openworkflow.config.ts
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/backend/tsconfig.json ./apps/backend/tsconfig.json
EXPOSE 3000
CMD ["bun", "run", "apps/backend/src/server.ts"]
