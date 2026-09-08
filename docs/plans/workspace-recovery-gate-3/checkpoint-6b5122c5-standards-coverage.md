# Gate 3 semantic handoff checkpoint — Standards coverage ledger

## Identity and method

- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Target: `6b5122c56dbd838e6e8b7395455f939acf1eb775`
- Confirmed target and merge base; enumerated ten commits; reviewed `git diff BASE...TARGET`, `git log BASE..TARGET`, `git show TARGET:path`, `git grep`, and `git ls-tree`. Product code was read only from the target object database, never from the changing worktree.
- Cumulative changed manifest: 637 paths — 56 backend production TypeScript files, 22 backend test TypeScript files, 543 Gate 3 plan/evidence files, and 16 ADR/index/package/lock/patch/prior-gate/config files. Increment from `bafb805b`: 71 paths, including 19 production TypeScript files plus three native contract files.
- Standards read: root and backend `AGENTS.md`; code-review skill and complete Fowler baseline; TDD skill and `mocking.md`; ADR-027, ADR-028 and ADR-033; accepted recovery plan and target status. Tool-enforced formatting was excluded.

## Changed production surface reviewed

- Broker/Git: private advanced-tip signal; `attemptWorkspaceCommit`; `captureSemanticHandoff`; exact commit-delta extraction; base64 bytes/deletions; `validateGitTree` no-change return; merge conflict path allowlist; remote/binding refresh.
- Eleven mechanical workflows: bootstrap, claims upgrade, connector mirror, extract ingest, UI file edit, import-key cleanup, link/unlink, migration export, ops folder map, rename rewrite and valid-from persistence. Each now attempts the broker, captures one child command on an advanced tip, runs the semantic child and persists the child's commit/no-op result.
- Semantic child: mirror-bearing schema, immutable claim, bounded reacquisition, native three-way merge, modify/delete resolutions, allowed empty resolved tree, publication/hydration and terminal persistence.
- Export exception: semantic no-op refresh, durable hydrate, atomic candidate clearing/cutover SHA and parent completion.
- Provider/package: bounded Dockerode ping, Docker/local selection, provider resource construction/destruction, direct pinned dependency and local declaration.
- Tests/status/evidence: real PostgreSQL/Git/OpenWorkflow handoff, mirror binding reset and terminal retry, binary preservation, modify/delete matrix, Docker absence/explicit lock, export no-op cutover, replay, logs and checkpoint narrative.

## Interface and caller tracing

- `attemptWorkspaceCommit` and `captureSemanticHandoff`: all and only the eleven mechanical workflows call both. All branches use named durable steps and return after one child; the migration-export parent has its required metadata-specific completion branch.
- `WorkspaceTipAdvancedError`: private to `write-broker.ts`; both pre-credential and post-credential tip checks throw it; unrelated binding/credential/Git failures still fail normally. The actual push-time CAS race is explicitly pending.
- `readGitCommitChanges`: sole caller is `captureSemanticHandoff`. It diffs the prepared commit against the original revision with NUL-delimited native Git, separates deletes, and transports surviving blobs as canonical base64. `mergeGitFiles` reconstructs the candidate on the original parent, retaining ordinary Git modes and clean binary changes.
- `refreshWorkspaceWriteRevision`: traced from ordinary no-op checks, handoff capture and migration-export child no-op. It refreshes/persists desired identity but does not enqueue hydration; this trace produced finding 1.
- `validateGitTree(options.allowNoChanges)`: all mechanical callers retain the nonempty invariant; only semantic merge opts into empty output and consumes the returned changed-path list.
- `persistMigrationExportNoOp(jobId, sha, unpublishedCommitSha?)`: only migration export calls it, for initial and child no-op. The conditional update clears only the matching unpublished candidate and retains path metadata.
- `discoverSandboxProvider`: sole caller is `createMergeSandbox`; its probe has two-second request/connect deadlines. `createMergeSandbox` is called by the semantic workflow's durable allocation step. Selection and allocation are not separated, producing finding 2.
- `connectorMirrorContentSchema`: callers are admission, connector workflow input, and semantic child refinement. The connector workflow imports `workspaceSemanticMerge`, completing the cycle described in the heuristic finding.
- `mergeGitFiles`/`resolveGitMergeTree`: sole production caller remains semantic merge. Conflict paths join validation even when the provisional tree equals current; final empty trees become no-op; changed paths drive the commit subject.
- Parent/child completion: committed children enqueue canonical hydration before completing and parents persist their exact SHA. Migration-export no-op also hydrates; direct and other handed-off no-ops do not, producing finding 1.

## Standards and smell audit

- Checked explicit typed OpenWorkflow steps, immutable durable inputs, native Git object ownership, at-most-one/current-tip commits, broker-only write credentials, binding checks, publication/hydration ordering, short org SQL, connector managed-path fencing, resource replay, public-seam proof and package/runtime consistency.
- Fowler baseline considered in full: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man and Refused Bequest. The per-kind handoff repetition is suppressed because ADR-033 requires visible explicit workflow steps rather than another runner. The workflow import cycle remains one labelled judgement call.
- No multi-table transaction breach was found. The export completion is one fenced row update; Git/provider/model I/O remains outside org transactions.

## Evidence and exclusions

- Inspected the supplied 58 native checks across nine suites and full backend type result with 141 acknowledged existing diagnostics; no heavyweight suite was rerun. Prior `bafb805b` CI all-13 success was treated as evidence for that exact predecessor only.
- Explicitly excluded from surprise-omission findings: Railway/sbx support, actual late push CAS and repeated semantic races, cancellation/restart and abandoned-resource cleanup, planner/caps/followups, pause/protection completion, provider caller migration, alternate writers/default credentials, generic runner deletion, and terminal Gate 3 acceptance.
- Did not repeat the previously reported unbounded historical path-map fold; it is acknowledged as the next local slice.
