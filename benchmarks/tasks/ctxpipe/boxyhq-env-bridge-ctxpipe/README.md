# ctxpipe/boxyhq-env-bridge-ctxpipe

Harbor benchmark task for the **ctxpipe MCP arm**: no local repository checkout
and verifier guardrails that reject a primary-repo tree on disk.

`allow_internet = true` is required so `cursor-agent` inside the trial container
can reach the hosted ctxpipe MCP URL (`CTXPIPE_MCP_URL`). Harbor implements
`allow_internet = false` as Docker `network_mode: none`, which would block MCP
as well as GitHub. Cheating via public git hosts is discouraged by the empty
workspace and instructions; the scored comparison assumes operators use a
properly ingested benchmark org.

Oracle fields match `benchmarks/fixtures/boxyhq-saas-v1.lock.json` and
`benchmarks/tasks/ctxpipe/boxyhq-env-bridge/tests/oracle.json`.

## Commands

```bash
harbor run -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge-ctxpipe -a oracle
harbor run -c benchmarks/jobs/ctxpipe-cursor.yaml
```
