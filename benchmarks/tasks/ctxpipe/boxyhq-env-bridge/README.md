# ctxpipe/boxyhq-env-bridge

Deterministic v1 Harbor benchmark task for the BoxyHQ fixture. The agent writes
`/app/answer.json` with five exact fields that bridge local product-repo context
to org-level SSO context.

## Environment

- Base image: `ubuntu:24.04`
- Installed: `git`, `python3`, `ca-certificates`
- Local repo in workspace: `boxyhq/saas-starter-kit` pinned to
  `abc9b686823cbfb4973c79bc36fea37a3244be6c`
- Agent timeout: `900s`

## Verifier

- Verifier entrypoint: `tests/test.sh`
- Deterministic checker: `tests/checks.py`
- Oracle source: `tests/oracle.json`
- Reward: binary (`1` pass, `0` fail)

## Layout

- `instruction.md` — task prompt and output schema
- `task.toml` — Harbor metadata and runtime config
- `environment/Dockerfile` — benchmark environment
- `solution/solve.sh` — oracle smoke reference solution
- `tests/checks.py` — deterministic equality checks
- `tests/oracle.json` — pinned expected values
- `tests/test.sh` — verifier launcher

## Run

From repository root:

- `harbor run -a oracle -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge`
- `harbor run -a cursor-cli -p benchmarks/tasks/ctxpipe/boxyhq-env-bridge`
