# CTX-543: Record a Sync in the chat thread

Status: done on the branch `feat/ctx-543-sync-thread-entry`.

Decision (CTO, option 1): after a successful Sync, the thread shows an entry
after the last turn, with a link to the branch on GitHub. The entry stays in
the conversation history. A successful Sync has no toast. The failure toast
stays.

## Change

- Storage: `apps/backend/src/models/conversation-turn-changes.ts` keeps each
  Sync in the chat metadata table (namespace `ctxpipe.conversation-syncs`, key
  `<conversationId>:<sha>`), next to the turn changes. There is no new column,
  table or migration. The record has the branch, the pushed commit, the number
  of changed files, the GitHub tree URL, the user turn and the time. The
  values go through `maskCredentialsDeep`, because the tree URL comes from the
  remote URL. A second push of the same commit keeps the first entry. One call
  deletes the turn changes and syncs of a deleted conversation.
- Backend: `pushConversationSession` returns `files`: `git diff --name-only -M`
  from the commit that the push builds on to the pushed commit. A rename is
  one file, as in the turn card. The route `POST /conversations/{id}/push`
  writes the record after a successful push and counts the user turns. A Sync
  with nothing to push writes nothing. A failure to write the record is logged
  (`conversation-sync-record`) and does not fail the Sync.
- `GET /conversations/{id}/turns` returns `syncs` next to `items` (Zod and
  OpenAPI).
- Model input: the record is not a message, so the model never sees it.
- UI: `ConversationSyncEntry` shows "Synced N files to <branch>" in the
  turn-changes card style. `placeThreadRecords` places the turn cards and the
  syncs in one pass. The branch link opens in a new tab with the external-link
  cue from CTX-546. A successful Sync invalidates the turn-changes query.

## Tests

- `conversation-branch-push-native.contract.test.ts` (route, Docker sandbox,
  real Postgres): two Syncs write two records; Create PR and a Sync with
  nothing to push write none.
- `conversation-publish-native.contract.test.ts`: the file count, and a rename
  counts as one file.
- `conversation-turn-changes.integration.test.ts`: the same commit keeps its
  first entry, masking, org isolation, delete.
- `conversationDiff.test.ts`: placement.
- Story `Pages/Workspaces/SyncAddsThreadEntry` (golden): Sync, then the entry
  shows after the last reply, with the link, and no toast.

## Every push (CTO follow-up)

Each push that puts conversation commits on GitHub writes one record through
the same model, with a `trigger`:

| Path | Trigger | Entry |
| --- | --- | --- |
| `POST /conversations/{id}/push` (Sync) | `sync` | Synced N files to `branch` |
| `POST /conversations/{id}/pull-request` (Create PR; also when it updates an open PR, and when the PR fails to open after the push) | `create_pr` | Pushed N files to `branch` and opened PR #n / for PR #n |
| Agent tool `push_conversation_branch` | `agent` | The agent pushed N files to `branch` |
| `pushBeforeSandboxDelete` (sweep, retry, rescue to the next branch) | `sweep` | ctx\| pushed N files to `branch` |

The Workspace write broker pushes only to the default branch (mirrors,
extraction, bootstrap), not conversation commits, so it writes no record.
Create PR without a push (the branch is already on GitHub) writes no record.
