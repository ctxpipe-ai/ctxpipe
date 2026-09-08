# Gate 3 planner/admission checkpoint — Spec coverage ledger

## Pin and standards

- Reviewed exact three-dot range `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...a6273f0cec39f7fd28e9e0af20109dbf8e4432b2`; enumerated all 14 commits and 75 changed paths. Every source read used `git show`/pinned `git diff`, never the moving worktree.
- Applied `.cursor/skills/code-review/SKILL.md` Spec axis plus pinned root/backend `AGENTS.md`.
- Read recovery plan Gate 3 (lines 642–659), ADR-033 (especially lines 11–23), and locked tickets 02/03/10/11/12/18. Ticket 10 lines 47, 54, 60, 64, 68–82, 96, 110, 119–132 were used as behavioral locks.

## Changed production surface and callers

- `hydrate-write-planner.ts`: traced bootstrap file diff, claims/valid-from/folder-map remainder computation, GitHub-only write policy, malformed/skipped hydration behavior.
- `workspace-write-planning.ts`: traced workspace row lock, exact binding predicates, publisher/root lineage, deterministic IDs, replay, queued/paused reuse, cap and non-shrinking stop predicates. Traced payload typing through `write-job-intent.ts` and `db/schema/workspaces.ts`.
- `workspace-hydrate.ts`: traced durable planning-needed/previous-SHA capture, immutable Git read, activation CAS, derived-store retry/no-Git paths, reservation and per-kind enqueue steps, no-op/index-lag branches, and failure persistence.
- `workspace-write-jobs.ts`: traced reserved row → typed queue → native workflow owner transition; planning metadata survives both admission and `persistBoundWriteJob` claim. Checked paused serialization/resume payload mapping and semantic-child ownership preservation.
- `write-command.ts`, `write-broker.ts`, `workspaces.ts`: traced old captured-SHA acquisition, current binding/write-status admission, remote-tip reconciliation, final credential-bound recheck, native non-FF behavior, no-op validation, lost-ACK ancestry, and all `getWorkspaceWriteAdmission` callers. Prior split-snapshot finding is structurally corrected.
- `enqueue-workspace-write-commit.ts`, `workspace-tip-check.ts`, `workspace-write-commit.ts`, `persistWriteStatus` callers: traced probe/read/update ordering and found the unfenced stale-probe write reported in the main review. Relink resets binding/status in `updateWorkspace`, but the later id/org-only probe update can overwrite it.
- `github-installation.ts`, `github-workspace-tip.ts`: traced explicit connection lookup, repository-scoped read token request, metadata GET, app-auth installation-permission fallback, and write-token boundary. No probe-side write token path found.

## Evidence inspection

- Inspected `write-worker-loss-native.contract.test.ts`: distinct detached Bun processes share only PostgreSQL/OpenWorkflow and the bare remote; the first is SIGKILLed during real Git staging, its temp checkout is removed, and two replacements recover after lease expiry. Assertions cover one remote commit/result, one write credential, one completed acquisition and two stage attempts.
- Inspected all five planner contracts and recorded logs: four distinct typed admissions, replay identity, two queued kinds surviving tip advance, three-attempt cap, non-shrinking isolation, and failed probe leaving paused rows. Inspected 38-case hydrate/planner/core final log and unchanged 141-diagnostic type baseline; no heavy suites rerun.
- The current evidence has no relink-during-probe persistence interleaving. Atomic broker tests exercise the downstream single-row read, not provenance of the status written into that row.

## Declared open scope (not findings)

Other planner concerns; full pause/protection/resume; alternate/default writers and connectors; Railway/sbx; generic runner/intent/registry deletion; Gates 4–6.
