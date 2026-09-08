# Gate 3 five-kind Spec review coverage

## Review identity and method

- Axis: Spec, read-only.
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Reviewed commit: `f7119635da09e39f853e9b6c64770924538a3006`.
- Commit range inspected: `e7c18bd8`, `09e34dc6`, `f7119635` via `git log` and `git diff base...reviewed`.
- All source/spec reads used `git show <reviewed>:<path>` or tree searches against the reviewed commit. The changing worktree was not used as review evidence.
- No tests were run. I accepted the checkpoint evidence in `docs/plans/workspace-recovery-gate-3/status.md`: 29 five-kind tests and the full backend typecheck with 143 acknowledged diagnostics/no new diagnostics.

## Requirements traced

| Area | Pinned implementation traced | Result |
| --- | --- | --- |
| Typed durable workflows | Bootstrap, UI file edit, import-key cleanup, claims upgrade, and valid-from persistence each expose acquire/transform/stage/validate/commit/broker-push/publish/enqueue-hydrate/complete steps. | Covered for the five migrated kinds. |
| Immutable command / ownership | `write-command.ts:52-76`; `workspace-write-jobs.ts:326+` compare kind, revision, file payload, deletions, and workflow owner. | No defect found. |
| At-most-one commit / no-op | Shared native stage/commit path; each workflow makes one candidate; no-op refresh loops re-acquire and recompute up to three times. | Common mechanics pass; claims target normalization violates semantic no-op (finding 3). |
| Native Git and file semantics | `pack.ts:9-78`; `write-tree.ts`; native pack + shallow boundary, disposable reconstruction, indexed mode preservation, deterministic commit inputs. | No defect found within reviewed proof. |
| Default/relink/CAS fences | `write-broker.ts:23-105,156-208`; binding, writable state, actual default branch and tip are checked before and after credential acquisition; normal Git push enforces non-fast-forward rejection. | No defect found. Semantic rebase is declared pending. |
| Credential ownership | Write token is requested only inside broker push after read-side admission; credentials are absent from durable pack data. | No defect found for these workflows. Alternate credential paths remain declared pending. |
| Replay and uncertain push | Prepared SHA persists before push (`workspace-write-jobs.ts:275-295`); remote equality/ancestry detects the commit at a later canonical tip (`write-broker.ts:122-184`). | Previous exact-tip and null-publication defects are corrected. |
| Hydrate boundary | Every committed path publishes a canonical revision containing the job commit, durably enqueues hydration, then completes. | Previous enqueue/completion defect is corrected. Automatic post-hydrate maintenance planning is declared pending. |
| Failure and admission status | `getWorkspaceWriteJob` reconciles only terminal failed/canceled owning runs with org/workspace/job predicates; unowned scheduling failure is separately retryable. | Previous stuck-running/admission defects are corrected. |
| Transform semantics | Bootstrap allowlist and UI literal files/deletions are enforced; import cleanup scopes to `knowledge/*.md`; valid-from uses durable per-path native history timestamps. | Claims transform/projection and metadata defects remain (findings 1-2). |

## Finding evidence details

### 1. Predicate-less upgrade suppresses all projection edges

- Locked behavior: `.ai/scratchpad/git-backed-projects/issues/02-hydration-contract.md:34-39` and `03-knowledge-file-layout.md:39-45`.
- Transform: `apps/backend/src/domain/workspaces/hydrate-write-jobs.ts:126-150` appends `{ to }`.
- Projection: `apps/backend/src/domain/workspaces/hydrate.ts:156-193` skips predicate-less claims, then suppresses the Markdown `LINKS_TO` fallback based only on resolved target equality.
- Existing native contract checks serialized YAML (`write-maintenance-native.contract.test.ts:202-208`) but does not hydrate the resulting commit and assert its graph.

### 2. Whole-sequence lossy claim reconstruction

- `parseClaims` omits documented `generated_by` and every unknown claim field (`hydrate.ts:251-268`).
- `claimRecord` can emit only `to`, predicate, confidence, validity, and source (`hydrate-write-jobs.ts:115-123`).
- `serializeKnowledgeClaims` replaces the entire claims value (`:98-113`); both migrated maintenance kinds use it (`:141-147`, `:172-184`).
- The metadata regression test covers top-level name/tags and a top-level YAML comment, not fields/comments attached to existing claim items.

### 3. Raw target comparison

- Remainder and transform use `claim.to === link` (`hydrate-write-jobs.ts:13-16,135-143`).
- Hydration already has the needed file-relative resolver (`hydrate.ts:214-230`), demonstrating `api.md`, `./api.md`, fragments, and normalized `..` forms can identify the same unit.
- Repeated Markdown links are also appended repeatedly because `missing` is not deduplicated.

## Explicitly deferred and not reported as findings

Seven remaining job kinds; automatic post-hydrate scheduling and remainder/attempt guards; semantic conflict/rebase; protected/paused resume; deeper restart/replica coverage; alternate writer/credential migration; legacy choreography deletion. These prevent terminal Gate 3 acceptance but were declared pending for this checkpoint.

## Additional observation not elevated

Import cleanup uses a raw top-level-key regex after YAML parsing, so quoted/BOM/flow-map spellings can parse as `import_key` yet be left unchanged. The migration exporter emits the plain spelling exercised by current contracts, so this was retained as a hardening gap rather than a checkpoint finding.
