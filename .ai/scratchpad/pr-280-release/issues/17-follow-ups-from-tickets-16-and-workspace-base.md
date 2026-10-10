# Follow-ups from ticket 16 and the Workspace base merge

Status: needs-triage
Priority: P2
Owner: unassigned
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
