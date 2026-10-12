# CTX-543: Record a Sync in the chat thread

Status: done on the branch `feat/ctx-543-sync-thread-entry`.

Decision (CTO, option 1): after a successful Sync, the thread shows an entry
after the last turn, with a link to the branch on GitHub. The entry stays in
the conversation history. A successful Sync has no toast. The failure toast
stays.

## Change

- Storage: `apps/backend/src/models/conversation-syncs.ts` keeps each Sync in
  the chat metadata table (namespace `ctxpipe.conversation-syncs`, key
  `<conversationId>:<sha>`), as the turn changes do. There is no new column,
  table or migration. The record has the branch, the pushed commit, the number
  of changed files, the GitHub tree URL, the user turn and the time. The
  values go through `maskCredentialsDeep` before they are stored. A deleted
  conversation deletes its syncs.
- Backend: `pushConversationSession` takes `recordSync`. Only
  `POST /conversations/{id}/push` sets it. The record is written only when the
  push succeeds; a Sync with nothing to push writes nothing. A failure to
  write the record is logged and does not fail the push. The file count is
  `git diff --name-only` from the commit that the push builds on (the remote
  tip, else the default commit) to the pushed commit.
- `GET /conversations/{id}/turns` returns `syncs` next to `items` (Zod and
  OpenAPI).
- Model input: the record is not a message, so the model never sees it.
- UI: `ConversationSyncEntry` shows "Synced N files to <branch>" in the
  turn-changes card style. `placeSyncs` puts it after the last shown message of
  its user turn. The branch link opens in a new tab with the external-link cue
  from CTX-546. A successful Sync invalidates the turn-changes query.

## Tests

- `conversation-publish-native.contract.test.ts` (real Postgres, Git and the
  fixture GitHub): a Sync writes one record with the file count, branch,
  commit and turn; a second Sync with nothing new writes none; the stored
  thread (the model input) does not contain it.
- `conversationDiff.test.ts`: `placeSyncs` placement.
- Story `Pages/Workspaces/SyncAddsThreadEntry` (golden): Sync, then the entry
  shows after the last reply, with the link, and no toast.

## Open points

- An agent push (`push_conversation_branch`) and Create PR do not write a Sync
  record. Only the user's Sync button does.
