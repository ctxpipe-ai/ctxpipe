# Build from monorepo root: docker build -f apps/backend/Dockerfile .
FROM oven/bun:1.2-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
RUN bunx pnpm install --frozen-lockfile
COPY apps/backend apps/backend
COPY adr adr
RUN bunx pnpm --filter @ctxpipe/backend build

# Production stage
FROM oven/bun:1.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/backend/dist ./dist
COPY --from=builder /app/apps/backend/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["bun", "run", "dist/server.js"]
