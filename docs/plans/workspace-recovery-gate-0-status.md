# Gate 0 status — full scope restored, validation in progress

The GitHub and npm 403 blockers are resolved. Gate 0 is **not complete** and Gate 1 has not started.

## Fixed points

- Starting recovery checkpoint: `f632772cb10e4a220923acf4278b47e2295a5e94`.
- Required branch: `codex/develop-plan-to-refocus-branch-direction`.
- PR 280 head: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.
- PR merge base: `9072089086f6fad87fbf05572b9f1ff5336e0520`.
- Verified totals: **465 commits, 801 files, +148,441/−13,326**.
- Source inventory: **421 unique tracked test/story files** at the PR head.

See the [scope bundle](workspace-recovery-gate-0/baseline.md),
[command ledger](workspace-recovery-gate-0/evidence.tsv), and
[local validation notes](workspace-recovery-gate-0-local-evidence.md).

## Completed since the cloud checkpoint

- Fetched full ancestry and reconciled all four totals against GitHub metadata.
- Restored the transferred baseline collector and regression fixtures.
- Fixed BSD awk compatibility and duplicate test paths. The inventory now reads
  tracked files at the named PR head, excluding untracked/generated output.
- Ran a successful frozen install; both fresh migrations and upgrade from the
  exact PR merge-base schema pass against disposable pgvector/Postgres 17.
- Ran unfiltered backend/UI typechecks, all declared workspace builds, backend/UI
  tests, and CLI/CDK tests. Logs retain failures and environment qualifications.

## Remaining gate requirements

- Push the complete baseline candidate and obtain fresh independent Standards and
  Spec adversarial review of the exact remote SHA; resolve every blocker.
- Record that final verified SHA and review artifacts before starting Gate 1.

All 421 test/story classifications are now reviewed (207 proof, 214
characterization). The full Storybook run records 347 pass / 24 fail / 0 pending;
the required Docker lane records 219 pass / 2 skipped plus a passing OOM simulation.
The real manual journey fails; diagnostic continuations, two separately reported
5-cold/20-warm series, resource cleanup, query counts and restart behavior are
archived in the canonical bundle. Failing product behavior is baseline evidence,
not a reason to disguise failure or claim product acceptance.

## Environment recovery

The initial isolated clone lived in Documents and later exhibited filesystem
read stalls (`pread`, including a native `fsevents.node`) and stalled native git
reads. A fresh clone and a separate dependency store in `/private/tmp` avoid
reusing those dependency files. The original developer checkout and its local
changes were preserved. Node 22.16.0 is selected explicitly for resumed checks;
initial pnpm subprocesses used Node 23.10.0 despite the shell reporting Node 24.

Do not treat interrupted/stalled commands, API-origin mismatch tests, or tests
run concurrently with prebuild generation as product-failure counts. Their logs
remain for diagnosis; qualifying reruns must be separately named.

## Latest findings and review

See the [journey](workspace-recovery-gate-0/golden-journey.md) and
[measurements](workspace-recovery-gate-0/measurements.md). Native fixture tip
resolution fails; a seeded-SHA diagnostic hydrate reaches a missing-import
ReferenceError. Home first-message handoff loses the message. Warm HTTP turns
create new sandboxes/sessions and retain only three history records. File API
editing/diff works, but the edit is lost across backend restart. SIGTERM leaves a
listener using a closed DB pool. All are owned follow-ups for Gates 1–5; none is
claimed fixed in Gate 0.

The user explicitly authorized the existing model key and the model runs have
completed. The earlier credential-review rejection is resolved. Full ancestry,
npm installation, Docker build, and branch push are available locally.

Previous checkpoint `23ccd60c496ef6f9453a64c5afefe25c3b0378b1` was pushed,
remotely verified, and cleared by both reviewers for its correction scope only.
It was not full Gate 0 approval. The completed evidence bundle now awaits a fresh
exact-SHA review. Gate 0 remains open and Gate 1 has not started.
