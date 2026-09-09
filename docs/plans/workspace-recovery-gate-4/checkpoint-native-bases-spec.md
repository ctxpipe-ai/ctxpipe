# Gate 4 base/live-transition final spec check

No blocking findings.

1. Repair recovery re-reads the current desired revision after the retained transition (`apps/backend/src/domain/workspaces/tanstack-workspace-chat.ts:482-496`), uses that target in the notice, and suppresses the notice when the retained SHA is current (`:487-490`). The native transition path independently re-reads and validates the full desired binding before Git ownership moves (`workspace-chat-revision-transition.ts:35-42`).

2. Files locking covers both `/:conversationId/files/*` and `/:conversationId/push` (`apps/backend/src/routes/v1/conversation-files-routes.ts:423-425`). A single request/lease controller is installed at `:408-417`, passed through `loadConversationWorkspace`, `warmTanstackWorkspaceChat`, and `adaptTanstackHandle` (`:299-307`, `:347-367`), so existing-handle exec and FS calls receive the signal. The Docker patch forwards it through read/write/mkdir/remove and the native exec path (`patches/@tanstack__ai-sandbox-docker@0.3.2.patch:1197-1257`).

3. Base GC compares the persisted base image with the current provider image before replacement (`apps/backend/src/domain/workspaces/workspace-sandbox-cleanup.ts:47-75`), while retaining any base whose snapshot still has a live owner (`:38-46`). The image is persisted by the sandbox instance store/schema path (`tanstack-workspace-chat.ts:688-694`, `models/workspace-sandboxes.ts:83-88`, `db/schema/workspaces.ts:248-253`).

This checkpoint is closed; broader provider/security/quoting review remains outside scope.
