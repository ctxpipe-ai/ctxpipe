# Build from monorepo root: docker build -f apps/backend/Dockerfile .
FROM node:24.22.1-alpine AS opencode
RUN npm install -g opencode-ai@1.18.34

FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
ENV CI=true
# pnpm is a Node CLI. Running it through Bun can stall during lifecycle scripts.
RUN apk add --no-cache nodejs
RUN bun install -g pnpm@10.12.1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY patches patches
COPY apps/backend/package.json apps/backend/package.json
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# The MCP eval client (apps/backend/evals/mcp/run.ts) as one bundled file:
# the AWS cutover rehearsal runs it in a one-off task of this image
# (CTX-1217). Its dependencies are dev dependencies, so they stay in this
# stage, and the server never loads the bundle.
FROM deps AS evals
COPY packages/visual-review/package.json packages/visual-review/package.json
RUN pnpm install --frozen-lockfile --filter @ctxpipe/backend... --config.confirmModulesPurge=false
COPY packages/visual-review packages/visual-review
COPY apps/backend/src apps/backend/src
COPY shared shared
COPY apps/backend/evals/mcp apps/backend/evals/mcp
RUN bun build apps/backend/evals/mcp/run.ts --target=bun --outfile /out/run.bundle.js

# Production stage — Bun runs TypeScript natively, no tsc compilation needed
FROM oven/bun:1.4.4-alpine
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:${PATH}"
# GNU find: TanStack sandbox watch on Linux exec-polls with `find -printf`.
# OpenCode: `opencodeText` spawns `opencode serve` in the local-process sandbox.
# git: clone-tree and paste-URL hydrate/explorer spawn the git CLI.
# postgresql17-client: the cutover copy (src/scripts/copyDatabase.ts) runs
# pg_dump and pg_restore in a one-off task of this image.
RUN apk add --no-cache findutils git postgresql17-client
COPY --from=opencode /usr/local/bin/ /usr/local/bin/
COPY --from=opencode /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY tsconfig.json ./
COPY shared ./shared
COPY apps/backend/src ./apps/backend/src
# The RDS CA bundle (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
# Aurora certificates chain to these CAs, which are not public roots. The
# OpenWorkflow driver (the postgres package) reads no sslrootcert from the
# URL, so the process must trust the bundle. Bun and Node read this variable.
COPY apps/backend/certs/rds-global-bundle.pem ./apps/backend/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/apps/backend/certs/rds-global-bundle.pem
COPY apps/backend/ingest-skills ./apps/backend/ingest-skills
COPY apps/backend/public ./apps/backend/public
COPY apps/backend/migrations ./apps/backend/migrations
COPY apps/backend/openworkflow.config.ts ./apps/backend/openworkflow.config.ts
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/backend/tsconfig.json ./apps/backend/tsconfig.json
# The MCP eval seed and the bundled client, for the cutover rehearsal task.
COPY apps/backend/evals/mcp ./apps/backend/evals/mcp
COPY --from=evals /out/run.bundle.js ./apps/backend/evals/mcp/run.bundle.js
EXPOSE 3000
CMD ["bun", "run", "apps/backend/src/server.ts"]
