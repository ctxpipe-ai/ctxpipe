# ctxpipe Gate 4 — Independent Cumulative Reviewer B Re-review

**Verdict: BLOCKED**

**Fixed point:** `20cf0791c4467aacd5719ad58ee39593515300eb`  
**Reviewed HEAD:** `058a4a3bd89e58a0e904a51c89e4ae7e7124d418`  
**Diff:** `git diff 20cf0791c4467aacd5719ad58ee39593515300eb...HEAD`

This is an independent cumulative re-review. I inspected the repository and current implementation rather than relying on another review report.

## Executive result

Two of the three previously reported defects are corrected:

1. The production Docker path now reuses a policy-keyed, module-shared `defineSandbox` object across prepare and Send. The retained quota-Docker journey counts one image inspection and one provider/definition construction across prepare, two chat turns, provider destruction, and recovery.
2. The backend `console.*` interception helper and its test are deleted. No direct `console.error`/`info`/`log`/`warn` use or assignment remains under `apps/backend/src`.

The warm-turn acceptance proof remains incomplete. The newly added 20-sample measurement times only `resolveWorkspaceChatTurnRuntime`, not a warm chat answer. The Docker journey proves useful text and no repeated provider construction, but it has a 300-second test timeout and records neither warm answer latency nor native attach count. I am **not** blocking on the Gate 6 20-warm/5-cold full-product harness; I am blocking only on the still-unretained first warm-turn budget required for Gate 4.

I also reproduced a run-attribution defect in the revised OTEL helper. Proxy generation events still resolve through one `activeTurnId` per conversation, so a second attempted send can redirect the first run's model completion into the second run's span. The new overlap unit test does not exercise that ordering.

## Blocking findings

### 1. The first complete warm-turn budget is still not retained

The acceptance target is zero GitHub calls, at most one lease attach, no provider creation on reuse, and about five seconds to a complete useful answer (`docs/plans/workspace-chat-recovery.md`, measurement harness and Gate 4 required proof).

Current evidence is split into two partial tests:

- `workspace-chat-prepare-native.contract.test.ts:748-798` calls `resolveWorkspaceChatTurnRuntime` 20 times, proves zero fixture GitHub requests, and checks resolver p95 below 5 seconds. It never calls `streamTanstackWorkspaceChat`, so this is not answer latency.
- `workspace-chat-prepare-native.contract.test.ts:525-746` runs a real quota-Docker prepare and two scripted-broker turns. It proves exact useful text and asserts `imageInspects === 1` plus `providerCreates === 1`. It does not measure prepare-to-answer or Send-to-useful-answer latency, and it does not count native `ensure`/attach operations.
- `tanstack-workspace-chat.ts:696-703` writes `attached: false` as a constant; this is not an observed attach counter.

The code structure suggests a same-revision Send reaches one stock `withSandbox` ensure, and the policy cache prevents repeated provider construction. That is encouraging but not the required retained oracle. A regression that adds a second attach or stalls the actual OpenCode answer can still pass every new assertion.

Required correction: retain one prepared production Docker warm Send that asserts all four facts together: no external GitHub requests, exactly one native attach/ensure, zero provider/definition creation during reuse, and a complete useful answer within the accepted warm-answer budget. The broader 20-warm/5-cold distribution remains Gate 6 and is not required here.

### 2. Overlapping runs are still attributed through a conversation-keyed process map

`workspace-chat-otel.ts:33-40` stores turn state by run ID but also stores only one `activeTurnId` per conversation. `beginWorkspaceChatProxyGeneration` and `recordWorkspaceChatProxyGeneration` accept only `conversationId` and resolve whichever run most recently called `beginWorkspaceChatTurn` (`workspace-chat-otel.ts:75-79`, `111-130`). The model proxy likewise supplies only the conversation ID (`workspace-chat-openai.ts:213-229`; `workspace-chat-model-proxy.ts:91-121`).

This ordering is possible with simultaneous sends:

1. Run A begins and acquires the native transcript owner.
2. Run B begins, replaces `activeTurnId[conversation]`, then waits for the native transcript lock.
3. Run A's already-running model request reports its generation by conversation ID.
4. The generation is recorded on run B.

I reproduced that exact association using the production functions:

```json
{"runA":[],"runB":["response-from-run-a"]}
```

The new test at `workspace-chat-otel.test.ts:41-63` records run A's completion before beginning run B, so it cannot detect the defect it claims to cover. This also makes the latency/loop telemetry unsuitable as evidence for the warm budget under concurrent sends and leaves a process-global manual lifecycle beside stock TanStack/OTEL.

Required correction: propagate an exact run/lease identity to the model-proxy observation path (or use exact request context), remove the conversation-to-current-run guess, and retain the interleaving above as the regression test.

## Requirement matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Shared production Docker definition consumed by prepare and Send | PASS | `dockerChatSandboxes` is module-shared and keyed by immutable `policyIdentity`; both prepare and Send call `buildWorkspaceChatSandbox`, which returns the same cached definition for the same policy. The Docker journey asserts one inspection and one provider creation across both paths. |
| No per-call Docker provider/definition rebuild on reuse | PASS | `workspaceChatDockerSandbox` returns the cached object before `dockerSandbox(...)` / `conversationSandboxDefinition(...)`; the retained journey's total counters are both one. |
| Zero GitHub calls on warm runtime resolution | PASS | Twenty warm resolver samples produce no fixture GitHub requests; targeted local execution passed. |
| At most one native attach on first warm Send | FAIL — no retained oracle | No attach/ensure counter is asserted. The only `attached` field is a constant. |
| Useful first warm-answer budget | FAIL — no retained oracle | The 5-second assertion measures only runtime resolution; the useful-answer journey has no elapsed-time assertion. |
| Full 20-warm/5-cold product measurement | DEFERRED | Explicitly Gate 6; not a Gate 4 blocker by itself. |
| Remove backend console interception | PASS | `withTanstackConsoleCapture` and its test are deleted; full backend source search found no direct console calls or assignments. |
| Remove `tanstack-runtime` catch-and-empty loader | PASS | `tanstack-runtime.ts` is deleted; TanStack/OpenCode dependencies are static imports in `tanstack-workspace-chat.ts`. |
| Remove chat lifecycle catch-and-empty behavior | PASS for reviewed ownership path | Stored-turn and required module failures now propagate. Remaining parsing/degradation catches are not alternate chat/sandbox owners; detached-provider import failures become explicit cleanup errors. |
| No `ChatEngine`, `SandboxLease`, `ConversationSession`, `WorkspaceJobRunner`, process handle registry, or sandbox memo | PASS | Full `apps` source searches found no competing implementation; old registry/memo/port/terminal-repair imports are absent. |
| Railway behavior is honest and fail-closed | PASS | Locked Railway prepare returns the exact 503 and allocates no sandbox; targeted contract passed. No Railway provider/SDK scaffold was found. |
| Per-run telemetry and terminal cleanup | FAIL | Iterator cleanup now uses `finally`, but proxy generation attribution still guesses through one active run per conversation. |
| Files, publish, delete, and idle cleanup use native persisted ownership | PASS | Files/publish take the transcript lock and use `warmTanstackWorkspaceChat(... existingOnly)`; deletion and idle collection use the shared workspace/native lock namespaces and retain failed rows. |

## Standards

### Hard-rule findings

No remaining hard repository-standard violation was found in the correction:

- Backend production source contains no direct `console.*`.
- Logging in the reviewed modules uses evlog.
- Required TanStack packages are statically imported rather than hidden behind an optional catch-to-null loader.
- The post-review correction diff passes `git diff --check 032c5b23...HEAD`.
- CI Typecheck, Biome, backend production build, and migration jobs for this HEAD had passed when inspected; the overall CI run was still in progress.

### Nonblocking standards judgments

- **Speculative Generality / test hook:** `workspaceChatDockerOwnership` exports mutable counters and a `reset()` method from production code solely for the contract test. It can clear the shared definition cache. Search found no production caller, so this is not a current correctness blocker, but the proof hook should eventually move behind a test-only observation seam.
- **Potential unbounded cache:** `dockerChatSandboxes` retains one entry per policy identity for process lifetime. The identity is immutable and does not carry handle correctness, so this is not a second sandbox owner; nevertheless, deployments supporting many custom Git authorities should bound or relocate this deterministic provider cache.

**Standards count:** 0 blockers; 2 nonblocking judgments.

## Spec

The production definition-reuse, static import, console removal, fail-closed Railway, and old-owner deletion requirements are met.

Two requirements remain partial:

1. Gate 4 still lacks one complete first warm-turn call/latency oracle.
2. The attempted run-scoped telemetry correction does not preserve exact run ownership under the simultaneous-send ordering Gate 4 explicitly requires.

**Spec count:** 2 blockers.

## Simplicity

**Job:** one durable conversation worktree and one stock TanStack chat lifecycle, with thin product policy around authorization, revision, credentials, tools, publication, and telemetry.

**Thinnest machine:** a policy-shared native sandbox definition; runtime `WorkspaceDefinition`; PostgreSQL native instance/lock stores; stock `withPersistence`, `withSandbox`, `opencodeText`, HTTP/WebSocket codecs, and focused native-git commands.

**Current result:** the former sandbox registry, handle memo, port owner, dynamic TanStack loader, manual terminal repair, and console interceptor are gone. The Docker map stores deterministic definitions, not handles or bindings, and is acceptable for immutable per-authority egress policy reuse.

**Leftover blocking machinery:** `workspace-chat-otel.ts` still maintains a process-global conversation-to-active-run registry to repair context the model proxy does not carry. It is both avoidable and demonstrably wrong under overlap.

**Leftover nonblocking machinery:** production-exported ownership counters/reset exist only to test the definition cache.

**Simplicity count:** 1 blocker; 1 nonblocking judgment.

## Codebase coverage

| Surface | Inspected |
| --- | --- |
| Core chat owner | `tanstack-workspace-chat.ts`, `workspace-chat-send-runtime.ts`, `workspace-chat-turn-runtime.ts` |
| Logging/telemetry | `workspace-chat-otel.ts`, `workspace-chat-model-proxy.ts`, `workspace-chat-openai.ts`, `opencode-chat-stream.ts` |
| HTTP/WS/MCP entry points | `conversations.ts`, `conversation-websocket.ts`, `mcp/tools.ts` |
| Prepare/warm/provider proof | `workspace-chat-prepare-native.contract.test.ts`, `workspace-chat-native.contract.test.ts`, `sandbox-provider.ts`, `sandbox-provider.test.ts`, `workspace-chat-docker-policy.ts` |
| Files/publish | `conversation-files-routes.ts`, persisted binding and existing-only attach path |
| Delete/idle/provider cleanup | `workspace-sandbox-cleanup.ts`, `workspace-tip-check.ts`, detached provider cleanup |
| Old-owner searches | `ChatEngine`, `SandboxLease`, process registry, sandbox registry/memo, custom OpenCode port, terminal repair, dynamic TanStack loader |
| Error searches | empty catches, catch-to-null/false/empty, `tanstack-runtime`, console assignments |
| Tests and CI | targeted Vitest runs, post-correction whitespace check, current GitHub CI jobs |

## Verification performed

Passed locally:

- `workspace-chat-otel.test.ts` + `opencode-chat-stream.test.ts`: 6/6.
- Prepare contract filtered to Railway and warm runtime: 2/2 (16 skipped by test-name selection), 6.39 seconds total.
- Stock native prepared-worktree/two-turn transcript contract: 1/1, 9.77 seconds total.
- Sandbox provider contracts: 4/4.
- `git diff --check 032c5b23...HEAD`.

The passing OTEL unit test is not a valid oracle for the overlapping ordering. The direct production-function reproduction produced `runA: []` and `runB: ["response-from-run-a"]`.

The quota-Docker journey cannot run on this host because the required Btrfs quota runner variables/topology are absent. CI `34410598235` passed that journey on `6f5c753b`; the current HEAD's CI is [34416709719](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34416709719). At inspection time its Typecheck, Biome, backend build, migrations, and several other jobs were green, while the aggregate run remained in progress.

## Final verdict

**BLOCKED**

Do not close Gate 4 until:

1. One prepared production Docker warm Send retains zero GitHub calls, exactly one attach, zero provider/definition creation during reuse, and useful-answer latency within the accepted budget. Do not expand this into the Gate 6 20-warm/5-cold harness.
2. Proxy generation telemetry is bound to the exact run rather than the latest run for a conversation, with the reproduced interleaving retained as a test.
