# @ctxpipe/evals

Promptfoo-based evaluation: **baseline** (direct LLM, no org context in the prompt) vs **MCP `ctx_advisor`** (streamable HTTP, same tool as Cursor).

## Prerequisites

- **Node** (for `pnpm` / Promptfoo CLI).
- **`OPENAI_API_KEY`** — used by the baseline provider and (for `eval:full`) the LLM rubric grader.
- **Running ctxpipe backend** with auth for the MCP arm:
  - **`CTXPIPE_MCP_URL`** — full URL including `orgSlug`, e.g. `https://localhost:3000/mcp?orgSlug=your-org`.
  - **`CTXPIPE_API_TOKEN`** — Bearer token for the same user/org as in the app.
- **Org data**: For non-trivial questions, connect and index **public** repos (see table below). The baseline arm does **not** use repo text; `ctx_advisor` uses org retrieval.

### TLS to localhost

If your dev server uses HTTPS with a custom cert, set:

- `NODE_EXTRA_CA_CERTS` to your CA bundle, or

- Use an HTTP endpoint that matches your dev setup.

## Commands

From repo root:

```bash
pnpm eval
```

Or from this package:

```bash
pnpm --filter @ctxpipe/evals eval
pnpm --filter @ctxpipe/evals eval:full   # adds LLM rubric (extra cost)
pnpm --filter @ctxpipe/evals eval:view    # Promptfoo UI over cached results
```

Optional JSON output:

```bash
cd packages/evals && PROMPTFOO_DISABLE_TELEMETRY=1 pnpm exec promptfoo eval -c promptfooconfig.yaml -o results.json
```

Exit code is non-zero when assertions fail.

## Config files

| File | Purpose |
|------|---------|
| `promptfooconfig.yaml` | Default — cheap assertions only |
| `promptfooconfig.full.yaml` | Adds global `llm-rubric` (expensive) |

Models are **pinned** in YAML; update when you intentionally change benchmark conditions.

## Environment variables

| Variable | Required for | Description |
|----------|----------------|-------------|
| `OPENAI_API_KEY` | Baseline, `eval:full` | OpenAI-compatible API key |
| `OPENAI_BASE_URL` | Optional | Default `https://api.openai.com/v1` |
| `CTXPIPE_MCP_URL` | MCP provider | e.g. `https://localhost:3000/mcp?orgSlug=acme` |
| `CTXPIPE_API_TOKEN` | MCP provider | Bearer token |
| `PROMPTFOO_DISABLE_TELEMETRY` | Optional | Set to `1` to silence telemetry |

## Test case variables

Each test in `promptfooconfig.yaml` can set:

- `question` — user message (required for meaningful runs).
- `case_id` — stable id for your own tracking.
- `conversation_id` — passed to `ctx_advisor` as `conversationId` (stable per case recommended).
- `current_project_name` — optional; mapped to `currentProjectName`.

## Public repos (benchmark corpus)

Add rows as you adopt real benchmarks. **Index these in the org** before expecting strong `ctx_advisor` scores.

| Slug / repo | Branch / tag | Notes |
|-------------|----------------|-------|
| *TBD* | *TBD* | Connect via product GitHub flow, ingest |

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
