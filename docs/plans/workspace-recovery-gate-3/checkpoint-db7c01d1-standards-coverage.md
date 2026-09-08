# Gate 3 admission/recovery checkpoint — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed pin: `db7c01d13a5d763340b3d49aad50881b88aa6ac5`
- Merge base and exact SHA verified. The cumulative range has 32 commits and 1,890 changed paths. Increment `529b0bfd08d1e73618285cc5867c4859062b2c14..db7c01d13a5d763340b3d49aad50881b88aa6ac5` has 47 paths (+2,425/-61).
- Read-only review used pinned `git diff`, `git log`, `git grep`, and `git show`; the moving worktree and all test processes were excluded.

## Sources applied

- Root/backend/codesearch `AGENTS.md`; code-review skill with the complete supplied Fowler baseline; TDD `SKILL.md` and `mocking.md`; source-connectors guidance.
- ADR-027/028 short transaction ownership and updated ADR-033 native admission, immutable source, publication and replay rules; current Gate 3 status/audit.
- Tool-enforced formatting/type matters and explicitly unfinished gate inventory were excluded.

## Changed surfaces and callers

- **Graph correction:** traced all three public `graph_*` schemas/handlers through `codesearchGraphQuery`, repository-revision JWT verification and codesearch graph checkout comparison. Ordinary calls now omit a body key and select the current published checkout; captured calls suppress an explicit key and select the authenticated `rev:<sha>`. The native source contract invokes `graphFindSymbolTool` under the old captured SHA after publishing a newer SHA, closing the previous hard violation.
- **Source issue publication:** traced `repositoryIngestion` from request capture and `mark-running`, through immutable index result, extraction publication, final status branch and follow-up. `markRepositoryIndexingIssues` correctly retains hash/timestamp and the published read selectors retain the older files/Zoekt/SCIP identity, but production has already cleared readiness. The new native test calls the index child and status mutators directly and therefore does not cover this state sequence; this is the reported blocker. The first-failure owner case correctly remains unready with null publication.
- **Repository admission acknowledgement:** followed immutable request preparation, idempotent native insert, committed-row reply loss, owner lookup by workflow name/key/org/repository, worker wake, activation and retry reuse. The transparent PostgreSQL proxy observes actual `INSERT 0 1` plus transaction completion before withholding the returned row; the native client and retry assert one owner and queued projection.
- **Workspace write acknowledgement:** followed all typed enqueue branches through immutable job persistence, native enqueue failure, `reconcileWriteJobAdmission`, accepted owner discovery, worker wake and retry. Reconciliation occurs under the job row lock, matches org/workspace/job/revision and leaves a rejected insert retryable; first workflow claim still validates the full persisted command. Native returned-row and connection-loss cases use real OpenWorkflow/PostgreSQL, complete one file-edit owner, and assert one Git commit.
- **Tests/evidence:** inspected removal of the mock-only issue publisher assertion, its native replacements, admission proxy helpers/child clients, workflow owner cases, ADR/status updates, required-contract inventory and committed proof summaries. Reported results were not rerun.

## Cumulative Fowler disposition

- **Mysterious Name (2):** `sourceId`/`evidenceKey` obscures one evidence identity; `contentSyncWorkflowRunId` carries proposal/setup and content ownership.
- **Repeated Switches (1):** provider lifecycle parsing, binding and publication retain repeated provider dispatch.
- **Duplicated Code (6):** typed-write admission, connector admission, GitHub credential issuance, conversation preparation/publication, captured-source JWT assembly across four clients, and identical backend/codesearch published-checkout SQL remain. The new admission reconciliation extends the existing typed-write admission judgment rather than creating a separate smell.
- No additional Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man or Refused Bequest judgment survived repo-design overrides.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- Fowler heuristic judgments: **9 cumulative**
