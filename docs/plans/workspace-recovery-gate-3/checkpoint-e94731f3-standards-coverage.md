# Standards coverage — `e94731f310ff539fe86bb5499e6c691256e48b41`

## Review identity and method

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target: `e94731f310ff539fe86bb5499e6c691256e48b41`; merge base verified as the fixed base.
- Enumerated all 23 commits and all 1,393 changed paths with pinned `git log`, `git diff`, `git show TARGET:path`, `git grep TARGET`, and `git ls-tree`; the moving worktree was not read for conclusions.
- The cumulative range contains 113 production source/script paths, 64 test paths, eight migration artifacts, plan/ADR material, and committed proof output. No product files were changed and no test process was started.
- Standards applied: root and backend `AGENTS.md`; ADR-027, ADR-028, and ADR-033; accepted recovery plan/status/audit; TDD and mocking guidance; complete Fowler baseline. Formatting/type issues enforced by tooling were excluded.

## Current increment surface

The `5136c873...e94731f3` increment contains 88 paths. Production changes reviewed in full:

- schema/migration: `db/schema/connections.ts`, generated `20260908181458_burly_hydra` migration/snapshot;
- Git/revision: `capture-connector-mirror.ts`, `conversation-publish.ts`, `revision.ts`;
- models: `confluence-sync-target.ts`, `connection-directory.ts`, new `connector-content-sync.ts`, `connector-finalization.ts`, `conversations.ts`, `linear-connector.ts`, `notion-connector.ts`;
- admission/workflows: Confluence and Notion enqueue modules; Linear, Notion, and Confluence full-content workflows; Linear and Notion retry routes; Linear GitHub push activation;
- public conversation route and native fixture;
- all changed native contract, route, connector model, and webhook tests; ADR/status/audit updates and saved proof logs.

## Interface and caller ledger

### Conversation publication

- `publicConversation` is local to the conversation route and is used for list, detail, and patch responses. Zod parsing strips `lastChatPrRevision`; PR URL uses that revision, while tree URL uses the current listed/detail workspace.
- `conversationFieldsWithCurrentPr` replaces `conversationSelection` and is used by ensure-existing/insert, list, paginated list, get, workspace lookup, and update-returning. It retains the internal revision for policy while projecting the PR number only for the current workspace binding.
- `sameWorkspaceBinding` is used by GET PR’s post-provider recheck and POST PR reuse. `sameWorkspaceRevision` remains the full-SHA publication/admission CAS.
- `pushConversationSessionBranch` still has two production callers: Files push and PR creation. Its pack-base selection checks the observed session tip first and captured default second, fetches the selected base into the broker, preserves the observed session-tip lease, and transfers the thin pack in bounded chunks. No credential enters the sandbox.

### Connector activation and ownership

- `connections.contentSyncGeneration` is introduced with non-null default zero. Linear/Notion config activation and explicit retry increment it; Notion missing-config reset also invalidates prior work; Confluence activation increments it in the same transaction as `initial_sync`. Credential refresh paths do not increment it.
- `getConnectorContentSyncGeneration` has four production admission call sites: Linear retry, Notion retry, Linear config-push activation, and the Confluence/Notion post-config enqueue paths (five textual call sites because the push modules are separate).
- `reconcileConnectorContentSync` is called by the three binding read models and all five admission/error paths. It locks the current connection, filters the OpenWorkflow owner by workflow/org/connection/generation, preserves pending/running owners, and projects only failed/canceled current owners (or a missing current admission) to `sync_failed`. Older owners are excluded by generation.
- `captureConnectorMirrorTarget` has seven production callers. The three full-content parents supply their native generation; Confluence space, Linear/Notion entity, and Slack event parents intentionally use the current captured value without claiming full-sync ownership.
- `CapturedConnectorBinding` now carries generation. `lockConnectorFinalizationBinding` is used by all three full-content finalizers and by Confluence’s synced-space marker step. The same lock verifies workspace generation/URL/GitHub connection/default, repository URL/connection, connector generation, and provider identity/status.
- Linear/Notion finalizers no longer rewrite the directory after finalization because none of the indexed provider identity changes. `upsertConnectionDirectory` retains all existing callers but now ignores their possibly stale payload, locks/reloads the current connection, and writes the directory in that transaction.
- The three full-content workflow input schemas require `contentSyncGeneration`; their admitting callers were all updated. Each capture and final projection carries the value durably.

## Cumulative Gate 3 surface disposition

The pinned cumulative production list was checked by subsystem: native Git pack/tree/merge helpers; twelve typed writer workflows and broker/admission; hydration planning/caps/path projection; semantic child/resource cleanup; pause/protection recovery; connector parent capture/finalization; conversation sandbox/publication; scoped GitHub credentials/config writers; database schema/migrations/backfills; public Files/workspace/connector/conversation routes; graph/index hooks; provider/model adapters. Deleted generic runner/agent/worktree execution and obsolete reindex paths were confirmed only as deletions. Previously reviewed findings were rechecked where their interfaces changed.

## Proof and scope disposition

- Inspected the 106-test/11-suite native evidence, fresh and upgrade migration evidence, types evidence at 138 acknowledged diagnostics, policy 440/27, and scoped Biome output. No commands were rerun.
- New proof covers stale directory callbacks, generation ABA at all three provider finalizers, current failed/canceled and pending owner projection, reactivation, missing admission, real retry HTTP and GitHub activation admission, quiet rebase, PR relink/provider-read races, and public-schema serialization.
- The six deleted admission mocks are replaced at HTTP, webhook, model, and real OpenWorkflow/PostgreSQL seams. Fixtures use direct SQL only to arrange state or observe durable ownership; owned production collaborators run in process.
- Explicitly excluded from checkpoint findings: the documented activation/admission crash interval, event ordering, Confluence no-change lifecycle, and the remaining Gate 3 audit inventory.

## Fowler baseline disposition

- Reported: three **Duplicated Code** judgments (credential issuance, conversation preparation/publication, and write/connector admission).
- Closed: prior **Mysterious Name** (`conversationSelection`) and connector binding **Data Clumps**.
- Suppressed: duplication inside typed workflow lifecycle code because ADR-033 explicitly requires each workflow’s acquire/transform/stage/validate/commit/push/publication steps to remain visible; no generic StepApi-owning runner is allowed.
- No actionable Feature Envy, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest found.

## Counts

- Documented-standard violations: **0**
- Fowler heuristic smells: **3**
- Implemented-scope blockers: **0**
