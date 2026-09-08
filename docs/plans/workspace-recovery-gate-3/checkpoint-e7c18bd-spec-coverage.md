# Gate 3 checkpoint — Spec coverage

## Review identity and method

- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed: `e7c18bd854a54f7d8190c663a014c5f0158ed67e`
- Diff: `git diff bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e7c18bd854a54f7d8190c663a014c5f0158ed67e`
- Commit: `e7c18bd8 Gate 3: add native bootstrap and file edit workflows with replay fences`
- All source and documentation reads used `git show`/`git grep` against the reviewed SHA because the checkout contains later uncommitted work.
- Read-only static review; no tests, branch changes, product mutations, pushes, or subagents.

## Sources read

- Root `AGENTS.md` and `apps/backend/AGENTS.md` at the reviewed SHA.
- `docs/plans/workspace-chat-recovery.md`, especially Gate 3 lines 642-659.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md`, including commit, conflict, runner, replay, hydration, and binding requirements.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md` in full.
- `docs/plans/workspace-recovery-gate-3/status.md` in full.
- The full changed production surface, with detailed tracing of both new workflows, admission, durable job models, revision CAS, credentials, native Git pack helpers, file planning, worker registration, and the new contract suite.

## Scope handling

The review treats this as an intermediate checkpoint. It does not report the ten remaining generic job kinds, protected/paused resume, semantic merge/restart depth, alternate default writers/credential paths, shared transport cleanup, or explicit subject-model selection as discoveries. Those are already declared pending in status lines 28-31. The 11/11 real PostgreSQL/OpenWorkflow/bare-Git/worker-discovery result and the complete backend type result with 143 acknowledged diagnostics were accepted as supplied evidence, then checked for coverage gaps rather than rerun.

## Requested-focus coverage

| Focus | Traced behavior | Result |
| --- | --- | --- |
| At most one commit | Immutable `jobId` row, atomic workflow owner claim, durable subject/date, prepared commit SHA, normal Git push | Ownership and deterministic reconstruction look sound for the covered success/replay cases. Failure state and advanced-tip recovery remain incorrect (findings 2, 4). |
| No-op | Transform filters unchanged content, then records completion without creating a commit | Correct only while the captured binding remains current. It bypasses live URL/generation/default/tip admission (finding 1). |
| Immutable command ownership | Admission persists revision/files/deletions; workflow compares exact revision and deep-equals the file command; one `workflowRunId` claims ownership | Covered by the concurrency test. Scheduling failure after row creation can orphan the immutable command (finding 4). |
| Default/relink fences | Acquire checks full revision; broker checks before credentials and again after credential issuance; actual HEAD symref is checked | Push path is fenced. The no-op path skips all late fences (finding 1). |
| Actual Git CAS/non-FF | Push is a normal non-force `<commit>:refs/heads/<default>` update, so Git rejects non-fast-forward races | Appropriate for the immediate push. Recovery tests only exact tip equality and not “commit is contained by branch” (finding 2). |
| Uncertain push after desired revision advances | Existing test loses one acknowledgement, refreshes desired exactly to the job commit, then succeeds without another token | Missing descendant case B→C. Both desired-revision precheck and tip equality reject even though B is already published (finding 2). |
| Replay/step completion vs hydration enqueue | Completed replay reads the durable job row. Hydration enqueue has a stable `${jobId}:hydrate` key and precedes completion when `published` is non-null | `published === null` skips enqueue yet still completes, contradicting the claimed ordering (finding 3). |
| Native pack semantics | Shallow fetch is packed with its `.git/shallow` boundary; staged tree/blobs and deterministic commit are repacked; each step reconstructs a disposable repo; credentials are absent from pack data | The basic pack identity and shallow reconstruction are coherent. No correctness finding was raised solely from static pack mechanics. Existing-file writes hardcode mode `100644`; this is an untested fidelity risk for executable/symlink entries but was not elevated because the current Files contract is text-oriented and the locked spec does not state mode behavior. |
| Credential ownership | Read credential is used for fetch/tip checks; repository-scoped write token is obtained only inside `broker-push` and passed only to Git subprocess environment | Correct for the two migrated workflows. Alternate credential/writer paths remain explicitly pending and were not counted. |

## Finding detail and missing proofs

### 1. Stale no-op completion

Both transforms compare against `revision.sha`, then `complete-no-op` writes `completed`. Unlike `broker-push`, that branch never reads the live workspace, desired revision, actual remote HEAD, or write status. Missing proof: pause after acquire, advance or relink the remote, and verify a command that was a no-op only at the old SHA does not complete silently.

### 2. Published commit contained by a later tip

The replay gate recognizes only equality with `committed.sha`. It never fetches the current branch to determine whether the persisted commit is an ancestor. Missing proof: push B, lose acknowledgement, push C with parent B and refresh desired to C, then retry. Expected: no second commit/push, one durable job result, and canonical hydration. Current source rejects before that reconciliation.

### 3. Publication CAS miss

After broker success, `captureWorkspaceRevision` can return null when another observer advances desired state. The fallback handles only exact equality with the job commit. `if (published)` guards hydration, while completion is unconditional. Missing proof: advance desired to a later canonical revision between broker return and `publish-result`; assert the job cannot become completed without a durable hydration run (or an explicit durable superseded result defined by the product contract).

### 4. Failure-state durability

The native workflows transition the row to `running` during acquire and do not catch terminal workflow failure. The tests for connection detachment and default-branch change assert the OpenWorkflow run is failed but do not assert the public `workspace_write_jobs.status`; source leaves it running. The native enqueue catch also lacks the generic path's paused-state write. Missing proofs: inspect job state after retry exhaustion and after scheduler admission failure, and verify it is actionable rather than permanently queued/running.

## Other observations not elevated

- Normal Git push supplies real non-fast-forward rejection; no force option is present.
- The bootstrap allowlist is checked both while staging and while validating the tree.
- Commit subject and timestamp are durable step inputs, so a repeated commit step reconstructs the same object.
- `persistWriteJobPreparedCommit` prevents one job ID from being rebound to a different commit SHA.
- File-edit command payload is immutable across replay, though duplicate file paths or overlap with deletion paths are not rejected by the schema. Current callers generate non-overlapping plans, so this remains hardening rather than a checkpoint finding.
