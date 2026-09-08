# Gate 3 eight-kind checkpoint — Standards coverage

## Pinned identity

- Base and merge-base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Reviewed target: `1ced719864bceed1640842de319313c45614a983`.
- Range commits: `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`, `398e5f18`, `1ced7198`.
- Every source read used the pinned three-dot diff or `git show TARGET:<path>`; concurrent worktree edits were excluded.

## Standards and evidence

Reviewed root/backend `AGENTS.md`, `.agents/skills/code-review/SKILL.md`, TDD/mocking guidance, ADR-027/028/033, locked recovery issues 02/03/10/12, accepted Gate 3 plan/status, and supplied evidence. The full Fowler baseline was applied. I did not rerun the reported 58 native checks, 143-baseline typecheck, proof policy, or pending CI 34214880526.

## Complete changed-surface ledger

The pinned range contains 365 paths: 34 backend implementation files, 17 backend test/fixture/config paths, 309 plan/review/log artifacts, 3 CI policy/diagnostic files, and 2 ADR/index files.

Implementation blobs reviewed:

- Schema/models: `db/schema/workspaces.ts`; `models/{github-installation,workspace-write-jobs,workspaces}.ts`.
- Domain: `commit-subject.ts`, `folder-map.ts`, `hydrate-write-jobs.ts`, `hydrate.ts`, `knowledge-metadata.ts`, `layout.ts`, `link-declarations.ts`, `linked-repository-url.ts`, `slug.ts`, `workspace-lifecycle.ts`, `write-broker.ts`, `write-command.ts`, `write-commit-files.ts`, `write-job-intent.ts`.
- Admission/workflows: `openworkflow/client.ts`, `enqueue-workspace-write-commit.ts`, and eight native workflows: bootstrap, file edit, import-key cleanup, claims upgrade, valid-from persistence, ops folder map, link/unlink, migration export.
- Other changed runtime surfaces: `retrieval/services/modelProvider.ts`, `routes/v1/{workspace-linked-routes,workspaces}.ts`, `services/git/{clone-tree,pack,write-tree}.ts`.

Changed tests/config reviewed: commit-subject, graph, hydrate-write-jobs, hydrate, lifecycle, export/link/maintenance/ops/write native contracts, deleted generic write contract, enqueue/discovery/Files/workspaces tests, native hydration fixture, and backend Vitest serialization config.

## Interface and caller tracing

- Migration export: creation and retry HTTP/lifecycle entry points; tip-check scheduler; admission map and legacy fallback; native workflow; `loadMigrationExportSource`; `planMigrationExport`/collision model/declaration generation; write-job ownership, prepared/no-op/public export readers; hydrate and public cutover serializers; worker discovery.
- Link identity: HTTP create/delete, lifecycle auto-link, admission and paused intent, native and legacy workflows, declaration parser/transform, URL normalization/keying, hydrate deduplication, linked-repository models/index callers.
- Metadata/folder/graph: YAML node helpers and all three maintenance transforms, folder-map recognition/emission, hydrate parsing and graph projection, rename path, and their native proofs.
- Shared protocol: immutable command checks, short org SQL boundaries, Git pack/stage/mode/tree validation, broker credential acquisition, lost-ack publication, hydrate enqueue, terminal reconciliation, model deadlines, and test-worker race coverage.

## Disposition

Verified the four prior unique blockers are corrected: credential-bearing/non-checkoutable URLs are rejected and canonicalized at HTTP/admission/workflow/parser boundaries; GitHub case and SSH trailing-slash identities converge; ambiguous folder instructions are preserved; root claims aliases, removed anchors, BOM/CRLF/chomping, and body bytes have focused native evidence. SQL scopes remain short and exclude Git/model/provider I/O; commit mapping precedes push and public completion follows publication/hydrate enqueue.

Repeated workflow steps are required by ADR-033’s explicit durable boundaries. The optional command property bag remains a Fowler Primitive Obsession/Data Clumps/Shotgun Surgery judgment call already acknowledged for generic-layer deletion. No other smell crossed the reporting threshold. The four pending kinds, planner/caps, pause/resume, conflicts, alternate writers, and legacy deletion were excluded as declared intermediate scope.
