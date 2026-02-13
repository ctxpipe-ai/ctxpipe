# ctxpipe – Project index

## Overview

Monorepo for **ctxpipe**, managed with pnpm workspaces and Turbo. Apps live in `apps/`, shared packages in `packages/`.

## Architecture

- **Backend** (`apps/backend`): Hono-based service exposing REST API and MCP (via `@hono/mcp`). Deployable to Cloudflare Workers and Bun-based containers. Uses Drizzle + PostgreSQL, Better Auth (scaffolded), Zod (collocated with routes/domain). See [apps/backend/adr/0001-backend-service-stack-and-runtime.md](apps/backend/adr/0001-backend-service-stack-and-runtime.md).

## User-defined namespaces

- (Leave blank – user populates)

## Components

- **backend** – `apps/backend`: REST + MCP server; entrypoints `src/server.ts` (Bun), `src/worker.ts` (Cloudflare Workers).

## Patterns

- Zod schemas are collocated with the code they validate (no central `src/schemas`).
- ADRs in `adr/` for major tooling and architecture decisions (see [adr/README.md](adr/README.md)).
