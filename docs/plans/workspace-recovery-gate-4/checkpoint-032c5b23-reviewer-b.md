## Pin

- Fixed point resolves to `20cf0791c4467aacd5719ad58ee39593515300eb`.
- Reviewed `HEAD` resolves to the requested `032c5b23f3560e61526c4c58a8a295663478f4f2` on `codex/develop-plan-to-refocus-branch-direction`.
- `git diff --quiet 20cf0791c4467aacd5719ad58ee39593515300eb...HEAD` returned `1`, so the three-dot diff is non-empty. The range contains the Gate 4 commits from `83465ae6` through `032c5b23`.
- The cumulative diff is 378 files, +83,902/−7,687. I searched `apps/` and `packages/` for the requested old vocabulary and Railway surfaces; traced every requested TanStack/persistence/cleanup symbol; read the chat/sandbox production owners, HTTP and WebSocket routes, native contracts, Docker deployment topology, migrations, and tracked package patches. I did not inspect other reviewers' reports or rerun quota Docker/full CI.

## Standards

### Blocking hard-rule violation

1. **Direct `console.*` remains in backend production source.** The backend rule is: “**Do not use `console.*` in `apps/backend` — logs must go through evlog**.” `apps/backend/src/domain/workspaces/opencode-chat-stream.ts` reads, replaces, and restores `console.error`, `console.info`, `console.log`, and `console.warn` in `withTanstackConsoleCapture`. The only caller found is its test; production imports this module only for `httpWideEventMessage`. This is dead, global interception machinery, not an evlog call, and it remains in the final tree despite Gate 4’s deletion objective. Remove the helper and its test coverage or move an actually required dependency capture behind a standards-compliant boundary.

### Other hard-rule checks

- No `ChatEngine`, `SandboxLease`, lease-store facade, process registry, `ConversationSession`, or `WorkspaceJobRunner` implementation was found in `apps/` or `packages/`. `sandbox-registry.ts`, sandbox memo, application port lease, assistant-text gate, and manual persisted-run completion were deleted in this range.
- No Gate 4 production catch-and-empty path was found. The remaining empty catches are two unrelated connector JSON fallbacks and the native test’s SSE JSON parser; they are not chat lifecycle owners.
- `SANDBOX_CALLBACK_HOST`, `SANDBOX_CHAT_IMAGE`, and `SANDBOX_MODEL_PROXY_HOST` are operator/deployment topology values, not feature toggles.
- The five migration folders contain Drizzle snapshots; the ledger identifies them as generated, and their SQL corresponds to the schema deltas. No evidence of hand-written migration SQL was found.
- All five TanStack patches and the OpenCode SDK patch remain registered in `pnpm-workspace.yaml`; tracked patches were preserved.
- `startNestedModelRelay` and `startNestedPortForward` are file-local functions in `workspace-chat-prepare-native.contract.test.ts`. No production import exists.

### Smell judgement

- **Divergent Change / Data Clump:** `tanstack-workspace-chat.ts` is an 890-line composition module responsible for provider discovery, Docker image inspection/policy, definition construction, revision transition, secrets, capability minting, persistence, telemetry, naming, and transport callbacks. The repeated definition/workspace/store tuple in prepare, send, and revision recovery is where the warm-definition regression below occurs. This is a judgement-call smell, but it materially weakens the intended thin foundation seam.

## Spec

### Blocking findings

1. **Docker prepare/send rebuild the sandbox definition on every call.** The specification says: “**A warm turn performs zero GitHub calls and no sandbox-definition rebuild**,” and Gate 4 requires: “**Make prepare call the same `definition.ensure()` consumed by Send.**” Both `warmTanstackWorkspaceChat` and `startWorkspaceChat` call `buildWorkspaceChatSandbox`. On every Docker call that function inspects both images, constructs a new `dockerSandbox(...)`, and calls `conversationSandboxDefinition(...)`, which calls `defineSandbox(...)`. Prepare invokes `ensure` on that newly built definition; Send passes another newly built definition to `withSandbox`. The local-process definition is module-static, but Docker—the production path—is not. This looks native because the instance and lock stores are durable, yet it violates the explicit no-rebuild requirement and means prepare and Send do not consume the same definition object.

2. **The required warm-turn call/latency proof is incomplete.** Gate 4 says: “**Required proof: … cleanup, and warm-turn call/latency budget**.” The measurement contract says: “**For at least 20 warm and five cold samples, capture p50/p95/max**” and “**The first warm-turn budget is zero GitHub calls, at most one lease attach, and no provider creation**.” The retained warm test proves only that a second `resolveWorkspaceChatTurnRuntime` causes zero GitHub requests. `validation-warm-entrypoints.md` reports that test’s 6.30-second suite duration, not 20 warm/five cold end-to-end turn samples, p50/p95/max, lease-attach count, provider/definition construction count, or useful-answer latency. Current code demonstrably performs two Docker image inspections and constructs a provider/definition per warm Send, so the missing oracle masks a real regression.

### Requirement coverage

| Requirement | Result | Evidence |
| --- | --- | --- |
| TanStack + Postgres are the sole sandbox owners | Pass | `defineSandbox`, `postgresSandboxInstanceStore`, and `postgresSandboxLocks`; registry/memo owners deleted |
| Two turns / persisted transcript | Pass | Native contract runs two stock turns, reuses one provider handle, and compares reconstructed stored messages |
| Disconnect/resume offsets | Pass | Real Bun WebSocket client disconnects/resumes by offset and checks byte-equivalent frame replay without another model call |
| Process restart | Pass | Reconstruction runs in a fresh process; native replica contract also resumes the same worktree after child-process restart |
| Replica handoff | Pass | `sandbox-replica-native.contract.test.ts` exercises separate definitions/processes against the same Postgres owner |
| Simultaneous sends | Pass | Overlapping stale sends admit one transcript, emit one terminal per response, and never model-call the rejected prompt |
| Stale credential/revision after prepare | Pass | Prepare refreshes credentials without replacing the worktree; revision advance/rewind/process-loss contracts preserve or explicitly conflict saved work |
| One terminal event | Pass | HTTP/native and WebSocket contracts assert exactly one `RUN_FINISHED` or `RUN_ERROR` |
| Transcript equality | Pass | WebSocket offset replay compares frames exactly; fresh-process reconstruction matches persisted transcript |
| Cleanup | Pass | Conversation/workspace deletion fences first allocation, detached/provider-loss cleanup is retained for retry, and base image collection waits for the final owner |
| Warm-turn call/latency budget | **Fail** | Only zero GitHub calls in runtime resolution are measured; definition/provider rebuild occurs and required sampling/counts are absent |
| Railway closure | Pass | Exact `503` selector response, no allocation/model call, no `@railway` SDK provider/dependency |
| Quota-Docker closure | Accepted as scoped | CI `34410598235` / `6f5c753b` records two scripted-broker turns, 1 CPU/1 GiB/128 PID/4G, HTTPS Git plus `git ls-remote`, unsaved work, and provider-loss recovery; no live LLM/tool-call claim is required |

### Entry-point and native-contract trace

- HTTP parses/authenticates in `conversations.ts`, then `workspaceChatStreamResponse` maps to `streamTanstackWorkspaceChat`.
- WebSocket authenticates the upgrade, uses native `toWebSocketStream`, parses the same AG-UI shape, restores auth context, and calls `streamTanstackWorkspaceChat`. The codecs therefore converge on one chat entrypoint; no second chat engine was found.
- `reconstructChat` is used directly by the GET chat route and fresh-process proof.
- `workspaceChatPersistence` is the shared Postgres message/run/interrupt/metadata persistence.
- Files/publish obtain an existing ensured handle; conversation/workspace deletion and the workspace tip check call the native cleanup owner.
- Prepare and Send both use the same definition factory/configuration path, but the production Docker path rebuilds separate definition objects; that is the blocker above.

### Scope

No unsupported Railway implementation or live-provider claim was added. The production `sandbox-model-relay` is not the CI loopback helper: it is a hardened deploy-profile component in the DinD network namespace, runs unprivileged/read-only with all capabilities dropped, and implements the ADR’s production model route. The two GHA loopback helpers remain test-local. The native provider/resource/egress work is large, but it is tied to ADR-034’s locked ownership, isolation, recovery, and exact-egress requirements rather than unrelated product scope.

## Simplicity

- **Job:** one durable conversation worktree and one stock TanStack chat lifecycle that survive restart/replica handoff while enforcing ctxpipe authorization, revision, credential, and publish policy.
- **Thinnest machine:** one module-static TanStack `defineSandbox` per supported provider; runtime `WorkspaceDefinition` plus Postgres native instance/lock stores; stock `withPersistence`, `withSandbox`, `opencodeText`, `toWebSocketStream`, and `reconstructChat`; thin HTTP/WS codecs; focused native-git Files/publish commands; native cleanup under the same lock namespace.
- **Leftover machinery:** production Docker rebuilds the provider and definition for every prepare/send; `withTanstackConsoleCapture` is dead global error-capture machinery; `lastWorkspaceChatStopText` plus its test are unused text-repair residue. `workspace-chat-otel.ts` also keeps a process-global turn map. That map is observability rather than sandbox correctness ownership, so I do not classify it as a forbidden second owner, but simultaneous attempted sends can overwrite each other’s spans and it should become run/context-scoped.
- I found no second durable sandbox owner, application handle registry, port lease store, or Railway provider. Railway fails closed.
- I found no CI ingress relay in a production import path. The production Compose relay is deliberately separate and fail-closed; the GHA forwards are test-local.

The central simplicity blocker is not a competing durable store; it is rebuilding the chosen native authority around every production call after runtime policy was added. That makes the machine thicker than the accepted module-static definition + runtime workspace design and directly defeats the warm path.

## Verdict

BLOCKED

Blockers:

1. Restore one module-static production Docker `defineSandbox` consumed by prepare and Send; runtime workspace/policy data must not reconstruct the definition/provider per turn.
2. Add the specified warm-turn proof: at least 20 warm and five cold end-to-end samples with p50/p95/max, zero GitHub calls, at most one attach, no provider/definition creation, and useful-answer latency.
3. Remove the backend `console.*` interception helper and its dead test path (and preferably the unused `lastWorkspaceChatStopText` residue) so the final tree satisfies the evlog-only hard rule and Gate 4 deletion objective.
