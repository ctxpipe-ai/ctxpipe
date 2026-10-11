# CTX-529: Hydrate keeps every markdown body in one workflow step output

Status: done
Owner: implementation sub-agent
Updated: 2026-10-12

## Cause

The `read-planning-revision` step of `workspace-hydrate` returned the full result of `listMarkdownFilesAtGitSha`: each markdown path, its body, and its introducing commit. OpenWorkflow 0.10.1 keeps a step output in one `jsonb` value (hard limit 255 MiB) and loads the outputs of all step attempts on each replay. Thus the output grew with the repository. A 300-file test repository of 3 MB gave a 3 MB step output.

The other hydrate steps return small values (flags, a write plan, connection ids, the sources diff). The run result keeps `diagnostics`, which is one entry for each skipped file.

## Fix

`apps/backend/src/openworkflow/workflows/workspace-hydrate.ts` reads the tree in the workflow body, not in a step. The tree at a fixed SHA does not change, so a replay reads the same files again.

Review follow-up:
- A step failure reschedules the run, and the body runs again. Thus the read is lazy: it occurs only when `plan-remaining-writes` or the projection (`pending.postgres`) needs the files. A replay after both does not fetch.
- A failed read in the body ended the run, because the workflow had no retry policy. The workflow now has the step default policy (1 s, factor 2, at most 100 s, 10 attempts).
- OpenWorkflow 0.10.1 has no non-retryable error. A run with input that cannot parse fails at once, through a `reject-input` step with `maximumAttempts: 1`.
- The comment on the `cat-file` buffer limit in `services/git/clone-tree.ts` no longer refers to the step output.

## Tests

- `apps/backend/src/domain/workspaces/hydrate-step-output.contract.test.ts`: hydrates a generated repository of 300 files (more than 2 MB of markdown). It checks that the published units equal the committed files, and that no step output is larger than 100 KB. It failed before the fix (`read-planning-revision`: 3,013,691 bytes) and passes after it.
- With the fix, `hydration.contract.test.ts`, `hydrate-planner-native.contract.test.ts`, and `src/domain/workspace-sources/` pass (19 files, 87 tests) on a database migrated to this branch.
- OpenWorkflow runs `step.run` inline. The workflow body runs again only after a sleep, a crash, or a retry. Hydrate does not sleep, so a normal run reads git one time.

- Same file: a git fetch that fails one time, then succeeds, completes the run (two full-history fetches). A write admission that Postgres refuses one time (a test trigger) retries `admit-*`, and the run does only one full-history fetch.
- After the follow-up: the same suites pass (19 files, 89 tests). `pnpm test:policy` and biome pass.

## Open risks

- A replay before activation or before the write plan reads git again, including the introducing-commit walk.
- Each deterministic error in the body now retries up to 10 times (about 9 minutes). Each attempt writes the hydrate failure again.
- A run that retries after activation returns the `noop` result, not `hydrated: true`. This was so before this change.
- A run in flight at deploy has an old `read-planning-revision` output. The new code does not call that step name, so OpenWorkflow does not use the old output.
