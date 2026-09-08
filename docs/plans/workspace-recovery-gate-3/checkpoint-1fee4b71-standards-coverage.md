# Standards coverage — `1fee4b7142bd89ecd4e8280315c97dfb08fe665e`

## Identity and method

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target: `1fee4b7142bd89ecd4e8280315c97dfb08fe665e`; merge base confirmed and all 20 commits enumerated.
- New increment: `1fee4b71 Gate 3: fence paused owners and broker conversation publication`.
- Used only pinned `git diff`, `git log`, `git show TARGET:path`, `git grep TARGET`, and `git cat-file`. The moving checkout was ignored. No implementation or test execution.
- Applied root and backend `AGENTS.md`, ADR-027/033, accepted Gate 3 status/audit, TDD/mocking proof rules, and every supplied Fowler smell. Tool-enforced formatting was excluded.

## Changed surface reviewed

The increment changes 18 TypeScript files plus ADR/status/audit/checkpoint evidence:

- Production: `conversation-publish.ts`; `github-installation.ts`; `workspace-write-jobs.ts`; `workspaces.ts`; native admission; hydrate/export workflows; conversation push/PR routes; Files route.
- Proof/support: conversation broker native contract; conversation HTTP native contract; retained pure publish test; retired mocked PR cases; export/pause native contracts; Files contract; hydration fixture.
- Documentation/evidence: ADR-033, status, write-path audit, prior checkpoint reports, and committed red/green/type/proof logs.
- Cumulative deletion of `job-sandbox.live.test.ts` was cross-checked against standards references.

## Interface and caller ledger

### Conversation publisher and credentials

- `pushConversationSessionBranch` changed from agent-side tokenized push to backend capture/publish. Production callers are exactly:
  - `conversation-files-routes.ts:542` — direct push.
  - `conversations.ts:813` — create/reuse PR.
- It validates session/default names, commits/stages in the handle with empty env, captures a bounded pack and shallow boundary, obtains a repository-scoped read token, resolves actual default/session tips, obtains a repository-scoped write token, repeats current workspace/conversation validation, and pushes from a fresh native directory with an exact session-ref lease. Tokens travel through askpass env and errors are scrubbed. Default is not mutated.
- `getRepoWriteCloneToken` callers are exactly `write-broker.ts:104` and `conversation-publish.ts:178`; its GitHub request is repository-name scoped with `contents:write` plus `metadata:read`.
- `resolveRepositoryReadCredential` remains the read-token boundary and asserts no ambient org DB context.
- `getDesiredWorkspaceRevision(..., "publish-session")` is used by both HTTP callers. The reported blocker follows the data from sandbox handle/capture through these reads to the broker.
- Native domain proof covers success, DB rebind during credential issuance, actual-default change, session-ref advance, token absence from agent hooks, and exact write scope.
- Native Hono proof covers direct push, PR create/persistence, missing handle, and a stable stale-metadata PR case. It does not cover stale metadata on direct push or relink between route reads; this gap accompanies the blocker.
- Existing `conversations.test.ts` still mocks many route collaborators for unrelated route behavior, but its obsolete PR proof cases were deleted; broker/PR claims now have real local sandbox/Git/DB/HTTP coverage.

### Paused ownership and dispatch corrections

- `claimPausedWriteJob` now updates only paused jobs whose payload has no `workflowRunId` (`workspace-write-jobs.ts:213-227`).
- `reconcileWorkspaceWriteJob` covers queued/running/paused rows owned by matching failed/canceled native runs (`:563-592`). The native pause contract exercises the ownership/cancellation path.
- `snapshotWriteWorkflows` moved into `enqueueWriteJob` (`enqueue-workspace-write-commit.ts:162-174`), satisfying root `AGENTS.md`’s one-use-global rule.
- All production `claimPausedWriteJob` use is through `workspace-tip-check.ts`; no replacement owner is created.

### Export/hydration ordering

- Migration export completes/publishes, refreshes the canonical result, and admits `workspaceHydrate` with `access:"read"` (`workspace-migration-export.ts:273-287`). It no longer directly plans maintenance.
- Hydrate owns `enqueueRemainingWrites` (`workspace-hydrate.ts:171-247`) and invokes it only on no-op, index-lag, or post-activation paths (`:248-268,360`). It checks current-binding completed export before adding import-key cleanup and uses capped durable reservations plus typed admission.
- Export native proof covers pending hydration withholding cleanup, successful hydrate follow-up, replay, and read-access handoff.

### Files admission

- Files no longer rejects read-only/unknown before admission; valid writes reach typed admission and acknowledge only a durable enqueue. The contract covers writable/read-only/unknown and unsupported binding rejection.

## SQL and ownership review

- New model reads/updates remain short tenant-scoped operations. No Git, provider, model, or HTTP I/O occurs inside an org SQL transaction.
- Broker credential acquisition and Git operations occur after model calls return. The reported sandbox-binding defect is a missing identity fence, not a long transaction request.
- Export/hydrate planning preserves separate durable steps and one OpenWorkflow owner.

## Evidence disposition

Inspected committed evidence and status claims for 17 native/retained conversation/export/protected checks, backend types at 140 acknowledged diagnostics, scoped Biome, and proof policy. Evidence was not rerun by instruction.

## Fowler baseline disposition

- Reported: remaining **Duplicated Code**, remaining **Data Clumps**, and new **Mysterious Name**.
- No additional actionable Feature Envy, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest.
- Persisted sandbox identity/registry work and other API/config/provider/legacy work were treated as explicitly open. That does not waive the current in-memory captured-binding fence required before this new publisher pushes.

## Counts

- Documented-standard violations: **2**
- Heuristic smells: **3**
- Implemented-scope blockers: **1**
