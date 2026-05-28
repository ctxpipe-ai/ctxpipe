# ctxpipe/boxyhq-env-bridge

Harbor benchmark task that tests cross-repo org-context retrieval for SSO
integration details.

## What the agent does

The agent receives only the primary repository workspace and must produce
`/app/answer.json` with starter-kit external Jackson env var names plus the
default Polis SAML path prefix and source file path.

## Verifier

Verifier uses Reward Kit in `tests/checks.py` with five equally-weighted
deterministic checks against `tests/oracle.json`.

## Commands

```bash
harbor run -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge -a oracle
harbor run -c benchmarks/jobs/baseline-cursor.yaml
harbor run -c benchmarks/jobs/ctxpipe-cursor.yaml
```
