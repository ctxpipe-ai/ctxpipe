# @ctxpipe/evals

Evaluations for ctxpipe using [Promptfoo](https://www.promptfoo.dev/). This README covers **what runs here**, **required setup**, and **environment**; it does not duplicate Promptfoo’s own CLI or assertion reference.

## Retrieval eval (default)

**What it compares**

| Arm | Behavior |
|-----|----------|
| **Baseline** | Direct LLM call with no org/repo context in the prompt. |
| **MCP `ctx_advisor`** | Same user question via streamable HTTP MCP, using the same tool surface as Cursor (`ctx_advisor`). |

Configs: `promptfooconfig.yaml` (default assertions) and `promptfooconfig.full.yaml` (adds global LLM rubric — extra cost). Models are pinned in YAML.

**Org requirement**

Runs are only meaningful when the **target org already has retrieval data**: connect and **ingest** repos (and let indexing complete) before expecting strong MCP scores. The baseline arm does not use indexed text; the MCP arm does.

**Provider env (OpenRouter)**

Point the OpenAI-compatible client at OpenRouter (or another compatible API) with:

- `OPENAI_BASE_URL` — e.g. OpenRouter’s base URL
- `OPENAI_API_KEY` — API key for that provider

**MCP env**

- `CTXPIPE_MCP_URL` — full URL including `orgSlug`, e.g. `https://localhost:3000/mcp?orgSlug=your-org`
- `CTXPIPE_API_TOKEN` — Bearer token for the same user/org as in the app

## Ingestion eval (`eval:ingestion`)

Scores **post-ingest** quality (baseline vs MCP `ctx_advisor`) after the openworkflow **`repository-ingestion`** job completes (`indexReady` and `lastIngestedHash` on `GET /:orgSlug/api/v1/repositories/:id`). Ingestion is triggered the same way as in the product: **`POST /:orgSlug/api/v1/repositories`** (`apps/backend/src/routes/v1/repositories.ts` → `ow.runWorkflow(repositoryIngestion.spec, …)`).

**Flow**

1. Set **`defaultTest.vars.current_project_name`** in `promptfooconfig.ingestion.yaml` to the repository **`name`** from the API (so `ctx_advisor` can pass `currentProjectName`).
2. Run `pnpm --filter @ctxpipe/evals eval:ingestion`. The first step runs **`scripts/wait-repository-ingest.mjs`** (poll API until ready), then Promptfoo with `promptfooconfig.ingestion.yaml` (LLM rubric + javascript + same providers as retrieval).

**Extra env (wait script)**

| Variable | Required | Description |
|----------|----------|-------------|
| `CTXPIPE_API_BASE_URL` | Yes (unless skipping wait) | App origin only, e.g. `https://app.ctxpipe.localhost` |
| `CTXPIPE_ORG_SLUG` | Yes | Org slug in API paths |
| `CTXPIPE_API_TOKEN` | Yes | Same Bearer token as MCP eval |
| `CTXPIPE_EVAL_REPOSITORY_ID` | One of id / name / trigger | Repository id to poll |
| `CTXPIPE_EVAL_REPO_NAME` | Optional | If set without id, wait script **lists** `/repositories` and selects by `name` |
| `CTXPIPE_EVAL_TRIGGER_INGEST` | Optional | Set to `1` to **POST** a new repo first (`CTXPIPE_EVAL_REPO_NAME`, `CTXPIPE_EVAL_GIT_URL`) |
| `CTXPIPE_EVAL_SKIP_WAIT` | Optional | Set to `1` to skip polling and run Promptfoo only (index already ready) |
| `CTXPIPE_EVAL_POLL_MS` | Optional | Poll interval (default `4000`) |
| `CTXPIPE_EVAL_INGEST_TIMEOUT_MS` | Optional | Max wait (default 20 minutes) |

**Limitations**

- The **OpenWorkflow worker** must process jobs; otherwise the wait step times out.
- **`CTXPIPE_EVAL_TRIGGER_INGEST`** needs a **cloneable** `gitUrl` for the backend worker (public HTTPS is simplest). Private repos depend on backend/git credentials — not wired from this package.
- **CI**: runners cannot hit your laptop; use staging or a tunnel (same idea as retrieval GitHub Actions notes below).

## Benchmark corpus: better-auth org

Use the **[better-auth](https://github.com/better-auth)** organization on GitHub as a fixed benchmark corpus: connect it in the product, run ingestion for the eval org, and wait for indexing before scoring MCP answers against repo-grounded questions.

| Corpus | Link | Indexing |
|--------|------|----------|
| better-auth | [https://github.com/better-auth](https://github.com/better-auth) | Ingest org repos in-app; confirm retrieval is warm before evals. |

Shared test fragments and dataset layout live under [`datasets/README.md`](datasets/README.md) — keep benchmark-specific file lists there to avoid duplicating them here.

## Prerequisites

- **Node** (for `pnpm` / Promptfoo CLI).
- **Pre-ingested org** for retrieval eval (see above).
- **Running ctxpipe backend** with auth for the MCP arm.

### TLS to localhost

If your dev server uses HTTPS with a custom cert, set `NODE_EXTRA_CA_CERTS` to your CA bundle, or use an HTTP endpoint that matches your dev setup.

## Commands

From repo root:

```bash
pnpm eval
pnpm --filter @ctxpipe/evals eval:ingestion
```

Or from this package:

```bash
pnpm --filter @ctxpipe/evals eval
pnpm --filter @ctxpipe/evals eval:full   # adds LLM rubric (extra cost)
pnpm --filter @ctxpipe/evals eval:ingestion   # wait for ingestion, then post-ingest benchmark
pnpm --filter @ctxpipe/evals eval:view    # Promptfoo UI over cached results
```

Optional JSON output:

```bash
cd packages/evals && PROMPTFOO_DISABLE_TELEMETRY=1 pnpm exec promptfoo eval -c promptfooconfig.yaml -o results.json
```

Exit code is non-zero when assertions fail.

## Environment variables

| Variable | Required for | Description |
|----------|----------------|-------------|
| `OPENAI_API_KEY` | Baseline, `eval:full` | OpenAI-compatible API key (e.g. OpenRouter). |
| `OPENAI_BASE_URL` | Optional | Defaults per client; set for OpenRouter or non-OpenAI hosts. |
| `CTXPIPE_MCP_URL` | MCP arm | e.g. `https://localhost:3000/mcp?orgSlug=acme` |
| `CTXPIPE_API_TOKEN` | MCP arm | Bearer token |
| `PROMPTFOO_DISABLE_TELEMETRY` | Optional | Set to `1` to silence telemetry |

## Config files

| File | Purpose |
|------|---------|
| `promptfooconfig.yaml` | Default — cheaper assertions only |
| `promptfooconfig.full.yaml` | Adds global `llm-rubric` (expensive) |
| `promptfooconfig.ingestion.yaml` | Post-ingest benchmark (rubric + non-empty output check) |

## Test case variables

Each test in `promptfooconfig.yaml` can set:

- `question` — user message (required for meaningful runs).
- `case_id` — stable id for your own tracking.
- `conversation_id` — passed to `ctx_advisor` as `conversationId` (stable per case recommended).
- `current_project_name` — optional; mapped to `currentProjectName`.

## GitHub Actions

Manual workflow: [`.github/workflows/evals.yml`](../../.github/workflows/evals.yml) (`workflow_dispatch`). Configure repository secrets: `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `CTXPIPE_MCP_URL`, `CTXPIPE_API_TOKEN`. GitHub-hosted runners cannot reach `localhost` on your machine; use a staging URL or a tunnel.

## Troubleshooting

### `Database migration failed` / `better_sqlite3.node`

Promptfoo uses SQLite. If native bindings are missing after `pnpm install`, run:

```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install
```

(Or reinstall with `better-sqlite3` allowed to run install scripts — see root `package.json` `pnpm.onlyBuiltDependencies`.)

### MCP provider errors

- Confirm `CTXPIPE_MCP_URL` includes `?orgSlug=...`.
- Confirm the token is valid and the org matches the indexed repos.
