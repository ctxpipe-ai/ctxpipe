# Remote agent environments

Use this file when an agent runs on a remote or headless machine. On your own machine, follow the host dev runbook in the root [`AGENTS.md`](../../AGENTS.md#local-development).

Cursor is not in use now. Its files under `.cursor/` (`Dockerfile`, `environment.json`, `start.sh`, `hooks.json`, `mcp.json`, `worktrees.json`) stay dormant, so you can start Cursor again with no new setup.

## Headless VM (any harness)

Use this section when you need the running app (API, proxied UI, and auth in the browser) on a machine without a desktop. Do not use `pnpm dev` there. Portless needs HTTPS on port 443 and a local CA, and a headless machine has neither. A job that only runs lint or tests needs no servers: run `pnpm lint`, `pnpm --filter @ctxpipe/backend test`, or `pnpm --filter @ctxpipe/ui test`.

Preconditions:

- Docker with Compose. `localhost` is the VM, not your laptop.
- Node.js, pnpm, and Bun (versions as in the root `package.json` `engines`).
- `pnpm install` has run from the repo root.
- `psql` on `PATH` when the checkout is a linked git worktree. `pnpm db:migrate` needs it.

Create `apps/backend/.env.local` with these values:

```bash
DATABASE_URL=postgresql://ctxpipe_app:ctxpipe@localhost:5433/ctxpipe
GRAPH_DB_URI=redis://localhost:6379
AUTH_SECRET=<a random string of 32 or more characters>
AUTH_BASE_URL=http://localhost:3000
UI_PROXY_URL=http://localhost:3002
AUTH_ALLOWED_ORIGINS=http://localhost:3002,http://localhost:3000
```

- `DATABASE_URL` uses the `ctxpipe_app` runtime role, not the owner role. `pnpm db:migrate` connects as the owner `ctxpipe` by itself. The value above is the default of the Compose `infra` profile. In a linked worktree, use the per-worktree database name (see the root [`AGENTS.md`](../../AGENTS.md#local-development)). To use a hosted Postgres, set its URL here.
- `AUTH_BASE_URL`, `UI_PROXY_URL`, and `AUTH_ALLOWED_ORIGINS` must match ports 3000 and 3002. The auth client uses `window.location.origin`, so a mismatch gives "Request failed" errors.
- Other [apps/backend/.env.example](../../apps/backend/.env.example) values are optional. A run with chat or ingestion needs `MODEL_PROVIDER_API_KEY`.

Then run this sequence from the repo root:

```bash
pnpm dev:infra                    # or: sudo docker compose --profile infra up -d
pnpm db:migrate
cd apps/backend && bun --env-file=.env.local run --hot src/server.ts
# second terminal, repo root
cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 npx vite dev --host 0.0.0.0 --port 3002
```

Open `http://localhost:3000` for the integrated app. Do not use port 3002 alone.

Notes:

- If `pnpm dev:infra` fails with "permission denied" on `/var/run/docker.sock`, use the `sudo docker compose` form above.
- Use `--env-file=.env.local` so that the secrets and `DATABASE_URL` load reliably.
- This sequence does not start Zoekt or codesearch. UI, auth, and API work without it. Repository search and the MCP features that need codesearch need `pnpm start` or the full host dev runbook.
- If the shell exports `OTEL_EXPORTER_OTLP_*` to a collector that is not reachable, evlog logs connection errors. To stop them, start Bun with `env -u OTEL_EXPORTER_OTLP_LOGS_ENDPOINT -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT -u OTEL_EXPORTER_OTLP_METRICS_ENDPOINT -u OTEL_RESOURCE_ATTRIBUTES`.

## Cursor Cloud (dormant)

Cursor is not in use now. Use this section only when Cursor Cloud runs again. Follow the shared runbook above for the dev servers.

- [`.cursor/environment.json`](../../.cursor/environment.json) sets the environment. It builds from [`.cursor/Dockerfile`](../../.cursor/Dockerfile) (Docker CE, Node.js, pnpm, Bun) and runs `corepack enable && pnpm install` after boot.
- [`.cursor/start.sh`](../../.cursor/start.sh) starts Docker and waits for `docker info`. It also writes `apps/backend/.env.local` from the Cursor secrets `AUTH_SECRET`, `DATABASE_URL`, and `GRAPH_DB_URI` when the file is missing. It uses the values in the shared runbook.
- Set the secrets in the Cursor dashboard under Cloud Agents. `AUTH_SECRET` (32 or more characters) is required. `DATABASE_URL` and `GRAPH_DB_URI` are optional.
- A personal dashboard environment can override the committed `environment.json`. If agents boot without Docker or Bun, remove the override or save a personal install that includes them.
- Cursor applies `environment.json` only when it builds the image. If `docker` is missing on the VM, rebuild at [cursor.com/onboard](https://cursor.com/onboard).
- CI, CLI tests, Changeset Guard, and PR Deploy listen to both `push` and `pull_request`, because Cursor Cloud commits sometimes skip `synchronize`. A job runs on exactly one of these events: `cursor[bot]` and `cursoragent` on `push`, everyone else on `pull_request`. PR Deploy keeps one concurrency group for each PR branch. Manual fallback: Actions, PR Deploy, Run workflow. Select the PR branch (never `main`), then enter the PR number.

## Claude Code on the web

[`.claude/hooks/session-start.sh`](../../.claude/hooks/session-start.sh) runs on every cloud session (no-op locally): starts `dockerd` with the `mirror.gcr.io` Docker Hub mirror, brings up Compose **`infra`**, runs `pnpm install`, stamps the `@ctxpipe/aws-cdk` image tag, installs Zoekt with `go install`, writes `apps/backend/.env.local`, migrates, exports `DATABASE_URL` / `AUTH_SECRET` / `GRAPH_DB_URI` to the shell, and starts Storybook for the `ctxpipe-storybook` MCP.

- **Tests:** run them as in CI; no extra env needed (`pnpm --filter @ctxpipe/backend test`, `@ctxpipe/ui`, `ctxpipe`, `@ctxpipe/aws-cdk`). For codesearch use `pnpm --filter @ctxpipe/codesearch test:vitest`; `test` builds the Docker image, which cannot build here.
- **App:** `bash scripts/dev-headless.sh` runs codesearch (host, [`scripts/codesearch-host-dev.sh`](../../scripts/codesearch-host-dev.sh)), backend, worker, and UI; browse `http://localhost:3000`. The backend will not boot without `MODEL_PROVIDER_API_KEY`.
- **Sandbox quirks:** no IPv6, so the hook writes a gitignored `docker-compose.override.yml` that turns off FalkorDB's Bolt listener, which the backend never uses. Container egress is TLS-intercepted, so Docker image builds that download over HTTPS fail. Hosts the environment's network policy blocks fail with `403` on CONNECT; `curl -sS "$HTTPS_PROXY/__agentproxy/status"` lists them.
- **MCP:** [`.mcp.json`](../../.mcp.json) reads API keys from environment variables, so it works with no browser. [`mcp-servers.md`](mcp-servers.md) lists the variables. A claude.ai HyperDX connector, if connected, exposes the same tools as `mcp__HyperDX__*`; the repo server works for every account.
