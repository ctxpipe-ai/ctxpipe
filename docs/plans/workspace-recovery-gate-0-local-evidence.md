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

The canonical [command ledger](workspace-recovery-gate-0/evidence.tsv) selects
clean runs where available. See [reproduction notes](workspace-recovery-gate-0/reproduction-notes.md)
for exact cwd, runtime and fixture environments, and qualifications for older
logs. The committed runner executes supplied argv verbatim and records new
metadata without overwriting evidence. The upgrade helper now creates a unique
local database and unique temporary config directory.

## Interpretation

Scope restoration and migration success are established. Runtime evidence,
classification and independent review remain incomplete. Gate 1 must not be
reported as started or complete on the basis of this checkpoint.

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
- Storybook build: passed. The selected conversation-navigation play fails on
  stale expected text; see `browser-observations.md` for the exact step. This is
  one selected interaction, not a full browser suite.
- Codesearch host diagnostic: **203 passed, 1 failed, 3 skipped**. The
  serialized-indexer test times out at five seconds; failure prevents the
  subsequent Bun globFiles lane. The full Docker/indexer lane remains unrun.
- Reviewed upgrade helper: passes again against a uniquely named disposable
  database; its exact argv and cwd are in `logs/migrate-upgrade-reviewed.json`.

## Integrated journey blocker

The isolated UI starts, but backend startup refuses missing
`MODEL_PROVIDER_API_KEY`; browser connection to localhost:3010 is refused.
Automatic approval review rejected reading the existing key from the developer
checkout because reuse and possible external model calls were not explicitly
authorized. The key has not been loaded. User approval is pending. No golden
journey, chat latency, provider/request budget or full cleanup proof is claimed.
