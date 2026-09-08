# Gate 3 config-admission checkpoint — Spec coverage ledger

## Pin and contracts

- Reviewed exact range `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...a7129f1973caea687ae3420fc2e36fe730dd8fa8`; enumerated its commits and isolated `4a603c19...a7129f19`. All source reads used `git show`, `git grep`, or pinned diffs; the changing checkout was excluded.
- Applied `.agents/skills/code-review/SKILL.md` on the Spec axis. Compared against `docs/plans/workspace-chat-recovery.md` Gate 3 (lines 642-659), locked ticket 10, ADR-033, and pinned Gate 3 status/write-path audit.
- Treated remaining config event ordering/capture proof, obsolete setup helpers, canonical extraction, unborn bootstrap, model/allocation crash proof, Files/semantic uncertainty, duplication, and the full audit as declared open scope rather than checkpoint findings.

## Previous findings and new owner-first protocol

- Traced `prepareConnectorSync`, both enqueue helpers, lost-response `findConnectorSyncOwner`, row-locked `activateConnectorSync`, and terminal reconciliation. Config/content owners are created before setup publication; competing activations serialize by generation; terminal pre-activation content owners are installed as failed current owners, allowing a new generation retry.
- Traced all three config workflows. New inputs carry generation, full non-secret binding, config key, and immutable provider selection; first durable activation repeats API ownership. Legacy generation-zero config runs first try an idempotent content child keyed to their own run.
- Traced explicit upgrade recovery from CLI argument validation (one org, 1-100 listed IDs) through preview SQL, binding-aware preparation, native typed workflow admission, and activation. It is not invoked by migration/startup. Candidate filtering is conservative and tenant/list scoped. The intentional absence of a global auto-backfill was not treated as a defect.
- Verified completed-owner delayed API acknowledgment does not rewind an already activated content child; canceled-before-capture config owners project from input binding; config failure/retry and current-owner reads remain binding/generation fenced.

## Config callers and publication

- Traced Linear PATCH/retry and GitHub webhook, Notion PATCH/retry, and Confluence PATCH into the shared config enqueuer. HTTP enqueue failures return 503 without preclaiming setup; the Linear webhook rethrows to permit redelivery. Removed Linear/Notion claim/release helpers have no production callers.
- Traced selection hashing and each provider's semantic equality/YAML renderer. Their different canonical forms produce finding 2. Confluence's database pending-selection check is itself order-insensitive, making the raw-hash mismatch directly observable as a false 409.
- Traced config PR creation and finalization for each provider. Linear checks the generation/binding CAS, closes the created PR on loss, and fails. Notion checks and fails but does not close. Confluence's `requireConfluenceSyncTargetWrite` wrapper correctly turns a missing row or zero-row CAS into an exception, so the workflow fails; it likewise does not close its newly created PR. The shared stale-PR cleanup omission produces finding 1.
- Checked Confluence target updates and scope storage under row locks, repository/branch/provider binding capture, no-change content admission, and content-workflow first-step ownership. The acknowledged capture/event interleavings were recorded as open coverage, not findings.

## Earlier surface and evidence

- Rechecked generation-zero defaults, provider identity replacement, directory projection, connector finalization, native mirror ownership, and full-content binding assertions for regressions; none found outside the two findings.
- Inspected committed evidence for 73 checkpoint cases, 69 binding regressions, backend types at 138 acknowledged diagnostics, and proof-policy results. Per instruction, no test process was started.
