# Gate 3 seven-kind checkpoint — Standards coverage

## Pinned identity

- Base and merge-base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Reviewed target: `398e5f186007e603fe878afc7ce7bbe9eddf3640`.
- Range commits: `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`, `398e5f18`.
- Inspection used the pinned three-dot diff, range log, and `git show TARGET:<path>`; current worktree content was excluded.

## Standards and evidence

Read root/backend `AGENTS.md`, `.agents/skills/code-review/SKILL.md`, TDD/mocking guidance, ADR-027/028/033, locked issues 02/03/10, accepted plan/status, and checkpoint logs. Considered the complete Fowler baseline. I did not rerun the 53-check or full type/policy suites; their supplied records were reviewed. A read-only YAML-library probe confirmed top-level sequence aliases are not `isSeq` nodes and deletion of a referenced anchor throws `Unresolved alias`.

## Changed-surface ledger

The range contains 282 paths: 29 backend implementation files, 16 backend tests/fixture/config paths, 232 plan/review/log artifacts, 3 CI policy/diagnostic files, and 2 ADR/index files.

Implementation blobs reviewed:

- Schema/models: `db/schema/workspaces.ts`, `models/github-installation.ts`, `models/workspace-write-jobs.ts`, `models/workspaces.ts`.
- Domain: `commit-subject.ts`, `folder-map.ts`, `hydrate-write-jobs.ts`, `hydrate.ts`, `knowledge-metadata.ts`, `link-declarations.ts`, `workspace-lifecycle.ts`, `write-broker.ts`, `write-command.ts`, `write-commit-files.ts`, `write-job-intent.ts`.
- Admission/execution: `openworkflow/client.ts`, `enqueue-workspace-write-commit.ts`, and all seven new workflows (`workspace-{bootstrap,file-edit,import-key-cleanup,claims-upgrade,valid-from-persist,ops-folder-map,link-unlink}.ts`).
- Git/model/route: `services/git/{clone-tree,pack,write-tree}.ts`, `retrieval/services/modelProvider.ts`, `routes/v1/workspaces.ts`.

Changed tests/config reviewed: `commit-subject.contract.test.ts`, `graph-workflow.contract.test.ts`, `hydrate-write-jobs.test.ts`, `hydrate.test.ts`, `workspace-lifecycle.test.ts`, four `write-*-native.contract.test.ts` files, deleted `write-workflow.contract.test.ts`, admission/discovery/Files/workspaces tests, `native-hydration-fixture.ts`, and `vitest.config.ts`. Serialization retains explicit in-file concurrent ownership/race assertions; no test-standard violation was reported.

Caller/dependency tracing included unchanged `routes/v1/workspace-linked-routes.ts`, `layout.ts`, `slug.ts`, `openworkflow/workflows/workspace-write-commit.ts`, worker config/discovery, hydrate/projector/model activation, paused-job reconstruction, lifecycle auto-link/rename entry points, write-job schema/persistence/reconciliation, Git pack/tree/broker publication, and linked-repository models.

## Focused disposition

- Verified fixes: encoded legal folder paths round-trip and converge; requested display name reaches Git and hydrate; predicate claims no longer suppress permanent body `LINKS_TO`; marker ambiguity fails; shared Git reader and explicit reconciliation name remain; SQL sections are short and contain no remote/model I/O; job mapping precedes push and completion follows publication plus hydrate enqueue.
- Seven workflows retain similar explicit step sequences because ADR-033 requires those durable boundaries; that duplication is overridden by the documented design. Other Fowler candidates were considered and not strong enough to report beyond the optional command bag.
- The five declared pending kinds, planner/caps, pause/resume, semantic rebase/conflicts, alternate writers, and legacy deletion were excluded as intermediate scope rather than reported as omissions.
