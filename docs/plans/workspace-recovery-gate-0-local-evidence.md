# Gate 0 local validation evidence

This supersedes the cloud-only dependency-contaminated diagnostics. Product
source is unchanged from PR head; the recovery checkpoint adds documentation,
UI testing instructions, and hydration characterization tests.

## Initial local results

| Check | Result | Qualification |
| --- | --- | --- |
| Frozen install | Passed | 19.8 seconds; pnpm default policy skipped dependency lifecycle scripts. |
| Lint | Passed | See `logs/lint.log`; warnings are retained. |
| Backend full typecheck | Failed: 177 diagnostics | `tsc --noEmit`; no path filtering. |
| UI full typecheck | Failed: 391 diagnostics | Includes imported backend types; counts must not be added as independent unique defects. |
| Workspace builds | Backend and codesearch failed | UI, docs, CLI and CDK builds passed; no early bailout between workspaces. |
| Fresh migration | Passed | Full Drizzle, OpenWorkflow, checkpoint, secret-backfill and role-provisioning command. |
| Upgrade from PR merge base | Passed | Drizzle from exact base then current migrations on a second disposable database. |
| Backend tests | 1449 passed, 5 failed, 3 skipped | Initial run used owner DB role and concurrent checks; five failures were timeouts. Not final runtime or flake proof. |
| UI tests | 279 passed, 12 failed | Superseded: temporary AUTH_BASE_URL=localhost:3010 conflicted with MSW handlers fixed at localhost:3000. |
| CLI/CDK tests | Initial failures | CDK tests preceded prebuild image-tag generation; CLI doctor timed out. Require ordered rerun. |
| Live OpenCode and RLS retry | Dependency startup failure | Invalid-package reads in the initial Documents checkout; no test execution. |

Exact commands, exit codes, durations, UTC starts and complete output are stored
in `workspace-recovery-gate-0/logs/`. Durations of concurrent checks are command
wall times, not application latency. A single pass is not a flake measurement.

## Reproduction

Use the committed collector command in `baseline.md` and a complete frozen
install before runtime checks. `run-check.py` records bounded commands (600-second
limit), removes unrelated inherited service credentials, selects Node 22 via
Volta, and supplies only disposable test credentials. Its database port refers
to this local run and must be adjusted for a new disposable container. The
`migrate-upgrade.py` helper uses the installed Homebrew psql and a new database;
it does not connect to the developer's main database.

Initial disposable container: `ctxpipe-recovery-gate0-vector-20260907`, image
`pgvector/pgvector:pg17`, localhost port 51498. Fresh database:
`ctxpipe_gate0_fresh`; upgrade database: `ctxpipe_gate0_upgrade`. Password values
in the runner are public test fixture values and must never be reused for a
shared deployment.

## Interpretation

Scope restoration and migration success are established. Runtime evidence,
classification and independent review remain incomplete. Gate 1 must not be
reported as started or complete on the basis of this checkpoint.

## Clean temporary checkout

- Frozen install with Node 22.16.0 and a fresh package store passed in 74.3 seconds.
- UI: **61 files, 291 tests passed** in Vitest (4.40 seconds), with no API-origin override. This supersedes the initial 12 MSW failures. See `logs/tests-ui-node22.log`.
