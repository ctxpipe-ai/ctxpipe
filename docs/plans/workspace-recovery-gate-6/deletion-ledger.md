# Gate 6 deletion ledger

| Retired owner / characterization | Retained behavioral oracle |
| --- | --- |
| `WorkspaceChatSession.test.tsx` compose/chrome/`useChat` harness | Production compose is `WorkspaceChat` collection POST; `LateErrorDoesNotClobberSuccess`, thread stories, and `WorkspaceChatChrome` stories own the paint |
| `WorkspaceChatChrome.test.tsx` static jsdom chips | `WorkspaceChatChrome.stories.tsx` ReadOnly / PendingProbe / DirtyCommitPush / CreatingPr / ShowPr |
| Session story `ComposeEmpty` | `WorkspaceChat.stories.tsx` `ComposeEmpty` — session is the hydrated thread only |
| Gate 2–4 already-deleted registries (`sandbox-registry`, sandbox health/memo, `write-runner`, `write-job-agent`, `tanstack-runtime`, assistant-text repair, OpenCode port helper) | Native TanStack `defineSandbox` + Postgres instance store, typed OpenWorkflow writes, stock `chat` HTTP/WebSocket |

## Kept on purpose

| Item | Why it stays |
| --- | --- |
| `desired_sha`, `active_projection_url` / `active_projection_sha`, sandbox-instance desired columns | ADR-032 temporary mappings. Drop only after upgrade proof shows no legacy rows |
| `ws:<workspaceId>` checkout key + `legacyWorkspace` JWT | Migration read path. Codesearch still accepts the signed legacy claim |
| `dockerChatSandboxes` intern + `workspaceChatDockerOwnership` counters | Gate 4 native quota/image-inspect contracts still observe these counts. Not a second lifecycle owner |
| Pierre `insertText` host on the files pane | Required Storybook plays drive the real Pierre editor through that handle |
| Remaining mocked backend characterization (`conversation-files.test.ts`, `workspace-lifecycle.test.ts`, …) | Native contracts do not yet own every oracle those files record |

## Positive ledger

Competing runtime owners from PR 280 are gone. This slice removes the last
compose-on-session jsdom characterization. Net production LOC in
`domain/workspaces` and `features/workspaces` is still above Gate 0 because
native contracts and revision identity replaced thinner mocks. Owner count
is the score that moved, not raw line count.
