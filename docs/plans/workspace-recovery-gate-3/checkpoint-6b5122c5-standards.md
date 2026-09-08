# Gate 3 semantic handoff checkpoint — Standards review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6b5122c56dbd838e6e8b7395455f939acf1eb775`
**Decision:** changes requested — 2 documented-standard findings (1 P1, 1 P2), 1 Fowler heuristic finding.

## Documented-standard breaches

### [P1] Hydrate the canonical tip before completing a converged handoff

`apps/backend/src/openworkflow/workflows/workspace-semantic-merge.ts:150-165,193-205` marks a semantic job complete when its captured delta is already present, without enqueueing `workspaceHydrate`. Ten mechanical parents then copy that no-op to their own completed row (for example `workspace-file-edit.ts:187-203`) and return. The refresh persisted the concurrently advanced desired SHA, so if its external webhook is absent/delayed, the active projection can remain at the old revision after both jobs are terminal. Migration export explicitly supplies the missing sequence at `workspace-migration-export.ts:227-253`; the common child should do the same for every handoff. ADR-033:18 says completion requires a durable hydrate enqueue and hydration must use the canonical default revision.

### [P2] Make provider selection durable before resource allocation

`sandbox-provider.ts:38-51` probes Docker on every call, while `semantic-merge.ts:32-48` both chooses the provider and allocates it inside the replayable `create-merge-sandbox` step. If allocation succeeds but its acknowledgement is lost and Docker reachability changes before retry, replay switches between Docker and local-process. The stable provider-specific ID can no longer find the first resource, which is orphaned. Persist provider discovery in its own durable step (or use immutable configuration), then allocate with that recorded value. This conflicts with ADR-033:16’s explicit replay-safe resource lifecycle and the accepted plan at `workspace-chat-recovery.md:302-305`. The bounded no-Docker fallback itself works; declared Railway/sbx work is excluded.

## Heuristic smell (judgement call)

**Possible Shotgun Surgery / Feature Envy:** `workspace-semantic-merge.ts:47,65-74` imports mirror validation from `workspace-connector-mirror.ts`, which now imports the semantic workflow at line 43, creating a workflow-to-workflow cycle. Move the shared mirror command schema beside `connectorMirrorSourceSchema` in the domain module.

## Verified

The exact delta, binary bytes, deletions, mirror identity, current-tip parenting, replayable parent result, resolved no-op, export cutover and finite Docker probe are otherwise coherent. The supplied 58-check/type evidence was inspected, not rerun. The acknowledged unfinished work and prior unbounded-history finding were not repeated.
