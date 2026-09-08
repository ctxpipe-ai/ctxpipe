# Gate 3 G3-C milestone — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed Gate 3 base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed increment: `9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf..ce00e052b18bceda71909afde37443070b03f5a8` (one commit, 57 paths, +3,609/-29; 16 production/schema/config paths plus tests and evidence).
- Exact pin and fixed merge base were verified. Inspection used pinned `git diff`, `git log`, `git show`, `git grep`, and `git ls-tree`; the moving worktree and test execution were excluded.

## Standards and scope

- Root and backend `AGENTS.md`; code-review and TDD/mocking skills; ADR-027 and ADR-033; accepted `remaining.md`/status evidence.
- G3-C empty-repository behavior only. G3-D–G and tooling-enforced matters were excluded. The nine existing Fowler judgments were carried forward without re-investigation.

## Changed surfaces and caller trace

- **Identity/schema:** inspected `UnbornBootstrapBinding` schema/type, write-job JSON typing, intent payload, and native-owner SQL matching. The binding carries workspace, generation, remote URL/connection, and symbolic default without manufacturing a SHA.
- **Read/capture:** traced `resolveWorkspaceReadRevision` empty-tip handling and `captureUnbornBootstrapBinding` through transient read credential resolution, protocol-v2 unborn HEAD discovery, and the post-network workspace-binding check.
- **Native Git:** reviewed empty repository creation, blob/index/tree construction, allowed-path validation, deterministic parentless `commit-tree`, pack capture/restoration, and cleanup. Traced broker inspection before and after credential issuance, non-force first push, permission pause, lost-ACK ancestry, and competing-first-writer fallback.
- **SQL ownership:** inspected `persistUnbornBootstrapJob`, `persistWriteJobPreparedCommit`, `adoptInitializedBootstrapRevision`, terminal reconciliation, and conversion to `persistBoundWriteJob`. Multi-statement ownership changes remain inside `orgSql`; Git and credential I/O remain outside transactions. Adoption requires the same running owner, full binding, and exact candidate, then clears that candidate.
- **Workflow:** traced admission from `createWorkspaceLifecycle` and direct enqueue through immutable intent, native owner recovery, explicit claim/transform/stage/validate/commit/push/publish/hydrate/complete steps, paused resume, initialized-repository adoption, and the existing normal bootstrap/semantic path. The blocker is the mismatch between the unborn completed-row branch (`workspace-bootstrap.ts:97-117`) and normal no-op completion (`:311-325`).
- **Callers/tests/contracts:** inspected create/select lifecycle dispatch, empty hydration, direct admission, read-only/relink/default-change, first-writer preservation, completed replay, worker loss/SIGKILL, and required CI contract registration. The first-writer fixture adds only `README.md`, so it cannot exercise adopted no-op completion/reconstruction. Reported 55 affected cases, root-push SIGKILL, backend type baseline, and policy counts were accepted as evidence and not rerun.
- **Docs/evidence:** checked the ADR-033 unborn-repository decision, G3-C ledger, status narrative, prior milestone review/coverage, and recorded canonical-URL fixture diagnostics.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- New Fowler heuristic judgments: **0**
- Fowler backlog retained: **9** (2 Mysterious Name, 1 Repeated Switches, 6 Duplicated Code)
