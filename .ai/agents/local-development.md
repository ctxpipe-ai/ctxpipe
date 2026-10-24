# Local development details

The root [`AGENTS.md`](../../AGENTS.md#local-development) holds the host dev runbook. This file holds the details that you need less often: Compose, migrations, the docs site, and container deploy. For a headless or remote VM, see [`remote-environments.md`](remote-environments.md).

## Docker Compose

One [docker-compose.yml](../../docker-compose.yml) uses profiles ([ADR-015](../memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md)).

- `pnpm dev:infra` starts the `infra` profile: Postgres, FalkorDB, OTEL, and Agent Vault for Docker chat sandboxes.
- The Agent Vault API is on `127.0.0.1:14321`. Local containers can reach it on Docker Desktop, so use a trusted machine.
- Set a generated `AGENT_VAULT_OWNER_PASSWORD` in `apps/backend/.env.local`. If a fresh Agent Vault refuses it, remove the `agent_vault_dev` volume.
- `pnpm start` starts the `deploy` profile (production images: migrate, backend, worker, UI, codesearch).
- Override host ports with `CTXPIPE_*` ([docker-compose.env.example](../../docker-compose.env.example)). Postgres can stay on 5433 if only one Compose stack runs.

## Migrations only

Run `pnpm db:migrate` from the repo root. [`scripts/db-migrate.sh`](../../scripts/db-migrate.sh) sources [`scripts/worktree-db.sh`](../../scripts/worktree-db.sh), rewrites local `ctxpipe_app` URLs to the owner `ctxpipe` for DDL, runs Drizzle and OpenWorkflow migrations, then GRANTs `ctxpipe_app`.

- In a linked worktree, `worktree-db.sh` creates the database if needed. It exports the owner URL in that shell, makes no `.env` edit, and needs `psql` on `PATH`.
- In a normal checkout, the script loads `.env.local` and rewrites the user for migrate only.
- Keep `ctxpipe_app` in the runtime `.env.local`.
- To set `DATABASE_URL` in your current shell, run `eval "$(./scripts/worktree-db.sh)"`.

## Documentation site

Run `pnpm dev:docs` to start Next.js on `http://localhost:3003` ([apps/docs](../../apps/docs/AGENTS.md)). The doc URLs are under `/docs`. Root `pnpm dev` does not start it. `pnpm dev --filter @ctxpipe/docs` also works.

## Container deploy (Compose `deploy` profile)

Set `AUTH_SECRET` (32 or more characters), `AUTH_BASE_URL`, `CTXPIPE_PUBLIC_APP_URL` (the public origin of the app), and optionally `AUTH_ALLOWED_ORIGINS` in a root `.env` ([docker-compose.env.example](../../docker-compose.env.example)). Then run `pnpm start`. It builds the images on the first run. The operator supplies TLS and a reverse proxy. A Better Auth schema upgrade can need `pnpm --filter @ctxpipe/backend auth:migrate` against the same database.
