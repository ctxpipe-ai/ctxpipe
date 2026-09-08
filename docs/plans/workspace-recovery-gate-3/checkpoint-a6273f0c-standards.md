# Gate 3 planner/admission checkpoint — Standards review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...a6273f0cec39f7fd28e9e0af20109dbf8e4432b2`  
**Decision:** pass for implemented scope — 0 documented-standard breaches, 0 Fowler heuristic findings.

## Documented standards

The prior blocker is corrected. `getWorkspaceWriteAdmission` derives revision, write status, and display name from one selected workspace row (`apps/backend/src/models/workspaces.ts:287-298`). Acquisition, both broker admission checks, and no-op validation consume that record (`write-command.ts:98-107`; `write-broker.ts:42-62,83-90,201-215`), satisfying ADR-033 lines 22-23’s same-row-version and immediate full-binding rules.

The new planner keeps pure remainder calculation in `hydrate-write-planner.ts:11-35`, then reserves all concerns inside one bounded `orgSql` transaction under the workspace-row lock (`workspace-write-planning.ts:12-114`). Binding, root lineage, per-kind latest attempt, three-attempt cap, shrinking remainder, deterministic job ID, and paused reservation are decided before any enqueue/provider/Git I/O. `persistBoundWriteJob` preserves the reservation’s `planning` metadata while claiming its workflow owner (`workspace-write-jobs.ts:631-663`). This conforms to backend `AGENTS.md:11`, ADR-027, and ADR-033 line 21.

Hydration records the original planning decision and raw committed files as native steps, reserves only after successful activation, and admits typed workflows outside SQL (`workspace-hydrate.ts:133-199,239-271,312`). Captured-SHA acquisition retains the full current binding/write-status fence while allowing a later tip (`write-command.ts:98-133`). The repository permission probe uses a repository-scoped read token and app-authenticated installation metadata; it does not mint a write credential (`github-installation.ts:801-831`; `github-workspace-tip.ts:65-119`).

## Heuristics and evidence

No Fowler smell rises to a finding. The named `WorkspaceWritePlanning` clump and separate pure planner/model reservation modules keep the new policy cohesive. Recorded native PostgreSQL/Git/OpenWorkflow, process-loss, hydration, type, and prior CI evidence was inspected, not rerun. Tool-enforced issues and explicitly unfinished Gate 3 work were excluded; this is not terminal gate acceptance.
