# ctxpipe/storage-decision-ctxpipe

Harbor benchmark task for the **ctxpipe arm**: no repository checkout and
verifier guardrails that reject a local primary-repo tree.

The agent must use the configured hosted ctxpipe MCP server to gather org-wide
context and produce `/app/answer.json`.

`allow_internet = true` is required because Cursor CLI runs inside the trial
container and must reach `CTXPIPE_MCP_URL`.

## Verifier

Reward Kit in `tests/checks.py` with deterministic scoring:
- ctxpipe filesystem guardrails
- schema and option checks
- evidence quantity and cross-repo checks
- precision scoring against `tests/oracle.json`

## Commands

```bash
harbor run -p benchmarks/tasks/ctxpipe/storage-decision-ctxpipe -a oracle
harbor run -c benchmarks/jobs/ctxpipe-cursor.yaml
```
