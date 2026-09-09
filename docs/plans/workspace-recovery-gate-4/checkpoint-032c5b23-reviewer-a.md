## Pin

- Fixed point resolves to `20cf0791c4467aacd5719ad58ee39593515300eb`.
- Reviewed HEAD resolves to `032c5b23f3560e61526c4c58a8a295663478f4f2` on `codex/develop-plan-to-refocus-branch-direction`.
- `20cf0791c4467aacd5719ad58ee39593515300eb..HEAD` contains 41 commits.
- The three-dot diff is non-empty: 378 files, 83,902 insertions, and 7,687 deletions.
- I did not rerun CI or the quota-Docker suite. I read the retained contracts and committed ledger. The ledger records CI `34410598235` green on `6f5c753b` with 29/29 checks and 332/332 contracts (`docs/plans/workspace-recovery-gate-4/remaining.md:41-54,75-80`).

## Standards

### Blockers

1. **Production backend code directly uses and mutates `console.*`.** `withTanstackConsoleCapture` snapshots, replaces, and restores all four process-global console methods (`apps/backend/src/domain/workspaces/opencode-chat-stream.ts:97-134`). It is not called by production; its only caller is its test (`apps/backend/src/domain/workspaces/opencode-chat-stream.test.ts:122-123`). This violates the explicit evlog-only rules in `AGENTS.md:172-174` and `apps/backend/AGENTS.md:16-22`. If invoked concurrently, it also drops unrelated logs and permits one invocation to restore another invocation's interceptors. This test-only/dead helper must not remain in production.

### Nonblocking judgments

- **Fowler — Middle Man / Speculative Generality:** `loadTanstackChatModules` restates a large TanStack export surface and converts two import failures to `null` (`apps/backend/src/domain/workspaces/tanstack-runtime.ts:7-46`), while the owner already statically imports `defineSandbox`, Docker, and local-process (`apps/backend/src/domain/workspaces/tanstack-workspace-chat.ts:1-24`). This is blocking on Spec and Simplicity below; the Fowler labels themselves are judgment calls.
- **Fowler — Divergent Change:** `tanstack-workspace-chat.ts` now resolves providers and images, constructs policy and workspace identity, starts stock chat, coordinates revision recovery, mints capabilities, and emits timing. The concrete ownership regression is blocking under Spec/Simplicity; file size alone is not a hard standards breach.
- The new sandbox env values are deployment/operator inputs—reachable callback host, immutable image, and model-relay host (`apps/backend/src/config/env.ts:82-97`)—rather than feature toggles, so they satisfy `lessons-learned.md:7-17`.
- The sandbox-lock and instance changes include Drizzle snapshots and generated migrations. Although `sandbox_locks.org_id` is not textually marked `NOT NULL` in `apps/backend/migrations/20260909011959_material_ben_urich/migration.sql:1-7`, its composite primary key enforces non-nullness and matches `apps/backend/src/db/schema/sandbox-locks.ts:6-21`; this is not a mismatch.
- Production source passes `git diff --check` when committed evidence logs and dependency patch payloads are excluded. The full range does report whitespace in those tracked logs and patches, so the claimed “whitespace Passed” in `validation-warm-entrypoints.md:13` should be refreshed, but I do not treat historical output formatting as a production blocker.

**Standards count: 1 blocker; 5 nonblocking judgments.**

## Spec

### Blockers

1. **The Docker warm path rebuilds the sandbox definition and repeats provider/image work.** The plan requires a warm turn to perform no sandbox-definition rebuild (`docs/plans/workspace-chat-recovery.md:329-333`) and Gate 4 requires prepare and Send to use the same definition (`docs/plans/workspace-chat-recovery.md:661-674`). The accepted checkpoint likewise says one sandbox per provider is created at module load (`docs/plans/workspace-recovery-gate-4/status.md:73-79`). Current code keeps only local-process static; each call to `buildWorkspaceChatSandbox` creates a Docker client, inspects two images, rebuilds policy, calls `dockerSandbox`, and calls `conversationSandboxDefinition` (`apps/backend/src/domain/workspaces/tanstack-workspace-chat.ts:680-689,738-761`). Both prepare and every Send call this builder (`apps/backend/src/domain/workspaces/tanstack-workspace-chat.ts:318-353,393-427`). This is a regression from the accepted static-definition checkpoint and contradicts the warm-path contract.

2. **The required warm-turn call/latency budget has no retained proof.** The required budget is zero GitHub calls, at most one lease attach, no provider creation, and about five seconds to a complete useful answer (`docs/plans/workspace-chat-recovery.md:500-513`; Gate 4 proof list at `:676-678`). The retained test only calls `resolveWorkspaceChatTurnRuntime` twice and asserts no GitHub requests (`apps/backend/src/domain/workspaces/workspace-chat-prepare-native.contract.test.ts:744-779`); it neither sends a warm chat turn nor counts attach/create operations nor asserts a useful-answer deadline. `validation-warm-entrypoints.md:9` reports only zero external requests, while `docs/plans/workspace-recovery-gate-4/deletion-ledger.md:15` still says latency sampling is open. Timing logs (`tanstack-workspace-chat.ts:360-373,612-619`) are instrumentation, not an acceptance assertion.

3. **Gate 4's catch-and-empty removal is incomplete.** Gate 4 explicitly requires removing catch-and-empty behavior (`docs/plans/workspace-chat-recovery.md:670-674`). `loadTanstackChatModules` still catches failed Docker and local-process imports to `null` and returns optional exports (`apps/backend/src/domain/workspaces/tanstack-runtime.ts:23-46`). The same packages are required/static imports in the production owner, so this is not a valid optional-provider boundary; it is a leftover compatibility path that hides the original module-load failure.

### Nonblocking judgments

- Two turns, one `RUN_STARTED`/`RUN_FINISHED` per turn, one persisted native owner, transcript equality, unsaved-work reuse, and stock reconstruction are asserted in `workspace-chat-native.contract.test.ts:30-147`.
- Simultaneous stale sends preserve exactly one accepted transcript and one terminal event per response (`workspace-chat-native.contract.test.ts:163-303`). WebSocket offset replay, active disconnect, one terminal, no replay model call, and fresh-process transcript reload are asserted at `:306-345`. Replica/process restart reuse of one Docker worktree is asserted in `sandbox-replica-native.contract.test.ts:35-158`.
- Credential refresh preserves the native worktree (`workspace-chat-prepare-native.contract.test.ts:149-220`); deletion/allocation fencing is covered at `:225-295`; captured-SHA, live advance/conflict, process-loss recovery, and provider replacement are covered by the later prepare contracts and summarized in `validation-native-bases-and-recovery.md:11-24`.
- Entry points converge acceptably: HTTP uses `streamTanstackWorkspaceChat` (`domain/conversations/transport.ts:121-145`), WebSocket uses the same stream (`routes/v1/conversation-websocket.ts:157-224`), hydrate uses stock `reconstructChat` (`routes/v1/conversations.ts:528-553`), MCP uses `collectTanstackWorkspaceChatText` (`mcp/tools.ts:121-157`), prepare uses `warmTanstackWorkspaceChat` (`routes/v1/conversations.ts:656-699`), and Files/publish use the ensured native handle (`routes/v1/conversation-files-routes.ts:381-422`; `routes/v1/conversations.ts:741-801`). Delete and idle cleanup converge on `workspace-sandbox-cleanup.ts` from `conversations.ts:569-607` and `workspace-tip-check.ts:209-231`.
- Railway is only a recognized selector: unsupported selection returns 503 before allocation (`tanstack-workspace-chat.ts:689-703`; `workspace-chat-prepare-native.contract.test.ts:76-108`), there is no Railway SDK dependency/provider/cleanup branch, and no live proof is claimed.
- The quota-Docker journey uses fixture HTTP through the production broker, emits text-only completion chunks, exercises HTTPS Git and two turns, and verifies 1 CPU / 1 GiB / 128 PID / 4G (`workspace-chat-prepare-native.contract.test.ts:524-742`; `test/native-chat-fixture.ts:83-124`). Nested relay/forward helpers occur only in that contract (`workspace-chat-prepare-native.contract.test.ts:571-595,1535-1660`) and have no production matches.
- No production `vitest --retry` use was found; the only retry strings are policy-test fixtures designed to reject it.

**Spec count: 3 blockers; 7 nonblocking judgments.**

## Simplicity

### Job

Own one conversation's stock TanStack chat and native sandbox across turns, replicas, and restarts, while exposing Files/publish as adjacent native-Git commands.

### Thinnest machine

Authenticated HTTP, WebSocket, and MCP adapters should normalize input and call the same stock `chat` construction. One module-static native `defineSandbox` per supported provider should receive an immutable runtime workspace; `withPersistence`, `withSandbox`, `opencodeText`, the Postgres instance/lock stores, and native Git should own their respective behavior. Cleanup should operate from persisted native identities.

### Blockers: leftover machinery

1. **A second definition/provider construction owner has returned.** `conversationSandboxDefinition` is now both the module-static local definition factory and a per-call Docker definition factory (`tanstack-workspace-chat.ts:135-164,738-761`). Image discovery and policy construction sit in the chat owner on every build. This defeats the thin static-definition seam and recreates lifecycle/configuration work around native TanStack.

2. **The TanStack module loader is an unnecessary wrapper and failure-policy owner.** `tanstack-runtime.ts:7-46` mirrors stock exports, dynamically reloads required dependencies, and decides that two import failures mean `null`. Static imports already exist in `tanstack-workspace-chat.ts:1-24`. This is Middle Man plus catch-and-empty machinery, not a narrow product adapter.

3. **A process-local custom turn lifecycle remains beside TanStack/OTEL.** `workspace-chat-otel.ts:19-33` owns a module-global `Map` keyed only by conversation, and `:35-206` manually begins, mutates, summarizes, and finishes spans from chat and model-proxy call sites. Two simultaneous sends for one conversation overwrite/end each other's state (`:35-53`), and early async-iterator return can bypass `finishWorkspaceChatTurn` because `streamTanstackWorkspaceChat` uses try/catch rather than `finally` (`tanstack-workspace-chat.ts:203-215`). The job is telemetry; the thinnest owner is request/run-scoped OTEL/TanStack middleware and propagated run context, not a conversation-keyed process registry.

4. **A test-only global console interceptor remains in production.** `withTanstackConsoleCapture` has no production caller and is exercised only by its test, yet it mutates all process console methods (`opencode-chat-stream.ts:97-134`). Delete it rather than keeping a dormant process-global error lifecycle.

### Nonblocking judgments

- The former `sandbox-registry.ts`, sandbox memo, custom OpenCode port lease, assistant-text repair, sandbox-health helper, and manual persisted-run completion modules are deleted. `ConversationSession` search hits are branch-operation names, not a broad session facade.
- `workspace-sandbox-cleanup.ts` is a focused persisted-owner cleanup module, not a handle registry. It fences workspace/native keys and retains failed rows for retry (`workspace-sandbox-cleanup.ts:109-185,204-260`).
- The six tracked TanStack/OpenCode patches are very large (9,472 net added lines across the patch files), but the user explicitly requires preserving them. They are registered in `pnpm-workspace.yaml:6-17`, and ADR-034 supplies retained proofs/deletion conditions for OpenCode, persistence, runtime workspace, and cancellable filesystem extensions (`ADR-034:19-30`). Their maintenance cost is a risk, not an independent blocker in this review.
- Railway has no SDK/provider scaffold. The selector string in `sandbox-provider.ts:3-27` and 503 branch are honest fail-closed behavior.
- Native Git remains the worktree/branch authority; OpenWorkflow remains the idle-cleanup runner; no `WorkspaceJobRunner`, `SandboxLease`, ChatEngine, provider registry, or process manager remains in production.

**Simplicity count: 4 blockers; 5 nonblocking judgments.**

## Verdict

BLOCKED

Before a `Gate 4:` close commit:

1. Restore one static native Docker definition/provider owner and remove per-warm-turn definition rebuild/image-policy reconstruction.
2. Add retained proof for the complete warm-turn budget: zero GitHub calls, at most one attach, zero provider creates, and the accepted useful-answer latency target.
3. Remove the `tanstack-runtime.ts` middleman/catch-and-empty compatibility path.
4. Replace or remove the conversation-keyed process-local OTEL turn lifecycle so concurrent sends and iterator cancellation have one run-scoped owner.
5. Remove the dead production `withTanstackConsoleCapture` helper and all direct `console.*` mutation.
