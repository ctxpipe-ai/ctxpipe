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
| Upgrade from PR merge base | Passed | Drizzle from exact base then exact PR-head migrations on a separate disposable database. |
| Backend tests | 1449 passed, 5 failed, 3 skipped | Initial run used owner DB role and concurrent checks; five failures were timeouts. Not final runtime or flake proof. |
| UI tests | 279 passed, 12 failed | Superseded: temporary AUTH_BASE_URL=localhost:3010 conflicted with MSW handlers fixed at localhost:3000. |
| CLI/CDK tests | Initial failures | CDK tests preceded prebuild image-tag generation; CLI doctor timed out. Require ordered rerun. |
| Live OpenCode and RLS retry | Dependency startup failure | Invalid-package reads in the initial Documents checkout; no test execution. |

Exact commands, exit codes, durations, UTC starts and complete output are stored
in `workspace-recovery-gate-0/logs/`. Durations of concurrent checks are command
wall times, not application latency. A single pass is not a flake measurement.

## Reproduction

The canonical [command ledger](workspace-recovery-gate-0/evidence.tsv) selects
clean runs where available. See [reproduction notes](workspace-recovery-gate-0/reproduction-notes.md)
for exact cwd, runtime and fixture environments, and qualifications for older
logs. The committed runner executes supplied argv verbatim and records new
metadata without overwriting evidence. The upgrade helper now creates a unique
local database and unique temporary config directory, archives both fixed revisions,
and removes its database in `finally`.

## Interpretation

Scope and baseline execution are established. Full-gate independent review is
still required; this report does not declare Gate 0 complete. Product failures
are preserved in the canonical ledger and the journey/measurement reports.

## Clean temporary checkout

- Frozen install with Node 22.16.0 and a fresh package store passed in 74.3 seconds.
- UI: **61 files, 291 tests passed** in Vitest (4.40 seconds), with no API-origin override. This supersedes the initial 12 MSW failures. See `logs/tests-ui-node22.log`.

## Completed clean reruns

- Backend: **1453 passed, 1 failed, 3 skipped**. The live two-turn OpenCode test
  times out after 180 seconds; the other four initial timeout failures pass.
- Explicit OpenCode fallback: **2 passed, 1 failed**. The conversation POST
  streaming-order assertion reports `expected -1 to be greater than 15`.
- RLS isolation: **2 passed** as `ctxpipe_app`.
- CDK: **32 passed** after required prebuild generation. CLI: **93 passed,
  1 skipped**. Neither initial package failure reproduces in the ordered clean run.
- Storybook build passes; full browser suite: **347 passed, 24 failed, 0 pending**
  across 78 suites. Raw JSON and every failure name are archived.
- Codesearch default Docker lane: **219 passed, 2 skipped**, with a passing
  exit-137/OOMKilled simulation. The initial host diagnostic timeout and first
  disk-full Docker failure are preserved as superseded diagnostics.
- Reviewed upgrade helper: passes again against a uniquely named disposable
  database, then drops that database. Exact argv and cwd are in
  `logs/migrate-upgrade-pinned-local.json`; both migration trees use fixed SHAs.

## Integrated journey and repeated measurements

The user authorized the existing model key. The real clean journey fails at
native remote tip resolution. Explicitly documented fixture bypasses allow
additional HTTP/WebSocket/file/restart diagnostics without claiming a successful
clean journey. See [journey](workspace-recovery-gate-0/golden-journey.md) and
[measurements](workspace-recovery-gate-0/measurements.md) for exact scope, raw
artifacts and reproduction. Two separate 5-cold/20-warm series completed; failures
of session reuse, transcript continuity, latency and file persistence remain
visible despite single-turn successful model answers.
