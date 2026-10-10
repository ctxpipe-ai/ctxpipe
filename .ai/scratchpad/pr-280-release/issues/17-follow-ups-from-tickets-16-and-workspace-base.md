# Follow-ups from ticket 16 and the Workspace base merge

Status: done
Priority: P2
Owner: claude
Blocked by: none
Created: 2026-10-07
Updated: 2026-10-10

## Context

Two small gaps stayed open when ticket 16 and the Workspace base work merged into PR 280.

## Items

1. **A relink can log "Workspace write binding is unavailable".** In CI, the `void` bootstrap enqueue in `startRelinkedWorkspace` (workspace-lifecycle.ts) logged this error once (openworkflow/enqueue-workspace-write-commit.ts:165). The hypothesis: the hydrate or the tip check changes `desiredSha` first, so the compare-and-set in `persistWriteStatus` (models/workspaces.ts) fails. Nobody reproduced it. Ticket 16 made `github-reconnect-rebind.contract.test.ts` ignore this one error. Find out if the race is harmless. If it is, log it at a lower level; if it is not, fix it.
2. **One Vercel base test step no longer checks the base hold.** In `workspace-sandbox-base-vercel.integration.test.ts`, the conversation sandbox's deletion at 29 days now comes before the 30-day base hold, so the step expects 29 days. Add a case where the base hold is the earliest due time, so the hold value has its own assertion.
3. **Open runs in the shared "default" workflow namespace slow down other contract tests.** OpenWorkflow 0.10.1 workers claim every open run in their namespace, whatever its workflow name. Contract files leave runs open in "default" (for example sweeps, Workspace base builds and orchestrators). A test worker with concurrency 1 must work through them first, so a short poll can time out. Two owner tests now use a private namespace (`withPrivateNamespace`). "rejects extraction superseded during write credential issuance" cannot move, because it enqueues through the module-level `ow` client. Give each native contract file its own namespace, or end the runs a file starts.
4. **Codesearch directory reads can race with a checkout change.** The directory list in `routes/repo.ts` and the glob walk in `globFiles.ts` check the real path, then call `readdir`. If a path component becomes a symlink between the two calls, the list can show names (not content) from the symlink target. File reads are safe on Linux because of the descriptor check. main has the same race. Optional fix: open the directory with `O_DIRECTORY | O_NOFOLLOW` and check the descriptor path, as `readContainedFile` does.
5. **GET /files on a directory lists a child named `.git`.** The list shows only the name, not the content, and main does the same. Decide if the list must also leave out `.git`, to agree with the "never .git" rule of #413.
6. **Two codesearch route tests mock more than two repo modules.** `routes/repo.test.ts` mocks four modules and `routes/graph.test.ts` mocks three. The testing rule in the root AGENTS.md permits two. Move these route tests to a seam with a real checkout on disk, as the structural search route test now does.

## Triage

1. **Real; fixed.** A test reproduces the race: the tip moves during the bootstrap's write probe, the compare-and-set in `persistWriteStatus` fails, and the bootstrap is not admitted. Nothing admits it again later, so a relinked Workspace can miss its bootstrap files. This is not harmless. `probedWriteStatus` now stores the probe result again on the new row while the generation, the URL and the connection stay the same (at most three tries). The bootstrap binds to the tip of that row. The rebind contract no longer ignores the error.
2. **Real gap; fixed with a direct check.** The conversation sandbox that holds a base always deletes one day before the hold ends, so the hold can never be the earliest due time of a sweep. A sweep case for that does not exist. The test now checks the `workspaceBaseHeldUntil` value itself.
3. **Real; fixed by ending runs.** A per-file namespace needs edits in about 40 test sites and child scripts that connect to the library default namespace. A backend test setup file instead cancels, when each file ends, the open runs that the file created in "default". This also covers the test that enqueues through the module-level `ow` client. Cost: about 13 ms for each test file. The two private-namespace tests stay, because runs from earlier tests of the same file stay open until the file ends.
4. **Real; fixed.** `readContainedDirectory` opens a directory with `O_DIRECTORY | O_NOFOLLOW`. On Linux it checks the descriptor path and reads the list through the descriptor. `GET /files` and the glob walk use it. Checked on Linux with Bun in a container.
5. **Fixed.** Directory lists leave out a `.git` entry, in any letter case.
6. **Fixed.** `routes/repo.test.ts` and `routes/graph.test.ts` set the cache paths through the environment and use a real checkout, a real git remote and the real purge. Each mocks only the repository service, because codesearch tests have no database. `routes/graph.test.ts` also gives the route a stub `db` object for the graph query.

## Resolution

Commits on branch `t17-follow-ups` (base f6fa4c48):

- 8817e770: items 4, 5 and 6 (codesearch).
- 3d399502: item 2.
- e85e2ab8, 2ceac4d6, 1c8adbb3: the per-file namespace attempt and its revert.
- 06d65c28: item 3.
- c7012708: item 1.

Proof (own database, `ctxpipe_app` role):

- Item 1: the new race test fails before the fix ("Workspace write binding is unavailable") and passes after it. The rebind contract passes 5 of 5 runs. The write workflow, write pause, unborn bootstrap and write ops contracts pass 35 of 35 tests.
- Item 3: the owner contract passes 5 of 5 runs. After the base, sandbox lifecycle and write workflow contracts, no open run stays in "default".
- Items 4 to 6: `pnpm --filter @ctxpipe/codesearch test:vitest` passes 349 of 349 tests. One file, `warmup.integration`, cannot load on this machine because Zoekt is not installed.
- `pnpm lint` and `pnpm test:policy` pass.

Open risk: the CI time of the cleanup is estimated (about 13 ms for each file), not measured in CI.

