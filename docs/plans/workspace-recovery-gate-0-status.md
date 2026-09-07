# Gate 0 — accepted evidence checkpoint and handoff

Evidence checkpoint **`cd45f59881b70b8612b498993a518f49425482c4`** is pushed to
`codex/develop-plan-to-refocus-branch-direction`. Both independent reviewers
verified exact equality with the live GitHub branch and returned **PASS, zero
blockers**. Their complete matrices, coverage maps, searches and later-gate
owners are in [Standards](workspace-recovery-gate-0/reviews/standards.md) and
[Spec](workspace-recovery-gate-0/reviews/spec.md).

This report commit records that accepted checkpoint. The protocol additionally
requires a narrow review of this report commit's exact pushed SHA before Gate 1
starts. The terminal SHA and reviewer verdicts are recorded in the task's final
Gate 0 handoff report; adding a self-referential SHA to this file would create a
new unreviewed commit. The accepted baseline is not a claim of working product
behavior; its failures remain requirements for subsequent gates.

## Scope and proof

- Fixed recovery start: `f632772cb10e4a220923acf4278b47e2295a5e94`.
- PR 280 head: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.
- Exact merge base: `9072089086f6fad87fbf05572b9f1ff5336e0520`.
- Reconciled scope: **465 commits, 801 files, +148441 / -13326**.
- All **421** tracked tests/stories classified: **207 proof, 214 characterization**.
- All **343** tracked test files have execution lanes, including default exclusions.
- **121** artifact checksums verified; exact commands, exits and environment retained.

See the [ledger](workspace-recovery-gate-0/evidence.tsv),
[surface coverage](workspace-recovery-gate-0/surface-coverage.md),
[journey](workspace-recovery-gate-0/golden-journey.md),
[measurements](workspace-recovery-gate-0/measurements.md), and
[reproduction](workspace-recovery-gate-0/reproduction-notes.md).

## Owned follow-ups

Gate 1 owns truthful full diagnostics/builds, excluded/optional tests, prerequisite
versions, deterministic lanes and test-policy enforcement. Gate 2 owns revision,
projection and hydrate consistency. Gate 3 owns transactional default-branch
writes. Gate 4 owns session/worktree reuse, transcript and restart durability,
shutdown and cleanup. Gate 5 owns first-message acceptance, editor state and UI
request budgets. Gate 6 owns complete product acceptance and deletion proof.

The baseline records failed tip resolution, a hydrate ReferenceError, lost Home
first message, new sandboxes on every warm turn, history that fails to accumulate,
file edits lost after restart, a listener remaining after SIGTERM, and one leaked
navigation sandbox directory. Narrow per-turn success does not erase these.

## Authorization and environment

On 2026-09-08 the user explicitly approved **all pushes** to
`codex/develop-plan-to-refocus-branch-direction`, including the public evidence
bundle, and requested that this approval not be asked again. The earlier automatic
publication rejection is resolved. Model-key use was separately authorized.
Credential scans passed; public fixture and local host metadata publication is
covered by the explicit branch-push approval.

The active isolated checkout is `/private/tmp/ctxpipe-recovery-01a07aba`.
The original developer checkout is untouched. Task backend/UI/Storybook/worker
processes are stopped and temporary SQL logging overrides reset. Disposable
pgvector/Postgres on port 51498 is retained for the next gates.
