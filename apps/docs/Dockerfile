# Build from monorepo root: docker build -f apps/docs/Dockerfile .
FROM oven/bun:1.3.11-alpine AS deps
WORKDIR /app
ENV CI=true
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY patches patches
COPY apps/docs/package.json apps/docs/package.json
RUN pnpm install --frozen-lockfile --filter @ctxpipe/docs...

FROM oven/bun:1.3.11-alpine AS builder
WORKDIR /app
ENV CI=true
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/docs/node_modules ./apps/docs/node_modules
COPY apps/docs ./apps/docs
RUN cd apps/docs && bun run build

# Production stage
FROM oven/bun:1.3.11-alpine
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production
COPY --from=builder /app/apps/docs/.next/standalone ./
COPY --from=builder /app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=builder /app/apps/docs/public ./apps/docs/public
EXPOSE 3003
ENV PORT=3003
CMD ["bun", "run", "apps/docs/server.js"]
