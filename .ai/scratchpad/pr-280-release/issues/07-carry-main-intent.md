# Carry main's intent into Workspaces code

Status: in-progress
Priority: P0
Order: 1 (first)
Owner: claude
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

`main` was merged into the branch at `9fe4ba0c`. The 14 newest `main` commits were reconciled by intent; the ~46 earlier `main` PRs since the fork (Aug 13) came in as plain merges. The ledger is [main-intent-carry.md](../main-intent-carry.md). Ticket 08 (consolidated intent) follows this ticket and records any intent changes made here.

Open rows from the latest merge: job attribution on 26 raw `defineWorkflow` workflows (#364); connector asset blob-SHA skip (#298/#362); claim collapse + bind-cap batching (#368); incomplete SCIP shard vs publication rule (#371); verify `linkPackageHierarchy` claims pass the typed extract write.

## Goal

Every `main` change since the fork either holds in the code this branch rewrote, or is recorded `n/a` with a reason.

## Acceptance criteria

- [ ] Ledger has one row per `main` PR since `ba7c9f80` (fork point), each with intent, branch surface, and status `done` / `n/a` (reason).
- [ ] Each `done` row has a commit and proof (test or recorded check); no row is closed by assertion alone.
- [ ] Typecheck, test policy, CI lanes green after each batch.
- [ ] Decisions that change intent (e.g. SCIP incomplete-shard publication) are confirmed with the user and handed to ticket 08.

## Plan

1. **Complete the ledger** for the earlier PRs (list with `git log --first-parent ba7c9f80..origin/main`). For each: read the PR and its ADR, find the branch surfaces it should affect, record the gap.
2. **Fix in this order** (each a separate commit with proof):
   1. Job attribution: move the 26 workflows to `defineObservedWorkflow` without changing durable input identity (#364). Feeds tickets 04/05.
   2. Observability (#343, #358, ADR-038): workspace chat, model proxy, sandbox lifecycle, hydrate, and git-write spans/logs carry `DeploymentEnvironment` and attribution; workspace chat LLM traces reach Langfuse.
   3. Graph ontology v2 (#335, #342, #344, ADR-032/033): hydrate's graph projection emits v2 relation families and shared identity; connector extractors read the git mirrors in the workspace repository; PR mirror works with workspace repos.
   4. Committed memory into git and the graph (#351, ADR-037) in the Workspace model.
   5. PagerDuty connector (#328, ADR-034) on the typed native mirror workflow like the other connectors.
   6. MCP API keys and tenant isolation (#285, #316, #330, #336) against workspace-scoped MCP and RLS.
   7. Connector assets blob-SHA skip (#298/#362); #368 claim collapse/batching; #371 SCIP issue vs publication (decision with the user); `linkPackageHierarchy` write check.
   8. Remaining rows (codesearch capacity #305/#329/#334, Linear/Notion OAuth #339/#340, connector rebind #348, others).
3. **Close** when every row is `done` or `n/a`; update ticket 08's documents if any decision changed.

## Delegation brief

Read first: this ticket, the ledger, ticket 08's PRD and ADRs, root and app `AGENTS.md`, `.cursor/skills/observability/`, `.cursor/skills/source-connectors/`.

Work row by row; never batch unrelated fixes. Ask the user before changing intent. Report ledger progress and proof per row.

## Comments

- 2026-10-01 (user): this goes first (update from main), then 08, then the rest. Branch is level with `origin/main` (0 behind) at start.

- 2026-10-01 (user): approved; goes second, after 08. Plan expanded from the sketch.

## Resolution
