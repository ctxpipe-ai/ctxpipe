# Gate 3 twelve-kind Spec coverage ledger

## Pin and governing requirements

- Read only objects at target `cab528013bb3e49ddfc05d419984f03494d6579d`; fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Enumerated the complete nine-commit log and `git diff --name-status BASE...TARGET`.
- Re-read target Gate 3 (`docs/plans/workspace-chat-recovery.md:642-659`), locked ticket 10 (especially lines 47-55, 68-82, 120-132), ADR-033, target status, root/backend instructions, and prior pinned review reports.
- Review was source tracing only. I did not run tests or inspect the moving worktree.

## Changed production surfaces and caller tracing

| Surface | Target blobs/callers traced | Result |
|---|---|---|
| Command model and admission | `write-job-intent.ts`, `workspace-write-jobs.ts`, `enqueue-workspace-write-commit.ts`, `workspace-tip-check.ts`, resume reconstruction, discovery | Two findings: fallback upsert can replace any uncommitted command; semantic subtype validation occurs after the status branch |
| Twelve native kinds | bootstrap, UI edit, import cleanup, claims, valid-from, folder map, link/unlink, export, rename, extract, mirror, semantic workflow schemas and step graphs | Registered; earlier kind-specific findings rechecked; no new transform defect |
| Shared Git command path | `write-command.ts`, `write-tree.ts`, `pack.ts`, `merge-tree.ts`, clone helpers | Captures current+previous objects; native merge-tree uses explicit previous base; resulting tree is committed with current tip as sole parent |
| Push/publication recovery | broker, acquire/refresh, prepared SHA, publish, hydrate enqueue, completed reconciliation | Existing one-commit/CAS/uncertain-push fences remain coherent for implemented clean path |
| Projection/identity | `migration-export.ts`, export/extract workflows, durable knowledge-path model readers/writers | Mapping reuse is completed-result, same workspace/generation/URL/branch/connection scoped and requires current Git path |
| Mirror binding | connector domain plus Confluence/Linear/Notion/Slack model readers and mirror workflow | Provider identity, repository URL, files/deletes retained; one joined query supplies full tuple; validation precedes pause branching |
| Public/legacy callers | workspace file/link routes, lifecycle/hydrate maintenance, generic `workspace-write-commit.ts`, `write-job-agent.ts` | Typed callers covered. Generic semantic handoff and provider callers remain declared migration scope |
| Schemas/config | workspace DB JSON payload/types, package/lock, Vitest serialization, CI contract/diagnostic manifests | Payload fields represented; no SQL migration issue found |

## Prior finding verification

1. **Paused mirror/source loss — fixed.** `enqueue-workspace-write-commit.ts:128-135,366-379` validates then preserves mirror/files/deletes. Invalid managed content does not enter fallback.
2. **Extraction durable identity — fixed.** completed binding-scoped `knowledgePaths` are loaded, checked against current Git, and persisted before terminal completion; same-name/collision/export-cleanup cases are represented in native contracts.
3. **Atomic provider/repository binding — fixed.** each provider reader returns the URL from its existing joined query; mirror checks no longer compose two committed snapshots.
4. **Shared migration-only naming — fixed.** knowledge projection helper and durable step names now describe common use.

## Semantic clean-rebase adversarial review

- Input binds `previousSha`, file bytes/modes, deletions, revision, and job ID.
- Acquisition fetches and packs both current and previous commits.
- Candidate tree is deterministically staged on `previousSha`; native `merge-tree --write-tree --merge-base=previousSha current candidate` applies disjoint changes.
- Diff is measured current-to-merged tree, so convergence returns no-op.
- Final `commitGitTree` uses the current acquired commit as the single parent. Broker/publish retain current revision CAS and binding rechecks; hydrate is enqueued before job completion.
- Overlap/model conflict behavior and automatic legacy-to-native handoff were deliberately excluded as declared unfinished scope.

## Evidence assessed

- Read the target native semantic contract covering same-file disjoint human/job edits, deletion, one descendant commit, parent identity, replay, and second-job no-op.
- Read target mirror and extraction identity contracts/log manifests and the status evidence summary (35 affected checks; full types with 141 pre-existing allowances).
- No independent execution; CI completion beyond the supplied status was not inferred.

## Declared open scope, not findings

Overlapping/model conflict resolution; automatic conflict handoff; explicit provider resource lifecycle; post-hydrate planner/caps/followups; complete protection/pause/resume; provider caller migration; alternate default writer and credential removal; generic runner deletion.
