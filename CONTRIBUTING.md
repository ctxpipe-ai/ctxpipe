# Contributing to ctxpipe

We welcome issues and pull requests. For a large change, open an issue first so
that we can agree on the design and the product direction.

- Bugs and feature requests: [GitHub issues](https://github.com/ctxpipe-ai/ctxpipe/issues)
- Questions and discussion: [Discord](https://ctxpipe.ai/discord)
- Repository conventions: [AGENTS.md](AGENTS.md). An app or a package can also
  have its own `AGENTS.md`. Coding agents and people use the same rules.

## Local development

**Requirements:** Node.js 22+, pnpm 10, Bun 1.4.4+, Docker with Compose v2.

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env.local
# Set AUTH_SECRET, at least 32 characters, in apps/backend/.env.local
# Set MODEL_PROVIDER_API_KEY for Workspace chat and ingestion
# Set AGENT_VAULT_OWNER_PASSWORD (openssl rand -hex 24) for chat sandboxes

pnpm dev:infra
pnpm dev
```

Open [https://app.ctxpipe.localhost](https://app.ctxpipe.localhost).

If your browser warns about the local certificate, run:

```bash
pnpm trust
```

For the model provider settings, see
[Models](https://docs.ctxpipe.ai/docs/self-hosting/models). For the backend API,
OpenAPI, MCP, contract tests, and package scripts, see
[apps/backend/README.md](apps/backend/README.md).

## Repository layout

| Path | Purpose |
|---|---|
| `apps/backend` | Hono API, auth, MCP endpoint, connectors, workflows, and migrations. |
| `apps/ui` | Product web app. |
| `apps/docs` | Fumadocs documentation site. |
| `apps/codesearch` | Zoekt-backed clone and code search service. |
| `apps/otel-collector` | OpenTelemetry Collector for local development (Compose `infra` profile only). A self-hosted deployment can export with `OTEL_EXPORTER_OTLP_*`. |
| `apps/forge-ctxpipe-agent` | Reference Atlassian Forge app manifest for the Confluence connector. |
| `packages/aws-cdk` | AWS CDK construct for self-hosting ctxpipe on AWS. |
| `packages/cli` | The `ctxpipe` CLI: MCP setup (`npx ctxpipe init`) and local memory. |
| `plugins/ctxpipe` | Claude plugin for the hosted ctxpipe MCP. |
| `shared` | Git helpers that the backend and codesearch both use. |
| `ops/observability` | Internal ClickStack and Langfuse project. It is not part of a product deploy. |
| `examples/aws-cdk-self-host` | Runnable AWS CDK self-hosting example. |
| `infra` | Terraform for the managed Railway and Neon deployment path. |
| `.ai/memory` | Architecture decisions and project memory used by coding agents. |

## Common commands

| Command | Purpose |
|---|---|
| `pnpm dev:infra` | Start Docker-backed dependencies for local development. |
| `pnpm dev` | Run backend and UI on the host, with codesearch in Docker. |
| `pnpm dev:docs` | Run the docs site on `http://localhost:3003`. |
| `pnpm start` | Run the full containerized stack with the Compose `deploy` profile. |
| `pnpm db:migrate` | Run backend database migrations. |
| `pnpm build` | Build the monorepo with Turborepo. |
| `pnpm lint` | Run Oxlint. |
| `pnpm format:check` / `pnpm format` | Check or fix formatting with Oxfmt. |
| `pnpm mcp:inspect` | Open the MCP inspector for the backend. |
| `pnpm mcpjam:inspect --url <mcp-url> --oauth` | Open the pinned MCPJam Inspector against an MCP endpoint. |
| `pnpm mcpjam:doctor --url <mcp-url>` | Probe an MCP endpoint and capture transport/OAuth diagnostics. |
| `pnpm changeset` | Create a Changesets entry for publishable package changes. |
| `pnpm release` | Build and publish release-ready packages. |

## Before you open a pull request

- Run `pnpm lint`, `pnpm typecheck`, and `pnpm knip`. CI fails on unused files,
  exports, and dependencies.
- Run the tests of each package that you changed, for example
  `pnpm --filter @ctxpipe/backend test`.
- For a change that ships in `@ctxpipe/aws-cdk`, add a changeset with
  `pnpm changeset`.
