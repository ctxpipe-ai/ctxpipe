# Gate 3 semantic handoff Spec coverage ledger

## Pin and sources

- Read only `6b5122c56dbd838e6e8b7395455f939acf1eb775`, fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; enumerated the eleven-commit log, full base diff, and delta from `bafb805b`.
- Applied recovery Gate 3 (`workspace-chat-recovery.md:642-659`), locked write protocol ticket 10 (especially lines 47-54, 68-82, 96-110, 148-152), provider topology, ADR-033, target status, root/backend instructions, and prior pinned reports.
- Source review only; no repository mutations or test suites.

## Changed interfaces and callers

| Surface | Pinned blobs/callers traced | Assessment |
|---|---|---|
| Broker classification | `write-broker.ts`: `WorkspaceTipAdvancedError`, `attemptWorkspaceCommit`, remote ancestry, binding checks | Only broker-observed pre-push tip advances become handoffs; other failures propagate. The acknowledged final CAS window remains open |
| Handoff capture | `captureSemanticHandoff`, `readGitCommitChanges`, file schema/bytes | Captures exact parent-to-candidate delta with base64 bytes and deletions, original SHA, refreshed binding, deterministic child ID, optional mirror source |
| Eleven parent callers | bootstrap, claims, mirror, extract, UI edit, import cleanup, link/unlink, migration export, folder map, rename, valid-from workflows | All invoke the same attempt/capture/child sequence. Export has required special no-op cutover/hydrate path. Parent/child duplicate terminal ownership reported |
| Semantic child | content/input schemas, command reconciliation, acquisition, native merge/model resolution, push/publication/hydrate | Child is a separately persisted typed job and owns actual push/hydrate; mirror binding is checked on acquisition and broker path |
| Parent result persistence | `persistWriteJobCommitSha`, `persistMigrationExportNoOp`, completed replay | Generic parents overwrite candidate SHA with child result and become completed; this conflicts with locked mirror failure semantics and unique durable-result exit |
| Git merge correctness | `merge-tree.ts`, `write-tree.ts`, semantic validate/no-op path | Conflict paths are unioned with clean diff; final diff is validated, and legitimate unchanged resolution skips commit |
| Provider selection | `discoverSandboxProvider`, Dockerode declaration/dependency, semantic resource factory | Unset selection probes daemon with two-second bounds then uses local fallback; explicit Docker remains fail-closed. Railway/sbx are declared open |
| Tests/evidence | Files/mirror/export/merge native contracts, target status and log manifests | Read supplied 58-check/type evidence; did not rerun. Prior `bafb805b` CI accepted as supplied all-13 success |

## Invariant trace

- **Immutable command:** parent candidate and child command are durable; child files derive from the candidate commit rather than recomputing the transform.
- **At most one published commit:** the parent candidate remains unreachable; only the semantic child publishes one current-tip-parent commit.
- **Mirror ownership:** mirror source survives schema, handoff, child row, acquisition, model path boundary and broker recheck.
- **No-op:** semantic final validation can return an empty diff. Export then refreshes, enqueues hydrate, atomically clears the matching unpublished SHA, and records `exportTipSha`.
- **Replay:** parent and child workflow steps are durable and deterministic. The finding concerns two completed logical job results, not creation of a second Git commit.

## Prior finding verification

1. **Modify/delete and resolved no-op — fixed.** `mergeGitFiles` returns the union of native clean paths and conflict paths; `validateGitTree(..., {allowNoChanges:true})` returns final changed paths, and semantic workflow completes empty resolution without a commit.
2. **Forced Docker — fixed for Docker/local.** `discoverSandboxProvider` pings the actual Docker client only when unlocked and falls back to `unsandboxed`; an explicit lock remains authoritative.
3. **Immutable fallback and paused semantic validation — remain fixed.** No regression in this delta.

## Explicit exclusions

Known historical path-map fold P2; Railway/sbx support; the Git race after final broker admission; a second tip advance during semantic execution; cancellation/abandoned resource cleanup; broader worker/replica recovery; remaining semantic no-op cases; post-hydrate planning and caps; complete pause/protection handling; provider caller and alternate credential/writer migration; legacy deletion.
