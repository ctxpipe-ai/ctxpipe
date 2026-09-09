## Pin

- Fixed point: `20cf0791c4467aacd5719ad58ee39593515300eb`.
- Reviewed HEAD: `058a4a3bd89e58a0e904a51c89e4ae7e7124d418`.
- Merge base: `20cf0791c4467aacd5719ad58ee39593515300eb`.
- Remote `refs/heads/codex/develop-plan-to-refocus-branch-direction` resolves to the reviewed HEAD.
- Range: 42 commits; `git diff 20cf0791c4467aacd5719ad58ee39593515300eb...HEAD` contains 385 files, 84,210 insertions, and 7,821 deletions. The re-review correction `032c5b23...HEAD` contains one commit and 10 files, 363 insertions, and 189 deletions.
- I re-read current production code, not merely the prior report: the stock chat owner, provider policy/selection, Postgres instance and lock stores, model proxy and capability tokens, HTTP/WebSocket/MCP entry points, reconstruct/prepare, Files/publish, deletion/idle cleanup, current tests, Gate 4 plan/ledger, ADR-030, and ADR-034. Full-tree searches covered old registries, definition/handle caches, custom terminal repair, catch-and-empty paths, direct `console.*`, Railway SDK/provider code, and all `defineSandbox`/chat/ensure callers.
- Focused verification:
  - `pnpm --filter @ctxpipe/backend exec vitest run src/domain/workspaces/workspace-chat-otel.test.ts` passes 2/2.
  - A direct interleaving against the current production OTEL module reproduces incorrect attribution: after `run_a` and `run_b` start for one conversation, a late proxy completion is recorded as `{"a":[],"b":["late-a"]}`.
  - Production-range `git diff --check` passes for TypeScript, migration SQL, scripts, Dockerfiles, Compose, and workflows.
- CI [34416709719](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34416709719) is for the exact reviewed HEAD but remains `in_progress` at review completion. Earlier green CI `34410598235` is for `6f5c753b`, before this correction.

## Standards

### Hard-rule result

No remaining hard Standards violation found.

- The dead `withTanstackConsoleCapture` helper and its test are deleted. Full production search under `apps/backend/src/domain/workspaces` finds no direct `console.error/info/log/warn/debug`, satisfying the backend evlog-only rule.
- Required TanStack modules are now static imports in `tanstack-workspace-chat.ts`; deleted `tanstack-runtime.ts` has no surviving import or reference.
- New failure logging uses `getLogger()`/`log`, and provider unavailability remains fail-closed.
- Schema changes retain generated Drizzle migrations/snapshots and the short RLS transaction boundary.

### Nonblocking smell judgments

- **Speculative Generality / Test Code in Production:** `workspaceChatDockerOwnership` is an exported, explicitly “test-visible” mutable counter with a `reset()` that clears production singleton state. It exists only for one contract test. This is part of the blocking definition-registry design under Spec/Simplicity, but it is not a separate documented-standards breach.
- **Duplicated cleanup:** `streamTanstackWorkspaceChat` calls `finishWorkspaceChatTurn` in both `catch` and `finally`; the second call is a harmless no-op on errors. It is unnecessary but nonblocking.
- The detached cleanup adapter catches optional import failures and then fails closed through `destroyWithProviderFactory`; it does not invent a successful/empty domain result, so I do not classify it as the removed catch-and-empty behavior.

**Standards: 0 blockers; 2 nonblocking smell judgments.**

## Spec

### Prior-blocker replay

| Prior blocker | Current result | Evidence |
| --- | --- | --- |
| Per-call Docker `defineSandbox` rebuild | **Narrow behavior fixed; architecture still blocked** | Image inspection/provider construction are interned by `dockerImageInspect` and `dockerChatSandboxes`, and the quota contract sees one construction. The replacement is a new mutable application definition registry, forbidden by Gate 4/ADR-034. |
| Incomplete warm-turn budget proof | **Still blocked** | Provider construction is counted and warm resolver latency/GitHub calls are sampled, but no retained assertion counts native provider resume/attach, and no one composed warm Send proof observes all three required boundaries. |
| `tanstack-runtime.ts` catch-and-empty loader | **Fixed** | File deleted; production statically imports `chat`, `opencodeText`, sandbox helpers, and persistence helpers. |
| Conversation-keyed OTEL process map | **Not fixed** | `activeTurnId` is still `Map<conversationId, turnId>`; proxy callbacks still accept only `conversationId`. Runtime interleaving misattributes a completion. |
| Dead console mutation | **Fixed** | Helper and direct console mutation deleted. |

### Gate 4 requirement matrix

| Requirement | Result | Current production evidence |
| --- | --- | --- |
| Native `defineSandbox` + Postgres instance/lock authority | **Partial / fail** | Exact-key Postgres store, native lock adapter, short transactions, restart and replica contracts remain. However `tanstack-workspace-chat.ts` now owns `dockerChatSandboxes: Map<string, DockerChatSandbox>`, constructs definitions on cache miss, and exposes a cache reset. ADR-034 says no mutable application definition registry is retained. |
| Restart and two-replica race before caller switch | Pass | Independent-client/restart contracts persist exact provider identity and worktree bytes through Postgres ownership. |
| One stock chat call shared by HTTP and WebSocket | Pass | HTTP routes reach `workspaceChatStreamResponse`/`streamTanstackWorkspaceChat`; WebSocket reaches the same stream after official frame parsing; MCP collects that same stream. |
| Prepare uses the same `definition.ensure()` consumed by Send | Pass only within a cached policy | Prepare calls `definition.ensure`; Send passes the cached definition to `withSandbox`. This no longer creates two objects for the same process/policy, but the application map remains an unauthorized owner. |
| Native persistence/sandbox/OpenCode/WebSocket/reconstruct contracts | Pass | Production uses `chat`, `withPersistence`, `withSandbox`, `opencodeText`, `toWebSocketStream`, and `reconstructChat`; no manual assistant-text or terminal-repair module remains. |
| Remove GitHub and tool construction from valid warm turns | Partial | `WORKSPACE_CHAT_TOOLS` is static and the resolver contract records zero GitHub requests after warmup. The retained test does not compose resolver + warm Send while observing the complete budget. |
| Delete process registry/definition ownership, duplicate acquisition, manual repair, catch-and-empty | **Fail** | Old registry/memo/repair/loader files are gone, but the new Docker definition map and the OTEL turn maps remain process owners. |
| Two turns, one terminal, transcript equality | Pass | Native stock-chat contracts assert two turns, one terminal per accepted response, stored transcript, and reconstruction equality. |
| Disconnect/resume offsets and process reload | Pass | WebSocket contract asserts offset replay without another model call and fresh-process reconstruction from persisted messages. |
| Simultaneous sends and stale prepared revision/credentials | Pass | Native persistence lock rejects overlapping stale history; revision transition and credential contracts retain work and revalidate binding. |
| Files/publish/delete/idle cleanup | Pass | Focused routes use persisted binding plus native ensured handles; Files/publish hold the transcript lock; cleanup uses persisted provider identity and the workspace/native lock namespace. |
| Railway closure | Pass, accepted scope | Railway remains an exact fail-closed 503 selector with no SDK provider or dependency. |
| Quota-Docker closure | Pass, accepted scope | Scripted fixture HTTP, text-only turns, quota policy, HTTPS Git, provider-loss recovery, and focused credential renewal match the accepted closure. No `tool_calls` claim is required. |
| Nested OpenCode forwards | Pass, accepted scope | Forward helpers occur only in the contract test; no production import path was found. |
| Full final CI on reviewed SHA | **Pending / fail for closure** | Exact-SHA CI `34416709719` is still running. |

### Blocking findings

1. **The per-call rebuild was replaced by a forbidden process-global definition registry.** `dockerChatSandboxes` interns `DockerChatSandbox` objects by `policyIdentity`; each miss constructs `dockerSandbox(...)` and `conversationSandboxDefinition(...)`, and no entry is evicted. `workspaceChatDockerOwnership.reset()` is a test-only production API that clears this registry and image promise. This contradicts Gate 4’s deletion of “process registry/definition ownership,” ADR-034’s “no mutable application definition registry,” and the retained status claim that one sandbox per provider is defined at module load. Exact policy keys avoid accumulated tenant host lists, but spec-match of the policy does not make the application registry an accepted lifecycle owner.

2. **The retained warm-turn budget remains incomplete.** The accepted Gate 4 closure here is only: zero GitHub calls, at most one native attach, and no provider/definition creation; I do not require the Gate 6 20-warm/5-cold surface harness. The new quota assertion proves one image inspection and one provider construction across setup/two turns/recovery. The 20-sample resolver test proves only resolver p95 and zero fixture GitHub requests. Nothing counts `provider.resume`/attach, and no composed warm Send assertion observes resolver GitHub calls, attach count, and provider/definition creation together. The native patch comment “Keep the warm path to one provider attach” is implementation, not retained proof.

3. **OTEL still has a conversation-keyed process owner and the new overlap test misses the race.** `turns` is keyed by run, but proxy events call `turnForConversation`, which consults `activeTurnId: Map<conversationId, turnId>`. Both the legacy prepare token and native run capability expose `conversationId`, not `runId`; `workspace-chat-openai.ts` therefore cannot select the originating run. The committed test records run A’s generation before starting run B, so it never interleaves proxy completions. Current production runtime reproduces the defect: with A and B active, a completion belonging to A is assigned to B. This remains a parallel, process-local turn lifecycle beside TanStack’s OTEL middleware and violates the required concurrent-send telemetry ownership.

4. **The exact reviewed SHA does not yet have completed full CI.** The Gate 4 protocol and `remaining.md` require full CI green on the final SHA before closure. Run `34416709719` is still in progress.

## Simplicity

### Job

Own one conversation’s stock TanStack chat and native sandbox across turns, replicas, and restarts, while Files/publish remain focused native-Git commands.

### Thinnest machine

Thin authenticated HTTP/WebSocket/MCP adapters call one stock `chat` construction. TanStack `defineSandbox`, the provider, Postgres instance/lock stores, native persistence, OpenCode, and native Git own lifecycle and state. Runtime Workspace policy is passed to that native owner; observability is run/request scoped through TanStack/OTEL context. Application code owns only authorization, immutable revision input, credential brokering, error translation, and publish policy.

### Blocking leftover machinery

1. `dockerChatSandboxes`, `dockerImageInspect`, and `workspaceChatDockerOwnership` form a new unbounded definition/config cache plus a test-control surface in the central chat module. The thinnest machine does not need an application policy-to-definition registry; the native provider/definition seam must own runtime policy without rebuilding or interning definitions in ctxpipe.
2. `turns` plus `activeTurnId` is a custom process-local telemetry state machine. It manually starts, mutates, correlates, summarizes, and ends spans even though `otelMiddleware` already participates in the stock chat. Because the proxy lacks run identity, this machinery is not merely redundant; it is wrong under overlap.

### Confirmed deletions / non-findings

- The old sandbox registry, memo, health helper, OpenCode port lease, assistant-text filter, manual persisted-run completion, and dynamic TanStack loader are deleted.
- No `ConversationSession`, `ChatEngine`, `WorkspaceJobRunner`, `SandboxLease` facade, Railway SDK/provider, production nested-forward helper, second default-branch writer, or agent-held push credential was found.
- The large native package patches remain costly, but ADR-034 records their exact contracts and deletion conditions. I do not reopen them as a separate blocker.
- Railway fail-closed behavior, the scripted quota-Docker fixture, focused credential renewal, test-only nested forwards, and deferral of the complete 20/5 measurement harness are accepted closures.

**Simplicity: 2 blockers; the remaining native package-patch maintenance risk is nonblocking.**

## Verdict

**BLOCKED**

Remaining blockers before `CLOSE_GATE_4`:

1. Remove the application-owned Docker definition registry/test reset surface while preserving exact per-workspace policy, one native definition owner, and no warm rebuild.
2. Retain one composed warm-turn budget proof that asserts zero GitHub calls, at most one provider resume/attach, and zero provider/definition creation. Do not expand this into the Gate 6 20/5 surface harness.
3. Remove the process-global OTEL turn maps or propagate an unambiguous run-scoped identity/context through the model proxy; add a genuinely interleaved two-run regression.
4. Obtain green full CI for exact HEAD `058a4a3bd89e58a0e904a51c89e4ae7e7124d418`.
