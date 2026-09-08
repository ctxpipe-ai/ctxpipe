# Gate 3 race/cleanup checkpoint — Standards coverage ledger

## Identity and method

- Base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; target `6d80ac1729e5e6628de6b13a20bb0b5e2c44eb17`; merge base and object identities were pinned before review.
- Enumerated 12 commits with `git log BASE..TARGET`; inspected the 744-path cumulative diff with `git diff BASE...TARGET`, `git show TARGET:path`, pinned `git grep`, and `git ls-tree`. Product code was never read from moving HEAD/worktree.
- Changed manifest: 59 backend production TypeScript paths, 22 backend test TypeScript paths, 649 docs/evidence paths, and 14 migration/ADR/package/patch/config/diagnostic paths.
- Standards read: root and backend `AGENTS.md`; code-review skill and all twelve Fowler heuristics; TDD skill and `mocking.md`; ADR-027 and ADR-033; accepted recovery status/plan. Formatting, lint, and type items were excluded as tooling-enforced.

## Incremental production surface reviewed

- **Native push recovery:** `write-broker.ts` reordered writable admission behind native exact/later-tip ancestry recovery and exposes `attemptWorkspaceCommit`. Its callers were traced across all twelve typed write workflows. `remoteContainsCommit` restores the durable pack, fetches the canonical tip, and uses native `merge-base --is-ancestor`; the published lost-ACK path returns before requesting a write token. The pre-push and post-credential binding/status reads were traced through `models/workspaces.ts` and produced the retained atomicity breach.
- **Repeated semantic CAS:** `workspace-semantic-merge.ts:141-329` bounds revision refresh/merge/push at three attempts. `persistWriteJobPreparedCommit`, `discardWriteJobPreparedCommit`, and `validateSemanticHandoff` were traced through their only production callers. The discard update is tenant-scoped through `orgSql`, requires `running`, and clears only the exact candidate (or accepts an identical already-cleared replay); completed rows cannot be rewritten.
- **Provider lifecycle:** `semantic-merge.ts` now validates a durable `{provider,id,expiresAt}` locator, applies one two-minute deadline to resume/create and the structured model invocation, refuses allocation after expiry, and truthfully checks Docker deletion by ping plus native 404. The pinned Docker-provider patch was reviewed for stable `containerName`, signal forwarding through inspect/pull/create/start/resume, abort checks, and failed-create cleanup. No credential enters this module.
- **Independent cleanup:** `workspace-semantic-merge.ts:190-240` durably plans the locator, enqueues `workspace-semantic-cleanup` with a stable idempotency key before allocation, then creates/resolves/destroys. The cleanup workflow waits until expiry, destroys, waits the native 30-second allocation window, and confirms destruction. Discovery and cancellation/replacement-worker tests were inspected.
- **Projection backfill/migration:** `backfill-knowledge-path-state.ts:4-40` remains one owner SQL statement. It joins the immutable owning workflow identity and orders each key by completed native `finished_at`, falling back to job `created_at`, then job ID; it preserves an existing projection. `db/migrate.ts:34-38` applies application schema, OpenWorkflow schema, then the backfill before later startup migrations.
- **Type ownership:** `WorkspaceSemanticHandoff` is defined once in `write-job-intent.ts` and reused by the Drizzle JSON payload type. Type-only schema import introduces no runtime cycle.

## Interface and caller coverage

- `attemptWorkspaceCommit`: all twelve native workflows. Semantic merge consumes `{pushed:false}` by exact candidate discard, revision refresh, and bounded retry; the eleven mechanical workflows capture an immutable semantic handoff.
- `discardWriteJobPreparedCommit`: sole caller `workspace-semantic-merge`; query and replay predicates reviewed.
- `mergeSandboxSchema`/`MergeSandbox`: semantic planner, allocator/resolver/destroyer, semantic workflow, and cleanup workflow.
- `workspaceSemanticCleanup`: sole production enqueue is the semantic workflow; CLI discovery and direct native replacement-worker coverage inspected.
- `backfillKnowledgePathState`: sole production caller is `db/migrate.ts`; native completion-order proof and application fresh/upgrade migration evidence inspected.
- `WorkspaceSemanticHandoff`: payload contract and Drizzle schema consumers; persistence/validation use the shared payload type transitively.

## Tests and evidence inspected

- Real bare-Git update-hook races cover first, repeated, and continuous CAS; completion/reconciliation and one-job ownership assertions were inspected.
- Lost-push-ack coverage spans exact/later tips and writable/read-only states, asserting persisted read-only state and one write credential.
- Native Docker abort, provider-outage deletion, delayed-model deadline, expired-locator rejection, cleanup ordering, cancellation, and replacement-worker proofs were inspected.
- Recorded checkpoint evidence reports 52 passing affected checks across six suites, exactly 141 acknowledged backend diagnostics, fresh/upgrade application migrations, frozen offline install, scoped policy/Biome, and predecessor CI. No heavyweight suite was rerun.

## Standards and smell audit

- Retained one ADR-033 full-binding breach at the broker’s split pre-push reads. ADR-027 short SQL and backend multi-table transaction rules otherwise hold: no Git/provider/model I/O occurs inside an org SQL transaction.
- Considered Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, and Refused Bequest. No heuristic finding retained. The previous duplicated handoff shape is fixed; explicit typed workflow repetition is required by ADR-033 and suppressed.

## Declared exclusions

Actual process-kill/filesystem-loss and independent-process replica proof, Railway/sbx providers, post-hydrate planner/caps, full pause/protection/resume, alternate-writer migration, credential cleanup, generic/legacy deletion, and terminal Gate 3 acceptance were treated as declared unfinished scope rather than omissions.
