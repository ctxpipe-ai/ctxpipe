# Coverage ledger — Gate 3 paused-write Standards review

## Review identity

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed commit: `e9f12641bd7a8cf9292db13a84f1c7199b982bc5`
- Merge base verified as the fixed base. The 15-commit `base..target` log was enumerated.
- All product reads used `git show e9f12641:<path>`, `git grep ... e9f12641`, or pinned diffs. The moving worktree was not read.
- The cumulative diff was scanned; the focused increment was `a6273f0c...e9f12641` (36 backend/UI source and test files, +1436/-369, plus ADR/status/evidence artifacts).
- No repository mutation, branch operation, test execution, or network call was performed.

## Standards sources read

- `AGENTS.md`: architecture/ADR precedence, backend logging, proof requirement.
- `apps/backend/AGENTS.md`: short transactions, OpenAPI/Zod, strict TypeScript, evlog-only logging, real proof seams.
- `apps/ui/AGENTS.md` and `.cursor/skills/react/SKILL.md`: TanStack Query, effect discipline, UI capability/data flow.
- `.cursor/skills/tdd/SKILL.md` and `mocking.md`: public behavior seams and owned-collaborator proof.
- `.ai/memory/decisions/ADR-027-short-org-sql-unique-sandbox-rows.md`: no SQL connection across remote I/O.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md`: explicit typed steps, immutable command/candidate ownership, full-binding CAS, native waits, protection/session-branch distinction.
- `docs/plans/workspace-recovery-gate-3/status.md` and `write-path-audit.md`: checkpoint evidence and explicitly open scope.
- Full Fowler baseline applied: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.

## Changed production surface inspected

### Admission, persistence, broker

- `models/workspaces.ts`: `WorkspaceWriteProbeBinding`, atomic admission read, seven-field `persistWriteStatus` CAS.
- `models/workspace-write-jobs.ts`: paused listing/claim, immutable bound command, prepared SHA, semantic-child validation.
- `domain/workspaces/write-command.ts`: nullable acquisition result and same-binding captured-SHA acquisition.
- `domain/workspaces/write-broker.ts`: protection/permission classification, read-before-write credential sequence, final admission, paused broker result, prepared-commit recovery.
- `openworkflow/enqueue-workspace-write-commit.ts`: persisted probe result observation, captured revision reuse, exact typed dispatch.
- `openworkflow/workflows/workspace-tip-check.ts`: CAS-aware periodic probe and paused-job claim outside provider I/O.
- Legacy `workspace-write-commit.ts` call-site adaptation was checked but remains explicitly tracked for deletion.

### All twelve typed workflow callers

Each caller of both `acquireWorkspaceWriteRevision` and `attemptWorkspaceCommit` was traced. Each has an explicit `pause-command`/one-minute acquisition wait and `pause-push`/one-minute broker wait, preserving `input`, `revision`, owner, and `committed` pack across the wait:

1. `workspace-bootstrap.ts`
2. `workspace-claims-upgrade.ts`
3. `workspace-connector-mirror.ts`
4. `workspace-extract-ingest.ts`
5. `workspace-file-edit.ts`
6. `workspace-import-key-cleanup.ts`
7. `workspace-link-unlink.ts`
8. `workspace-migration-export.ts`
9. `workspace-ops-folder-map.ts`
10. `workspace-rename-rewrite.ts`
11. `workspace-semantic-merge.ts`
12. `workspace-valid-from-persist.ts`

Semantic handoff accepts an active paused parent, does not replace job/result ownership, and keeps the candidate until an actual tip race requires exact-candidate release.

### Conversation policy, API, runtime, UI

- `chat-sandbox-policy.ts` and `chat-lifecycle.ts`: exact protected-default reason allows only conversation-session behavior; repository permission denial remains denied.
- `workspace-chat-turn-runtime.ts`: turns the derived conversation capability into the sandbox/runtime write policy while retaining read credentials.
- `conversation-files-routes.ts`: attach/branch setup, file mutation, and push enforce the same server predicate.
- `conversations.ts`: PR publication passes `readOnlyReason` through both policy layers.
- `workspaces.ts`: OpenAPI `WorkspaceSchema` requires `conversationWritable`; central serializer supplies it to list/create/detail/update/retry responses.
- UI `types.ts`, `conversationPublish.ts`, `WorkspaceChatSession.tsx`, and `WorkspacePane.tsx`: server capability reaches chat actions, pane actions, and sandbox file editor; older-response fallback remains conservative.

## Interface/caller trace

- `persistWriteStatus`: broker, enqueue probe, periodic tip check, legacy runner, and native contracts inspected. New callers supply the complete observed binding; enqueue/tip-check observe CAS failure.
- `getWorkspaceWriteAdmission`: acquisition, initial/final broker admission, and no-op validation inspected.
- `workspaceAllowsConversationEdits`: runtime, route mutation/push/PR checks, serializer, branch checkout, and policy adapter inspected.
- `conversationAllowsEdits`: all three UI call sites plus pure helper tests inspected.
- `Workspace.conversationWritable`: schema/serializer and every UI consumer found by pinned symbol search inspected.

## Proof/evidence inspected (not rerun)

- `write-pause-native.contract.test.ts`: captured-SHA replay, acquisition wait, stale probe CAS, protected prepared candidate.
- `protected-conversation-native.contract.test.ts`: real Hono/PostgreSQL/local-process sandbox edit behavior and authoritative capability.
- `write-workflow-native.contract.test.ts`: detach during credential issuance and lost push acknowledgement.
- `github-workspace-tip.test.ts`: MSW only at third-party GitHub boundary; repository-scoped read token and app-auth installation fallback.
- `chat-lifecycle.test.ts`, session-policy tests, route tests, and UI `conversationPublish.test.ts` caller behavior.
- Committed status records native 46 + typed-maintenance 39 passing, backend 141/UI 230 acknowledged diagnostics, policy 443/27, scoped Biome 36 files, session policy 17, and UI helper 5. CI `34246462358` was still running at the pinned checkpoint.

## Declared open scope excluded from findings

The alternate connector/conversation writers and unrestricted credentials, remaining automatic planning, full legacy runner deletion, and the other items in the pinned audit/status remain open Gate 3 work. Their omission was not treated as a checkpoint regression or acceptance claim.

## Finding disposition

- Documented breaches: 1 (`write-pause-native.contract.test.ts` direct `console.info` at lines 237 and 461).
- Fowler heuristic smells: 0. Explicit per-workflow wait repetition is required by ADR-033 and was suppressed under the repository-overrides rule.
- Implemented-scope product blockers: 0.
