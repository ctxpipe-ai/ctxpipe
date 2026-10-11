# CTX-529: Hydrate keeps every markdown body in one workflow step output

Status: done
Owner: implementation sub-agent
Updated: 2026-10-12

## Cause

The `read-planning-revision` step of `workspace-hydrate` returned the full result of `listMarkdownFilesAtGitSha`: each markdown path, its body, and its introducing commit. OpenWorkflow 0.10.1 keeps a step output in one `jsonb` value (hard limit 255 MiB) and loads the outputs of all step attempts on each replay. Thus the output grew with the repository. A 300-file test repository of 3 MB gave a 3 MB step output.

The other hydrate steps return small values (flags, a write plan, connection ids, the sources diff). The run result keeps `diagnostics`, which is one entry for each skipped file.

## Fix

`apps/backend/src/openworkflow/workflows/workspace-hydrate.ts` reads the tree in the workflow body, not in a step. The tree at a fixed SHA does not change, so a replay reads the same files again. The cost is one more git read for each replay of a run.

## Tests

- `apps/backend/src/domain/workspaces/hydrate-step-output.contract.test.ts`: hydrates a generated repository of 300 files (more than 2 MB of markdown). It checks that the published units equal the committed files, and that no step output is larger than 100 KB. It failed before the fix (`read-planning-revision`: 3,013,691 bytes) and passes after it.
- With the fix, `hydration.contract.test.ts`, `hydrate-planner-native.contract.test.ts`, and `src/domain/workspace-sources/` pass (19 files, 87 tests) on a database migrated to this branch.
- OpenWorkflow runs `step.run` inline. The workflow body runs again only after a sleep, a crash, or a retry. Hydrate does not sleep, so a normal run reads git one time.

## Open risks

- A replay after a crash or a retry now reads git again, including the introducing-commit walk.
- A run in flight at deploy has an old `read-planning-revision` output. The new code does not call that step name, so OpenWorkflow does not use the old output.
