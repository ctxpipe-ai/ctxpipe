# Gate 1 — required execution and truthful CI

Status: all 13 CI jobs passed at `05a3c6e4`, `6d180ca8` and `bec0c492`; final policy corrections, exact-commit
CI and independent review closure are pending. This is not a Gate 1 completion claim.

Starting point: `7dfa6b93a5baedc3eb2c86dd1056662e89cace00` (approved Gate 0).
Branch: `codex/develop-plan-to-refocus-branch-direction`; existing PR 319.

## What a green check establishes

- All seven affected TypeScript projects execute their actual compiler programs.
  The reviewed allowances remain backend 177, UI 391, codesearch 11, CDK/CLI/
  self-host/docs zero. Every diagnostic is printed; new or stale identities and
  increases in historical multiplicity fail. Generated CDK and docs prerequisites
  run in the same job as their consumers.
- Structured test results must match the discovered file inventory, case totals,
  suite status, and process exit. Missing binaries, suites, cases, skips, todos,
  hook/process failures, changed errors, or stale allowances fail the command.
- CI builds backend, worker, UI, codesearch, docs, and OpenTelemetry production
  images; builds distributable CLI/CDK and backend/codesearch entrypoints;
  typechecks self-host; validates Terraform without remote state credentials.
- Test policy parses syntax, including chained/aliased selection modifiers and
  test configuration retries, destructuring aliases, and Playwright fail/fixme.
  Test options reject mutable bindings, object writes, retries and expected
  failure/selection options. Lexical constants respect scope and computed keys.
  YAML parsing preserves folded commands; local ESM/CommonJS and custom config
  paths are discovered. The two CI runners' literal retry argv is also checked.
  Final local inventory is 433 source/config/runner files and 27 command files.
  Domain table rows and helper namespaces remain distinct from test options.
  The accepted Gate 0 characterization inventory is
  read from its immutable commit, so editing a TSV cannot bypass proof policy.
- Codesearch runs every discovered test, routing its two Bun.Glob-dependent
  files through Bun and the remaining tests through Node. Both reports must
  account for every file and executed case. Full Docker tooling uses amd64.

## Measured local execution

| Command / evidence | Result |
| --- | --- |
| `typecheck-workflow-contracts` | Seven projects checked; exact existing allowances only |
| `backend-reviewed-fixtures` | 1,480 cases: 1,479 pass, 1 exact acknowledged existing failure, zero skipped |
| `contracts-full-workflows` | 23 cases in 7 files pass, zero skipped |
| `ui-required-runner` | 291 cases in 61 files pass |
| `cli-build-prerequisite` | 93 cases in 10 files pass, with the CLI built by its runner |
| `cdk-required-runner` | 32 cases in 4 files pass |
| `policy-config-final-tests` | Five public CI-script regression tests pass; mutable settings and expected-failure options covered |
| `terraform-validate` | Configuration valid with backend disabled and no credentials |
| `ci-05a3c6e4-codesearch-contracts` | All 221 cases in 33 files pass: 184 Node and 37 Bun, zero skipped |

Each named local check has raw output in `logs/`; the recorder's JSON files
include argv, fixture environment, timestamps, duration, and process exit.
Failed attempts are retained. In particular, Docker disk exhaustion stopped the
task database; its restart reassigned the host port from 51498 to 61314. The two
connection-refused chat runs are infrastructure failures, followed by a passing
run on the actual port. No failure was converted into a skip.

## Contract meaning and limits

The PostgreSQL lane exercises tenant RLS and sandbox persistence with a role
that cannot bypass RLS. Native git and local-process sandbox/worktree cases run
real processes and files. Hydrate submits the actual workflow through a real
OpenWorkflow PostgreSQL backend, in a unique namespace, for 0, 1, and 100 files
in bare Git remotes. Only the external embedding HTTP endpoint is substituted.
Assertions inspect the completed durable run, committed contents, active SHA,
and persisted embedding phase. Fixtures delete their workflow and domain rows.

The write-workflow cases are **characterization**, not successful write proof.
All 12 currently declared kinds run once through the real client and worker.
Each exposes the existing `requireCurrentOrgId is not defined` error in a failed
durable run, with no domain job row or remote ref change. The separate local
sandbox/worktree contract proves that runtime executes. Gate 3 must replace
these exact-error characterizations with successful stage/commit/CAS/push and
failure-recovery contracts. Fixing the current product failure here would break
the plan's gate ordering.

Chat runs the real PostgreSQL stores, local sandbox, pinned OpenCode 1.18.18,
and Hono model proxy, substituting only upstream model HTTP. Two turns produce
exact scripted replies. The second input is built from the first persisted
transcript, and official reconstruction returns that transcript. Destruction
removes sandbox instance rows. This does not yet prove the Gate 4 restart,
snapshot durability, cumulative-session, or replica-race invariants.

The existing mocked `.live.test.ts` conversation transport failure remains
visible with its exact error allowance. Its owned substitutions make it Gate 0
characterization, not contract proof. Fixture environments, temporary homes,
repositories, and the direct SDK sandbox are now cleaned up.

## Linux CI

- Run 34170657662 at `ee6aeab5` exposed missing CLI/CDK build prerequisites and
  the Bun slim image's Debian Trixie/JDK17 mismatch. Raw failed logs are retained.
- Run 34171137539 at `20ff56b6` has passed full typecheck, tests, migrations,
  script/policy checks, package builds, codesearch image, and OpenTelemetry.
  The other five jobs were later cancelled as described below.
- A final run on the reviewed checkpoint is required before Gate 1 closes.
- The five remaining jobs in run 34171137539 stopped reporting progress in
  pnpm installation within their first minute and were cancelled after about
  20 minutes to collect their logs. The `ci-20ff56b6-stalled-*` logs retain this
  evidence. Docker dependency installation and frontend builds now use Node 22;
  service runtime stages remain Bun. Build jobs have a 30-minute limit.

- Run 34172316421 at `05a3c6e4` completed with all 13 jobs successful,
  including every production image and the full codesearch tooling contracts.
  `logs/ci-05a3c6e4-complete.json` records each job and exact head SHA.
  This establishes the Node build-stage fix; subsequent policy corrections
  require their own exact-commit CI result.

## Deletion and subsequent ownership

Removed: path-filtering logic from CI typecheck wrappers, backend integration/
RLS exclusions, OpenCode opt-in skips, Bun.Glob skips, UI empty-suite success,
and the CLI's empty live-eval placeholder. These commands now execute or fail.

Gate 2 deletes redundant revision/projection reconstruction. Gate 3 replaces
all write-error characterizations and the old write-runner ownership. Gate 4
replaces the chat transport characterization and duplicate sandbox owners.
Gate 5 replaces UI hook/transport simulation with browser interaction proof.
Gate 6 removes the temporary diagnostic/failure allowances, obsolete
characterization, compatibility mappings, and this recovery-only scaffolding
where it no longer serves ongoing CI.
