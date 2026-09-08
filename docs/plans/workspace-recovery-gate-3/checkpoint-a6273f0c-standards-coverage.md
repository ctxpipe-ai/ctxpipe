# Gate 3 planner/admission checkpoint — Standards coverage ledger

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; target `a6273f0cec39f7fd28e9e0af20109dbf8e4432b2`; merge base equals the fixed base. Fourteen commits were enumerated.
- Review used pinned `git diff BASE...TARGET`, `git diff 6d80ac17...TARGET`, `git log`, `git show TARGET:path`, and pinned `git grep`; moving HEAD, tracked edits, and untracked files were not used.
- Cumulative manifest: 809 paths — 63 backend production TypeScript, 24 backend test TypeScript, 708 docs/evidence, and 14 migration/ADR/package/patch/config/diagnostic paths. Increment from the prior checkpoint: 75 paths.
- Standards sources: root/backend `AGENTS.md`; code-review skill and all twelve Fowler heuristics; TDD skill and `mocking.md`; ADR-027/028/033; accepted recovery plan and target status. Tool-enforced formatting/types were excluded.

## Incremental production surfaces

- **Atomic write admission:** reviewed `getWorkspaceWriteAdmission` construction from one `getWorkspaceById` row and all production consumers. `write-command.ts` uses it for immutable captured-SHA acquisition; `write-broker.ts` uses it before read recovery, after credential issuance immediately before push, and after refreshed no-op resolution. The earlier split revision/status calls are removed.
- **Hydration planning:** reviewed the durable `capture-planning-target`, `read-planning-revision`, `plan-remaining-writes`, `reserve-remaining-writes`, and per-kind `admit-*` steps in `workspace-hydrate.ts`. Fresh derived-store state remains outside the durable planning flag; cached committed files support replay without another Git read.
- **Pure plan:** `planHydrateWrites` accepts immutable revision/display name/files, rejects non-GitHub repositories, parses committed knowledge, and independently computes bootstrap, claims, valid-from, and folder-map remainders. Its sole production caller is the hydration workflow.
- **Reservation model:** `reserveHydrateWrites` is called only by hydration. It locks the workspace, verifies generation/URL/connection/default/SHA, derives a root from the exact publishing job, finds the latest attempt independently per kind, reuses queued/paused same-tip reservations, requires completed/shrinking prior work, caps at three, and inserts deterministic paused rows. All SQL occurs inside one `orgSql`; enqueue runs after commit.
- **Metadata ownership:** `WorkspaceWritePlanning` is defined once in `write-job-intent.ts` and reused by the Drizzle payload type. `persistBoundWriteJob` copies existing planning metadata into the claimed payload; semantic handoff and ordinary payload spreads retain it. No physical schema migration was needed.
- **Repository probing:** reviewed `getRepoReadOctokit` and `getGithubAppInstallationPermissions` plus sole caller `getGithubRepoWriteView`. Repository discovery uses the existing repository-scoped read credential; installation permission fallback uses GitHub App authentication. Only `getRepoWriteCloneToken`, still called by the broker, requests contents-write.
- **Webhook tip helper:** branch/default/tip resolution now shares `resolveRepositoryReadTip`; error-to-null behavior and the explicit no-open-SQL assertion remain.

## Interface/caller trace

- `getWorkspaceWriteAdmission`: four production call sites — acquisition; broker initial/final admission; broker no-op validation.
- `planHydrateWrites` and `reserveHydrateWrites`: each has one production caller, `workspaceHydrate`; plan data crosses a durable step before reservation.
- `WorkspaceWritePlanning`: Drizzle payload declaration, reservation creation/read, and write-owner preservation.
- `getRepoReadOctokit` / `getGithubAppInstallationPermissions`: sole production consumer is `getGithubRepoWriteView`; downstream callers continue through write-status probing.
- `persistBoundWriteJob`: all twelve native writers were rechecked for planner metadata preservation and existing one-job/one-owner behavior.
- Captured-SHA acquisition: all twelve typed workflows continue through `acquireWorkspaceWriteRevision`; current binding fields and writable status remain mandatory while only SHA equality is relaxed.

## Proof/evidence inspected

- Planner native tests cover four distinct concern reservations, stable replay, two queued kinds executing after one advances default, capped and non-shrinking isolation by kind, and failed probe leaving durable paused rows.
- Worker-loss proof uses real PostgreSQL/OpenWorkflow and local bare Git, SIGKILLs the original process during staging, deletes its temporary checkout, and starts two independent Bun replacement processes; assertions cover one public commit/result, one write credential, and reconstructed stage execution.
- Atomic broker evidence covers relink/default change and exact/later-tip writable/read-only lost acknowledgements. Hydration replay evidence covers no-Git embedding retry, fresh planner work, and retained derived-store completion.
- Recorded evidence reports the final 38 targeted hydration/planner/core cases, the separate worker-loss proof, exactly 141 acknowledged backend diagnostics, scoped policy/Biome/whitespace checks, and all 13 successful prior-checkpoint CI jobs. No heavyweight suite was rerun.

## Standards/smells and exclusions

- Backend multi-table transaction and ADR-027 short-transaction rules hold: the reservation reads/inserts atomically and performs no network, Git, model, or workflow enqueue inside SQL.
- ADR-033 durable-data, per-kind concern/cap, immutable binding, broker-only write credential, and native retry ownership rules were checked. The prior split-snapshot finding is closed.
- Full Fowler baseline considered: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, and Refused Bequest. No finding retained. Legacy retry helpers are part of declared pending generic-runner deletion, so their temporary overlap was not reported as a new smell.
- Explicitly excluded as declared unfinished: remaining planner concerns, complete pause/protection/resume, remaining provider work, alternate-writer/default-credential migration, legacy/generic deletion, and terminal Gate 3 acceptance.
