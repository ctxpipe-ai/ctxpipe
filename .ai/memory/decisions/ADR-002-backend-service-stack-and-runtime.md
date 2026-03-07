# ADR-002: Backend service stack and runtime

**Status:** Accepted | **Date:** 2026-02-12 | **Tags:** backend, hono, bun, drizzle, auth

## Context

The `ctxpipe` monorepo is currently an empty pnpm + Turbo + TypeScript workspace, with `apps/` and `packages/` reserved for future applications and shared libraries. We want to introduce a new backend service named `backend` that:

- Exposes multiple REST endpoints and an MCP interface.
- Uses PostgreSQL (hosted in Neon for the managed deployment, but portable to any Postgres provider on-prem) via Drizzle ORM.
- Uses Better Auth for authentication.
- Uses Zod for runtime validation and strong type safety.
- Will later integrate with S3/R2-compatible object storage for files, Neo4j for graph workloads, and LangGraph JS for orchestration.

We also want this service to align with the existing monorepo tooling (pnpm, Turbo, Biome) and be easy to extend by future agents.

## Decision

We will:

1. **Create a new app** at `apps/backend` as a pnpm workspace package, managed by Turbo.
2. **Use Hono as the HTTP framework** for both REST endpoints and the MCP interface: the on-prem/container deployment will run Hono on a Bun-based runtime.
3. **Use Bun as the container runtime**: The production container image will be based on a Bun image. The Hono app will expose an HTTP server compatible with Bun's Node-style runtime, so we do not depend on Bun-specific APIs in application code.
4. **Use Drizzle ORM with PostgreSQL**: PostgreSQL will be the primary database, with the `DATABASE_URL` connection string configurable per environment. The managed deployment will use Neon; on-prem deployments can point to any Postgres-compatible provider.
5. **Use Better Auth for authentication**: Better Auth will be integrated into the Hono app as middleware, with configuration and user modeling left pluggable.
6. **Use Zod for validation and typesafety**: Zod schemas will be **collocated** with the modules they describe (routes, domain services, DB models), rather than stored in a central `src/schemas` directory. Types will be derived from schemas using `z.infer` and reused across routes, MCP tools, and domain code.
7. **Integrate MCP via `hono/mcp`**: MCP tools will be exposed as part of the main Hono app (e.g. under `/mcp`) using the `hono/mcp` integration. MCP tools will call into shared domain services so that REST and MCP interfaces reuse the same core logic.
8. **Keep the app structured for future extensions**: Prepare folders for DB (`db/`), auth (`auth/`), MCP (`mcp/`), configuration (`config/`), and domain/services (`domain/` or `services/`). Reserve `platform/` for future adapters to S3/R2, Neo4j, and LangGraph JS.

## Consequences

**Positive**

- A single Hono-based app serves both REST and MCP interfaces, reducing divergence and duplication.
- Drizzle + PostgreSQL provide strong type safety at the data layer and are provider-agnostic via `DATABASE_URL`.
- Zod collocation keeps validation close to business logic and improves maintainability and discoverability.
- Better Auth provides a modern, flexible authentication building block without locking the project into a single identity provider.
- MCP integration via `hono/mcp` makes it easy to add tools that reuse the same domain model as the REST API.

**Negative / trade-offs**

- Introducing multiple technologies at once (Hono, Bun, Drizzle, Better Auth, MCP, future S3/R2/Neo4j/LangGraph) increases initial complexity and learning curve.
- Bun as the production runtime means the container must target Bun-compatible environments; teams standardised on pure Node images may need adjustments.
- Collocating Zod schemas avoids a central schema registry but can make it harder to see all validation rules in one place without tooling.

## Alternatives Considered

- **Express / Fastify instead of Hono**: Rejected because they are primarily Node-centric.
- **Node.js instead of Bun for container runtime**: Rejected to keep the production container aligned with Bun's performance and emerging ecosystem, and to differentiate from standard Node stacks.
- **Separate MCP server process**: Rejected in favor of `hono/mcp` integration to keep deployment and routing simpler and to ensure MCP and REST share the same app composition and middleware.
- **Central `src/schemas` for Zod**: Rejected to encourage validation that is closer to the code it protects and to reduce indirection for contributors.

## Notes

- **Local development**: Docker Compose for local dev is described in [ADR-004](ADR-004-local-development-docker-compose.md).
- Future ADRs should refine: the exact auth flows and storage for Better Auth (sessions vs tokens, cookie configuration, etc.); the concrete integration patterns for S3/R2, Neo4j, and LangGraph JS.
- Cloudflare Workers support was removed; see [ADR-007](ADR-007-remove-cloudflare-workers-runtime.md).
