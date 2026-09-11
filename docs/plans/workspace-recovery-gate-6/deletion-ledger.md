# Gate 6 deletion ledger

| Retired owner / characterization | Retained behavioral oracle |
| --- | --- |
| `WorkspaceChatSession.test.tsx` compose/chrome/`useChat` harness | Production compose is `WorkspaceChat` collection POST; `LateErrorDoesNotClobberSuccess`, thread stories, and `WorkspaceChatChrome` stories own the paint |
| `WorkspaceChatChrome.test.tsx` static jsdom chips | `WorkspaceChatChrome.stories.tsx` ReadOnly / PendingProbe / DirtyCommitPush / CreatingPr / ShowPr |
| Session story `ComposeEmpty` | `WorkspaceChat.stories.tsx` `ComposeEmpty` — session is the hydrated thread only |
| Gate 2–4 already-deleted registries (`sandbox-registry`, sandbox health/memo, `write-runner`, `write-job-agent`, `tanstack-runtime`, assistant-text repair, OpenCode port helper) | Native TanStack `defineSandbox` + Postgres instance store, typed OpenWorkflow writes, stock `chat` HTTP/WebSocket |
| `workspace-chat-send-runtime.test.ts`, `enqueue-workspace-tip-check.test.ts`, create/reuse/enqueue cases in `ensure-org-repository.test.ts`, stream/`reconstructChat`/AG-UI cases in `conversations.test.ts`, files-pane/unlink/create-enqueue cases in `workspaces.test.ts`, TanStack/load-thread cases in `workspace-history.test.ts` | Already-owned natives: `workspace-chat-prepare-native.contract.test.ts`, `workspace-tip-check.contract.test.ts`, `write-export-native.contract.test.ts`, `repository-ingestion-owner-native.contract.test.ts`, `workspace-chat-native.contract.test.ts`, `conversation-publish-native.contract.test.ts`, `workspace-files.contract.test.ts`, `write-link-native.contract.test.ts` |
| `project-workspace-commits.test.ts`, `enqueue-workspace-commit-projection.test.ts`, `workspace-activity-routes.test.ts` | `workspace-commit-activity-native.contract.test.ts` (Postgres projection rows + `workspaceHttpApp` GET). `commit-activity.test.ts` stays as the pure calendar unit |
| `workspace-lifecycle.test.ts`, `bind-github-connection.test.ts`, Select/Paste HTTP mocks | `workspace-lifecycle-bind-native.contract.test.ts` plus `github_connection_id` backfill on `repository-ingestion-owner-native.contract.test.ts` |
| Remaining `workspaces.test.ts` list/404/touch/retry-prepare/leftover-sandbox cases | `workspace-http-native.contract.test.ts` on `workspaceHttpApp` + real workspace rows |
| Remaining `conversations.test.ts` list/scope/idempotency cases | `workspace-chat-native.contract.test.ts` collection POST + list/GET |
| `conversation-files.test.ts` fakeHandle argv log | Real temp worktree: session-branch checkout skip, PATH inherited (no empty `env`), tracked+untracked list, version fingerprint. `sanitizeGitRemoteError` / `fingerprintConversationWorktree` stay Tier 1 string units |

## Kept on purpose

| Item | Why it stays |
| --- | --- |
| `desired_sha`, `active_projection_url` / `active_projection_sha`, sandbox-instance desired columns | ADR-032 temporary mappings. Drop only after upgrade proof shows no legacy rows |
| `ws:<workspaceId>` checkout key + `legacyWorkspace` JWT | Migration read path. Codesearch still accepts the signed legacy claim |
| `dockerChatSandboxes` intern + `workspaceChatDockerOwnership` counters | Gate 4 native quota/image-inspect contracts still observe these counts. Not a second lifecycle owner |
| Pierre `insertText` host on the files pane | Required Storybook plays drive the real Pierre editor through that handle |
| Pure Workspace helpers (no owned-seam `vi.mock`) | `repositoryNameFromGitUrl`, workspace-history parse / `workspace_required`, `commit-activity` calendar math, `sanitizeGitRemoteError` / `fingerprintConversationWorktree`. `sandbox-provider.test.ts` stays as detect + third-party destroy routing |

## Positive ledger

Competing runtime owners from PR 280 are gone. This slice removes the last
compose-on-session jsdom characterization. Net production LOC in
`domain/workspaces` and `features/workspaces` is still above Gate 0 because
native contracts and revision identity replaced thinner mocks. Owner count
is the score that moved, not raw line count.
