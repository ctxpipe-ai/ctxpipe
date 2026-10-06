# Follow-ups from ticket 16 and the Workspace base merge

Status: needs-triage
Priority: P2
Owner: unassigned
Blocked by: none
Created: 2026-10-07
Updated: 2026-10-07

## Context

Two small gaps stayed open when ticket 16 and the Workspace base work merged into PR 280.

## Items

1. **A relink can log "Workspace write binding is unavailable".** In CI, the `void` bootstrap enqueue in `startRelinkedWorkspace` (workspace-lifecycle.ts) logged this error once (openworkflow/enqueue-workspace-write-commit.ts:165). The hypothesis: the hydrate or the tip check changes `desiredSha` first, so the compare-and-set in `persistWriteStatus` (models/workspaces.ts) fails. Nobody reproduced it. Ticket 16 made `github-reconnect-rebind.contract.test.ts` ignore this one error. Find out if the race is harmless. If it is, log it at a lower level; if it is not, fix it.
2. **One Vercel base test step no longer checks the base hold.** In `workspace-sandbox-base-vercel.integration.test.ts`, the conversation sandbox's deletion at 29 days now comes before the 30-day base hold, so the step expects 29 days. Add a case where the base hold is the earliest due time, so the hold value has its own assertion.
