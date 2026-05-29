# Harbor Benchmarks

This directory contains Harbor benchmark tasks for measuring ctxpipe's
org-context advantage.

## v1 benchmark: BoxyHQ env bridge

| Arm | Harbor task | Workspace | Network | MCP |
|-----|-------------|-----------|---------|-----|
| **Baseline** (`baseline-cursor.yaml`) | `benchmarks/tasks/ctxpipe/boxyhq-env-bridge` | Primary repo cloned at lockfile SHA | allowed | none |
| **Ctxpipe** (`ctxpipe-cursor.yaml`) | `benchmarks/tasks/ctxpipe/boxyhq-env-bridge-ctxpipe` | No repo checkout (README only) | enabled (MCP) | ctxpipe (required) |

- Lockfile: `benchmarks/fixtures/boxyhq-saas-v1.lock.json`
- Smoke harness: `harbor run -c benchmarks/jobs/oracle-smoke.yaml` (baseline task + oracle agent)
- Scored harness:
  - `harbor run -c benchmarks/jobs/baseline-cursor.yaml`
  - `harbor run -c benchmarks/jobs/ctxpipe-cursor.yaml`

The ctxpipe arm cannot pass by reading `/app/lib/env.ts` (that file is not in the
image). It is expected to use hosted ctxpipe MCP for org code context. Internet
is allowed so the agent can reach `CTXPIPE_MCP_URL`; Harbor runs `cursor-agent`
inside the trial container, and `allow_internet = false` would set
`network_mode: none` and break MCP. An org with no ingested repos should score
below 1.0 on the answer criteria.

Keep `tests/oracle.json` in both task directories aligned with the lockfile oracle
(when oracle fields change, update both tasks).

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
