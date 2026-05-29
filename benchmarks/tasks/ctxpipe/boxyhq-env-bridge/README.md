# ctxpipe/boxyhq-env-bridge

Harbor benchmark task for the **baseline arm**: pinned `boxyhq/saas-starter-kit`
checkout in `/app`, no ctxpipe MCP.

The agent must produce `/app/answer.json` with starter-kit external Jackson env
var names plus the default Polis SAML path prefix and source file path (Polis
fields may require web search or prior knowledge when siblings are not on disk).

For the ctxpipe MCP arm, use `benchmarks/tasks/ctxpipe/boxyhq-env-bridge-ctxpipe`.

## Verifier

Reward Kit in `tests/checks.py` — primary-repo presence checks plus five
deterministic answer checks against `tests/oracle.json`.

## Commands

```bash
harbor run -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge -a oracle
harbor run -c benchmarks/jobs/baseline-cursor.yaml
```
