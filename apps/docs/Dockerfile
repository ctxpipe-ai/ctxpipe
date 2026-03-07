# Build from monorepo root: docker build -f apps/docs/Dockerfile .
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY patches patches
COPY apps/docs/package.json apps/docs/package.json
RUN pnpm install --frozen-lockfile --filter @ctxpipe/docs...

FROM oven/bun:1.2-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/docs/node_modules ./apps/docs/node_modules
COPY apps/docs ./apps/docs
RUN cd apps/docs && ../node_modules/.bin/next build

# Production stage
FROM oven/bun:1.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/docs/.next/standalone ./
COPY --from=builder /app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=builder /app/apps/docs/public ./apps/docs/public
EXPOSE 3003
ENV PORT=3003
CMD ["node", "apps/docs/server.js"]
