# Gate 3 G3-C milestone — Standards review

Pinned increment: `9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf..ce00e052b18bceda71909afde37443070b03f5a8`

## Documented-standard violations (1 blocker)

1. **Completed adopted no-op cannot be reconstructed from the durable job.** `apps/backend/src/openworkflow/workflows/workspace-bootstrap.ts:97-117` handles a completed unborn command by requiring `commitSha`, while the same workflow can adopt a human-initialized revision and then durably complete with `commitSha = null` through its normal no-op path (`:162-225,311-325`). A later execution whose native run history is unavailable therefore throws `Completed root bootstrap has no commit` instead of returning `{ committed: false, reason: "no_changes" }`. This breaks ADR-033's OpenWorkflow retry/replay ownership and its explicit rule that the same owner adopts the real first-writer revision and continues the normal bootstrap transform. The native first-writer case always initializes with only `README.md`, forcing a second commit, so it does not cover an already-bootstrapped human root or loss after the no-op completion. Treat `completed + null` as the durable no-op result, as `completedWorkspaceWrite` already does, and add that native replay case.

The remaining implementation follows the documented boundaries: `UnbornBootstrapBinding` avoids a fictional revision; Git objects and deterministic commit inputs cross durable steps; only the broker receives write credentials; the root push is non-force; actual default, generation, remote, connection, status, and first-writer state are rechecked outside short org SQL transactions; adoption clears only the exact unpublished candidate before normal bootstrap continues.

## Fowler heuristic backlog (9; non-blocking)

Per the milestone brief, the existing backlog was retained without re-investigation: **Mysterious Name (2)**, **Repeated Switches (1)**, and **Duplicated Code (6)**. No new heuristic is reported for this increment.

**Blockers: 1.** G3-D–G remain separately open and were not assessed as G3-C failures.
