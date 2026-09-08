# Gate 3 six-kind Spec review coverage

## Identity and method

- Spec review, read-only.
- Base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; reviewed exact pushed commit `46aaecab94c53fef0460b6e359bcadec3483b427`.
- Enumerated commits `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`; inspected the full base diff and the focused `f7119635...46aaecab` delta.
- Used only `git show <reviewed>:<path>`, `git diff`, `git log`, `git ls-tree`, and `git grep` against the pinned object graph. The changing checkout was not evidence.
- No test/type suite was rerun. Accepted supplied evidence: 55 native assertions and full backend typecheck with exactly 143 acknowledged diagnostics and none new.

## Locked sources

- `docs/plans/workspace-chat-recovery.md:642-659` (Gate 3 durable workflow/native Git/broker/one-commit exit).
- `.ai/scratchpad/git-backed-projects/issues/02-hydration-contract.md:30-45` (Git-canonical projection, claim layers, root `AGENTS.md`).
- `.ai/scratchpad/git-backed-projects/issues/03-knowledge-file-layout.md:15-45` (tree, semantic folder section, metadata and claim schema).
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:66-132` (one concern/commit, no-op, ops job, replay and hydrate).
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:7-23` (recovery override and native ownership).

## Six-kind trace

| Area | Pinned evidence | Assessment |
| --- | --- | --- |
| Bootstrap | Typed `workspace-bootstrap`; root/skill allowlist; shared immutable acquire and native stage/commit. | No new defect found. |
| UI file edit | Literal files/deletions are schema-bound and persisted; target modes retained; one native candidate. | No new defect found. |
| Import cleanup | YAML document node deletion now covers quoted/block/BOM/CRLF forms while preserving other nodes/body. | Prior hardening observation corrected. |
| Claims upgrade | `missingClaimLinks` resolves/deduplicates relative targets; YAML sequence is mutated; hydrate maps missing predicate to `LINKS_TO`. | All three prior claims findings corrected. Native test now hydrates the committed revision and reads the active graph. |
| Valid-from | Existing YAML claim nodes receive only the missing/SHA `valid_from`; custom keys, anchors and comments remain. Native history timestamps remain per path and durable. | Prior metadata-loss finding corrected. |
| Ops/folder map | Typed workflow reads all paths from the immutable pack, only stages `AGENTS.md`, uses common broker/publication/hydrate completion, and proves a second direct run no-ops. | Name propagation, semantic ownership, and malformed-marker convergence defects remain (findings 1-3). |

## Common mechanics rechecked

- `write-command.ts`: completed-command identity still binds kind, revision, files and deletions; `reconcileWorkspaceWriteJob` is a naming-only correction at the reviewed delta.
- `write-broker.ts`: actual-default and full binding checks bracket credential issuance; ordinary Git push rejects non-fast-forward; canonical publication requires equality/ancestry; descendant lost-ack replay remains recoverable.
- `pack.ts`: native pack plus shallow boundary remains durable; new `readGitFiles` reconstructs the immutable pack and reads blobs without persisting paths or credentials.
- All committed workflows persist the candidate SHA before push, publish a canonical containing revision, durably enqueue hydrate, then mark complete. Apparent no-ops refresh and recompute against the actual tip.
- Status reconciliation remains restricted to a terminal owning run with org/workspace/job identity; failed admission remains retryable.

## Folder-map source tracing

- Production rename entry: `apps/backend/src/routes/v1/workspaces.ts:378-415`.
- Rename lifecycle: `apps/backend/src/domain/workspaces/workspace-lifecycle.ts:95-107`; it has no requested-name parameter.
- Command schema/payload: `apps/backend/src/domain/workspaces/write-job-intent.ts:17-103`; no ops name field is durable.
- Transform: `apps/backend/src/domain/workspaces/folder-map.ts:23-140`.
- Native workflow: `apps/backend/src/openworkflow/workflows/workspace-ops-folder-map.ts:38-192`.
- Existing native contract (`write-maintenance-native.contract.test.ts:508-649`) proves one well-formed custom heading, live/dead/added top-level paths, unrelated sibling sections, one commit, and direct second-run no-op. It does not exercise the production rename request, unrelated keyword headings, incomplete markers, or duplicate marker pairs.

## Declared pending scope excluded from findings

Six other typed kinds; automatic post-hydrate planning and per-kind attempt/remainder enforcement; semantic conflict recovery; protected/read-only pause/resume; alternate writer/credential migration; legacy choreography deletion. These still prevent terminal Gate 3 acceptance but are not presented as discoveries in this checkpoint review.

## Additional boundaries inspected without elevation

- Directory inventory derives tracked Git prefixes and adds missing non-hidden top-level folders. Gitlinks and absent/hidden directories are not added automatically; the locked text does not settle whether those operational paths belong in the user map.
- Maintenance reads a symlink blob as its link target and staging preserves mode `120000`. Targeted maintenance of a symlinked `AGENTS.md`/knowledge file is not specified by the lock; a future hardening test should either reject such targets or define symlink editing explicitly.
