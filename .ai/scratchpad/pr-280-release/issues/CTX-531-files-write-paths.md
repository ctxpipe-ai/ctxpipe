# CTX-531: Files write rules and backend git settings

Status: done on `fix/ctx-531-files-put-git`. The conversation Files routes and the chat sandbox are not on `main`.

## Rules

- A Files write, rename, or delete changes only worktree files. It uses the same rule as the Files read, but a new file is permitted. The path cannot be in `.git` at any depth, and no part of the path can be a symlink.
- Backend git commands in a sandbox ignore programs that the repository defines. The rule applies to hooks, the fsmonitor, the external diff, textconv, filter drivers, and merge drivers. A merge driver becomes `git merge-file`, the built-in text merge.

## Implementation

- `assertConversationPathWritable` in `apps/backend/src/domain/workspaces/conversation-files.ts`.
- `SANDBOX_GIT_GUARD` in `apps/backend/src/domain/workspaces/job-sandbox.ts`. `adaptTanstackHandle` and the direct sandbox git calls add it before each command. Each backend `git diff` uses `--no-ext-diff --no-textconv`.

## Tests

- `conversation-files.test.ts`, block "conversation sandbox writes", uses real git. It covers the path rules, normal writes (new, nested, and existing files), and a repository with configured programs. Backend status, diff, and rebase commands do not run these programs.
- Two contract tests do not use sandbox hooks now. A failed commit comes from an index lock. The push barrier is a hook on the fixture remote.

## Follow-ups

- None for this ticket. `workspace-chat-prepare-native` has two Docker cases that also fail on the base commit 833fe29b.
