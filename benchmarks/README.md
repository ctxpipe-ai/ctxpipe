# Harbor Benchmark v1 (BoxyHQ)

This benchmark compares two controlled arms to test the hypothesis that
org-level context access improves outcomes when only the primary repo is
available locally.

## Arms

- **baseline**: only `boxyhq/saas-starter-kit` is on disk; no ctxpipe MCP
- **ctxpipe**: same local workspace; ctxpipe MCP enabled against pre-ingested org

## Fixture lock

Pinned snapshot is stored in
`benchmarks/fixtures/boxyhq-saas-v1.lock.json`:

- `boxyhq/saas-starter-kit` (`primary`)
- `ory/polis` (`sibling`)
- `boxyhq/ui` (`sibling`)

## Manual precondition for scored ctxpipe arm

Before scored runs, operators must pre-ingest the benchmark org in the hosted
ctxpipe environment at the lockfile SHAs.

## Required secrets for ctxpipe arm

- `CTXPIPE_MCP_URL` (full streamable-http MCP endpoint URL)
- `CTXPIPE_API_TOKEN` (auth token for that endpoint)

## Runbook

From repo root:

- Oracle smoke (deterministic sanity check):
  - `harbor run -a oracle -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge`
- Baseline scored arm:
  - `harbor run -a cursor-cli -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge`
- ctxpipe scored arm:
  - `benchmarks/scripts/preflight-mcp.sh`
  - `harbor run -a cursor-cli -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge --mcp-config benchmarks/mcp/ctxpipe.mcp.json`

## Jobs and configs

- `benchmarks/jobs/oracle-smoke.yaml`
- `benchmarks/jobs/baseline-cursor.yaml`
- `benchmarks/jobs/ctxpipe-cursor.yaml`

These files are canonical run specs for local and CI execution.

## Preflight checklist

- Harbor CLI installed and authenticated where needed
- Docker daemon running
- Lockfile SHAs reviewed (refresh with `benchmarks/scripts/pin-fixture.sh`)
- Hosted benchmark org pre-ingested for ctxpipe arm
- Required secrets configured in local shell / CI
