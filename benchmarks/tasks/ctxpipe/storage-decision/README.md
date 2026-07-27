# ctxpipe/storage-decision

Harbor benchmark task for the **baseline arm**: sparse pinned checkout of
`grafana/loki` (primary) in `/app`, without ctxpipe MCP. Agents should also
reference sibling repos `grafana/tempo` and `grafana/mimir` for cross-repo evidence.

The agent must produce `/app/answer.json` with a storage decision, alternatives,
and evidence records grounded in code.

For the ctxpipe MCP arm, use
`benchmarks/tasks/ctxpipe/storage-decision-ctxpipe`.

## Verifier

Reward Kit in `tests/checks.py` with deterministic scoring:
- schema and option checks
- evidence quantity and cross-repo checks
- precision scoring against `tests/oracle.json`

## Commands

```bash
harbor run -p benchmarks/tasks/ctxpipe/storage-decision -a oracle
harbor run -c benchmarks/jobs/baseline-cursor.yaml
```
