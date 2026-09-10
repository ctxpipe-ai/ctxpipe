# ctxpipe Gate 4 — Independent Cumulative Reviewer B Re-review 3

**Verdict: CLOSE_GATE_4**

**Fixed point:** `20cf0791c4467aacd5719ad58ee39593515300eb`
**Reviewed HEAD:** `f8e4fae903ec70d482a12629ed2e59f5ec2ce5ef`
**Diff:** `git diff 20cf0791...HEAD`

This verdict closes the three code-review axes. Full CI on this exact HEAD is a separate closure requirement and was still in progress when inspected. I did not read reviewer-a files.

## Executive result

Both prior blockers are fixed.

1. The retained native two-turn contract now measures the complete second Send, requires it to finish in under five seconds with useful text, observes at least one existing native instance-row lookup, and rejects a new instance row or Docker provider construction. The quota-Docker journey now also performs a warm Send against the prepared live sandbox before provider destruction and recovery.
2. Workspace-chat telemetry no longer has `activeTurnId` or a conversation-to-current-run lookup. The run ID is carried in the signed chat/run tokens, the proxy derives the exact key with `workspaceChatTurnId(token)`, and both generation start and completion use that key. The overlap regression starts B before recording A and verifies both results remain on their own runs.

No blocking Standards, Spec, or Simplicity finding remains.

## Prior blocker verification

### 1. Composed warm Send proof — fixed

`workspace-chat-native.contract.test.ts` now composes prepare, a first native HTTP Send, and a second native Send on one persisted conversation:

- It starts the timer immediately before consuming the second `streamTanstackWorkspaceChat` response and asserts elapsed time is `< 5_000`.
- It requires exactly `Native reply completed.` and one successful terminal event.
- It snapshots native-instance create/get counters immediately before the second Send, then asserts no create increase and at least one existing-row hit.
- It resets and checks Docker-definition ownership, requiring no Docker provider construction in this native local-process journey.
- After each turn it checks that the sole persisted row still names the prepared handle, and the unsaved file survives both turns.

The focused test passed locally: 1/1, with the full test body completing in 5.586 seconds. The second Send necessarily satisfied its internal `<5s` assertion.

The quota-Docker journey now adds a warm Send after its first successful chat and before `first.handle.destroy()`:

- It reloads the persisted transcript and streams useful text.
- It asserts no increase in Docker provider creation or image inspection.
- It asserts no new instance row and at least one existing-row hit.
- It remains on the original prepared sandbox through that warm Send; provider loss and allocation of a different recovered handle happen only afterward.

The quota test retains a 30-second Docker-specific ceiling rather than the five-second local native ceiling. That is acceptable for the composed proof: the native second Send owns the Gate 4 `<5s` oracle, while the quota/Btrfs contract owns production Docker same-sandbox reuse and isolation. This host lacks the quota-runner environment, so the amended quota journey was not executed locally; exact-HEAD CI remains responsible for it.

### 2. Run-scoped OTEL and overlap ordering — fixed

The attribution path is now exact:

- `workspace-chat-otel.ts` contains one `turns` map keyed by turn/run ID and no `activeTurnId`.
- `WorkspaceChatTokenSchema` and `RunCapabilityClaimsSchema` carry optional `runId`; both minting paths receive the chat input's run ID.
- The model proxy verifies the token, calls `workspaceChatTurnId(token)`, then passes that same key to `beginWorkspaceChatProxyGeneration` and `recordWorkspaceChatProxyCompletion`.
- `recordWorkspaceChatProxyGeneration`, first-token marking, and turn finish perform direct keyed lookup only; there is no conversation-keyed fallback map.
- The overlap test begins run A, begins run B, records A after B has begun, records B, and asserts `response-from-run-a` and `response-from-run-b` remain separate.

Focused validation passed locally:

- OTEL overlap/summary: 2/2.
- OpenAI proxy route and proxy URL tests: 8/8.
- The native two-turn contract traversed the real app/model-proxy fixture and passed.

## Standards

**Result: PASS — 0 blockers.**

- The correction follows backend logging rules; no direct `console.error`, `console.info`, `console.log`, or `console.warn` remains under `apps/backend/src`.
- The proxy route remains an OpenAPI Hono route and uses the request-scoped evlog logger.
- Token payload changes are Zod-validated and preserve existing signed-token verification.
- Focused Biome checks passed for all ten corrected backend files.
- `git diff --check 058a4a3b...HEAD` passes when the two historical review-report payloads are excluded.
- Searches found no restored `activeTurnId`, sandbox registry/memo, `ChatEngine`, `SandboxLease`, or `WorkspaceJobRunner`.

Nonblocking judgment: `workspaceChatInstanceAccess` and the earlier `workspaceChatDockerOwnership` are mutable, test-visible counters exported from production modules. The new create counter also performs an extra row lookup before instance upsert. They are observation hooks, not competing ownership or lifecycle state, and do not invalidate this gate, but a later cleanup should decorate/inject the instance store in tests instead of retaining test probes and test-only database work in production.

## Spec

**Result: PASS — 0 blockers.**

The prior missing acceptance oracles now cover the requested facts:

| Requirement | Result |
| --- | --- |
| Native second Send completes with useful text in `<5s` | PASS |
| Warm Send performs no new instance-row creation | PASS |
| Warm Send observes an existing native instance row | PASS |
| No repeated Docker provider/definition construction | PASS |
| Quota-Docker journey includes same-sandbox warm Send | PASS in retained code; exact-HEAD CI pending separately |
| OTEL has no conversation-current-run map | PASS |
| Proxy derives telemetry key from `workspaceChatTurnId(token)` | PASS |
| Overlap test records A after B starts | PASS |
| A and B generation records remain separate | PASS |

The broader 20-warm/5-cold Gate 6 measurement remains outside this Gate 4 re-review.

## Simplicity

**Result: PASS — 0 blockers; 1 nonblocking cleanup.**

**Job:** retain one native conversation sandbox and transcript owner across warm sends while binding observations to the exact run.

**Thinnest machine:** stock TanStack chat/sandbox/persistence; PostgreSQL native instance and lock stores; one policy-keyed Docker definition; signed run capability; one run-keyed OTEL state map.

The correction removes the demonstrably wrong conversation-to-active-run map rather than layering another resolver over it. The warm proof observes the existing native store and Docker-definition seams; it adds no sandbox owner, handle cache, lease facade, runner, or terminal-repair path.

The only leftover is test-visible global counter instrumentation. It should eventually move to a test-side observer/decorator, but it is not an ownership mechanism and does not block Gate 4.

## Verification

Passed locally:

- `pnpm --filter @ctxpipe/backend exec vitest run src/domain/workspaces/workspace-chat-otel.test.ts` — 2/2.
- Native two-turn test filtered from `workspace-chat-native.contract.test.ts` — 1/1; 5.586-second test body.
- `workspace-chat-openai.test.ts` plus `workspace-chat-model-proxy.test.ts` — 8/8.
- Focused Biome check — 10/10 files clean.
- Correction-delta whitespace check — clean, excluding retained review-report payloads.

Not rerun locally:

- The quota-Docker/Btrfs journey requires the dedicated quota runner. Its amended test is retained, but successful execution on this exact HEAD belongs to CI.

## CI closure status

At inspection time, exact-HEAD CI run [34418188719](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34418188719) was `in_progress`. That run later failed two quota-Docker contracts (cached rejected image inspect; OpenCode HostPort colliding with the quota Docker API). Follow-up `79670977` is green on CI [34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470) (contracts 334/334), which satisfies the CI prerequisite for the `Gate 4:` commit.

## Final verdict

**CLOSE_GATE_4**

Standards: 0 blockers. Spec: 0 blockers. Simplicity: 0 blockers. CI prerequisite met on `79670977` / `34421467470`.
