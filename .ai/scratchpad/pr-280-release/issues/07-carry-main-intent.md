# Carry main's intent into Workspaces code

Status: needs-triage
Priority: P0
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

`main` was merged into the branch at `9fe4ba0c`. The 14 newest `main` commits were reconciled by intent; the earlier ~46 `main` PRs since the fork (Aug 13) came in as plain merges. The ledger is [main-intent-carry.md](../main-intent-carry.md).

Open rows from the latest merge: job attribution on 26 raw `defineWorkflow` workflows (#364); connector asset blob-SHA skip (#298/#362); claim collapse + bind-cap batching (#368); incomplete SCIP shard vs publication rule (#371); verify `linkPackageHierarchy` claims pass the typed extract write.

Earlier PRs still to audit, highest impact first: ClickStack + Langfuse observability (#343, #358, ADR-038), graph ontology v2 + connector extractors + PR mirror (#335, #342, #344, ADR-032/033), committed memory into git and the graph (#351, ADR-037), PagerDuty connector (#328, ADR-034), MCP API keys (#316, #330, #336), durable connector assets (#298, ADR-028), codesearch capacity/concurrency (#305, #329, #334, ADR-027), cross-tenant MCP fix (#285), Linear OAuth app creds / Notion self-host (#339, #340), connector sync on rebind (#348).

## Goal

Every `main` change since the fork either holds in the code this branch rewrote, or is recorded `n/a` with a reason.

## Plan (sketch — expand before review)

1. Extend the ledger with one row per earlier `main` PR: intent, branch surface, status.
2. Fix the open rows in priority order (attribution first: it feeds tickets 04/05), one commit per row with proof.
3. Close when every row is `done` or `n/a`.

## Comments

## Resolution
