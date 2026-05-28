# Harbor Benchmarks

This directory contains Harbor benchmark tasks for measuring ctxpipe's
org-context advantage.

## v1 benchmark: BoxyHQ env bridge

- Task: `benchmarks/tasks/ctxpipe/boxyhq-env-bridge`
- Lockfile: `benchmarks/fixtures/boxyhq-saas-v1.lock.json`
- Smoke harness: `harbor run -a oracle`
- Scored harness: `harbor run -a cursor-cli` in two job configs:
  - `benchmarks/jobs/baseline-cursor.yaml`
  - `benchmarks/jobs/ctxpipe-cursor.yaml`

## Pre-flight checklist (hosted ctxpipe arm)

Before scored runs, prepare the hosted benchmark org manually:

1. Create a dedicated org slug (example: `boxyhq-bench`).
2. Ingest and index:
   - `boxyhq/saas-starter-kit` (primary)
   - `ory/polis`
   - `boxyhq/ui`
3. Pin repo refs to the lockfile SHAs.
4. Provision secrets:
   - `CURSOR_API_KEY`
   - `CTXPIPE_MCP_URL` (include `orgSlug` query)
   - `CTXPIPE_API_TOKEN`

## Local usage

Run from repo root:

```bash
# Optional: repin refs and sanity-check oracle assumptions.
benchmarks/scripts/pin-fixture.sh

# Smoke run (deterministic, no model credentials required).
harbor run -c benchmarks/jobs/oracle-smoke.yaml

# Scored runs.
benchmarks/scripts/preflight-mcp.sh
harbor run -c benchmarks/jobs/baseline-cursor.yaml
harbor run -c benchmarks/jobs/ctxpipe-cursor.yaml
```

## GitHub Actions

Workflow: `.github/workflows/benchmark-harbor.yaml`

- Pull requests run the oracle smoke job.
- Manual dispatch can also run scored jobs by setting
  `run_scored=true` and supplying required secrets.
