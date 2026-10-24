# Remote agent environments

Use this file when an agent runs on a remote or headless machine. On your own machine, follow the host dev runbook in the root [`AGENTS.md`](../../AGENTS.md#local-development).

Cursor is not in use now. Its files under `.cursor/` (`Dockerfile`, `environment.json`, `start.sh`, `hooks.json`, `mcp.json`, `worktrees.json`) stay dormant, so you can start Cursor again with no new setup. The Cursor section below applies only when Cursor runs again.

## Cursor Cloud (dormant)

Cloud agents run on an isolated Ubuntu machine. This repo provides a default cloud-agent environment config at [`.cursor/environment.json`](../../.cursor/environment.json).

- **Default for remote agents:** When you need the **running app** (API + proxied UI + auth in the browser), use **Running dev servers on cloud VMs** below — not `pnpm dev` (portless). Lint/tests-only work can skip servers; see **Suggested verification commands** below.
- **Docker image**: the environment is built from [`.cursor/Dockerfile`](../../.cursor/Dockerfile) following Cursor’s **Running Docker** guidance ([Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup)): Docker CE + `fuse-overlayfs` + `iptables-legacy`, plus **Node.js**, **pnpm**, and **Bun** (matches root `package.json` `engines` and backend dev scripts). **`start`** runs [`.cursor/start.sh`](../../.cursor/start.sh): `sudo service docker start` and wait until `docker info` succeeds so `docker compose` is ready before tasks.
- **Personal dashboard overrides**: A personal Cloud Agent environment (dashboard) can override the committed `.cursor/environment.json`. If agents boot without Docker/Bun after enabling Builds, the active environment is likely a snapshot-only personal config that never built this Dockerfile—either Save an updated personal install/start that includes Docker tooling, or remove the personal override so the repo Dockerfile is used.
- **Rebuild after changing the Dockerfile**: Cursor only applies `.cursor/environment.json` when the cloud image is (re)built. If `docker` is missing on the agent VM, the environment is not using this Dockerfile—rebuild at [cursor.com/onboard](https://cursor.com/onboard) or bump the image so the **build** step runs again.
- **Install/update**: after the image boots, Cursor runs `corepack enable && pnpm install` from the repo root (`install` in `environment.json`).
- **Docker + Postgres**:
  - **Important**: `localhost` in cloud agents is the **cloud VM**, not your laptop.
  - If Docker is available on the VM, the agent can start the same infra stack you use locally with **`pnpm dev:infra`** (Postgres on `localhost:5433`, FalkorDB on `localhost:6379` by default; see [docker-compose.yml](../../docker-compose.yml) and [docker-compose.env.example](../../docker-compose.env.example)).
  - If **`pnpm dev:infra`** fails with **permission denied** on `/var/run/docker.sock` even after [`.cursor/start.sh`](../../.cursor/start.sh), run **`sudo docker compose --profile infra up -d`** from the repo root (same Compose file as `pnpm dev:infra`).
  - If Docker is **not** available or you prefer managed services, use a hosted Postgres and set `DATABASE_URL` via Secrets.
- **Secrets (Cursor dashboard → Cloud Agents → Secrets)**:
  - **Required**: `AUTH_SECRET` (≥ 32 chars) for backend auth initialization/tests (see [apps/backend/.env.example](../../apps/backend/.env.example)).
  - **Database**: set `DATABASE_URL` to the **ctxpipe_app** runtime role (not the owner/migrate role). Compose on the VM defaults to `ctxpipe_app` via [`.cursor/start.sh`](../../.cursor/start.sh); `pnpm db:migrate` still connects as owner `ctxpipe`.
  - **Optional**: `GRAPH_DB_URI` (when running graph features; use `redis://localhost:6379` if FalkorDB is started by `pnpm dev:infra`), and any model/API keys you need for specific tasks.
- **Suggested verification commands** (no full dev stack):
  - `pnpm lint`
  - `pnpm --filter @ctxpipe/backend test`
  - `pnpm --filter @ctxpipe/ui test`
- **GitHub Actions after a cloud-agent push:** CI, CLI tests, Changeset Guard, and PR Deploy listen to both `push` and `pull_request` because Cloud Agent commits sometimes skip `synchronize`. Jobs run **exactly one** of those events: `cursor[bot]` / `cursoragent` on `push` only; everyone else on `pull_request` only. Concurrency is keyed by event name so a skipped `pull_request` run does not cancel the agent `push` suite. PR Deploy is the exception: one concurrency group per PR branch holds a whole run, and a run that it skips gets its own group. The PR-close cleanup has its own group for each PR, so a later push cannot cancel it. Manual fallback: Actions → PR Deploy → Run workflow, with the **PR branch** as the branch, then the PR number. PR Deploy refuses a run from `main`, because every branch can read the Actions cache of `main`.
- **Running dev servers on cloud VMs** (without portless) — **default for Cursor Cloud and headless VMs**:
  - **Why:** Portless requires HTTPS on port 443 and a local CA; that does not work on headless cloud VMs. **`pnpm dev`** invokes portless via [`scripts/dev-apps.sh`](../../scripts/dev-apps.sh) — skip it here.
  - **Steps** (run migrations once after infra is up):
    1. **`pnpm dev:infra`** — Postgres, FalkorDB, OTEL. If the socket error above applies, use **`sudo docker compose --profile infra up -d`** from the repo root instead.
    2. **`pnpm db:migrate`** — from repo root; applies schema to the database in `apps/backend/.env.local`.
    3. **Backend:** `cd apps/backend && bun --env-file=.env.local run --hot src/server.ts` — **`http://localhost:3000`**. Use **`--env-file=.env.local`** so secrets and `DATABASE_URL` load reliably.
    4. **UI** (second process): `cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 npx vite dev --host 0.0.0.0 --port 3002` — Vite on port **3002**.
  - **Browser entry point:** **`http://localhost:3000`** (backend). The backend proxies SPA routes to **`UI_PROXY_URL`** (`http://localhost:3002` — [`.cursor/start.sh`](../../.cursor/start.sh) sets this when it generates `.env.local`). The auth client uses `window.location.origin`; use **port 3000** in the browser, not 3002 alone (avoids Better Auth / “Request failed” issues).
  - **Optional — noisy OTLP:** If the shell exports `OTEL_EXPORTER_OTLP_*` to an unreachable collector, evlog may log connection errors when handling requests. For a quiet run, unset those variables when starting Bun (example: `env -u OTEL_EXPORTER_OTLP_LOGS_ENDPOINT -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT -u OTEL_EXPORTER_OTLP_METRICS_ENDPOINT -u OTEL_RESOURCE_ATTRIBUTES`).
  - **Codesearch:** This path does **not** start Zoekt/codesearch (that is wired by **`pnpm dev`** or Compose **`deploy`**). UI/auth/API work without it; repository search/MCP features that need codesearch require full host dev or **`pnpm start`**.
  - **`.env.local` and secrets:** [`.cursor/start.sh`](../../.cursor/start.sh) auto-generates `apps/backend/.env.local` from Cursor secrets (`AUTH_SECRET`, `DATABASE_URL`, `GRAPH_DB_URI`) when the file is missing, and sets **`AUTH_BASE_URL`**, **`UI_PROXY_URL`**, and **`AUTH_ALLOWED_ORIGINS`** for this HTTP layout. If you maintain `.env.local` by hand, keep those aligned with **localhost:3000** / **localhost:3002** for this runbook.
  - **Docker + Bun**: handled automatically by [`.cursor/start.sh`](../../.cursor/start.sh) (dockerd fallback + socket permissions) and [`environment.json`](../../.cursor/environment.json) (bun install fallback). See those files if debugging startup.

### Agent runbook — Cursor Cloud / headless VMs (copy-paste)

```bash
# repo root
pnpm dev:infra                    # or: sudo docker compose --profile infra up -d
pnpm db:migrate
cd apps/backend && bun --env-file=.env.local run --hot src/server.ts
# second terminal, repo root
cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 npx vite dev --host 0.0.0.0 --port 3002
```

Open **`http://localhost:3000`** for the integrated app.

## Claude Code on the web

[`.claude/hooks/session-start.sh`](../../.claude/hooks/session-start.sh) runs on every cloud session (no-op locally): starts `dockerd` with the `mirror.gcr.io` Docker Hub mirror, brings up Compose **`infra`**, runs `pnpm install`, stamps the `@ctxpipe/aws-cdk` image tag, installs Zoekt with `go install`, writes `apps/backend/.env.local`, migrates, exports `DATABASE_URL` / `AUTH_SECRET` / `GRAPH_DB_URI` to the shell, and starts Storybook for the `ctxpipe-storybook` MCP.

- **Tests:** run them as in CI; no extra env needed (`pnpm --filter @ctxpipe/backend test`, `@ctxpipe/ui`, `ctxpipe`, `@ctxpipe/aws-cdk`). For codesearch use `pnpm --filter @ctxpipe/codesearch test:vitest`; `test` builds the Docker image, which cannot build here.
- **App:** `bash scripts/dev-headless.sh` runs codesearch (host, [`scripts/codesearch-host-dev.sh`](../../scripts/codesearch-host-dev.sh)), backend, worker, and UI; browse `http://localhost:3000`. The backend will not boot without `MODEL_PROVIDER_API_KEY`.
- **Sandbox quirks:** no IPv6, so the hook writes a gitignored `docker-compose.override.yml` that turns off FalkorDB's Bolt listener, which the backend never uses. Container egress is TLS-intercepted, so Docker image builds that download over HTTPS fail. Hosts the environment's network policy blocks fail with `403` on CONNECT; `curl -sS "$HTTPS_PROXY/__agentproxy/status"` lists them.
- **MCP:** [`.mcp.json`](../../.mcp.json) reads API keys from environment variables, so it works with no browser. The MCP section of the root [`AGENTS.md`](../../AGENTS.md) lists the variables. A claude.ai HyperDX connector, if connected, exposes the same tools as `mcp__HyperDX__*`; the repo server works for every account.
