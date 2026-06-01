# ctxpipe/grafana-codeowners-discovery

Harbor benchmark task for the **baseline arm**: sparse pinned checkout of
`grafana/grafana` in `/app`, no ctxpipe MCP.

This task is adapted from CodeScaleBench `ccx-platform-094` (CODEOWNERS
infrastructure discovery) for ctxpipe's baseline-vs-MCP harness.

The agent must produce `/app/answer.json` with exact file paths for CODEOWNERS
infrastructure plus the package script key that orchestrates manifest
generation.

For the ctxpipe MCP arm, use
`benchmarks/tasks/ctxpipe/grafana-codeowners-discovery-ctxpipe`.

## Verifier

Reward Kit in `tests/checks.py` — local checkout guardrails plus eleven
deterministic answer checks against `tests/oracle.json`.

## Commands

```bash
harbor run -p benchmarks/tasks/ctxpipe/grafana-codeowners-discovery -a oracle
harbor run -c benchmarks/jobs/baseline-cursor.yaml
```
