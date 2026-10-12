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

## Security review of backend git in the sandbox (2026-10-12)

Result: no issue above Low. The fix is not needed on `main`, because `main` has no sandbox git credential code.

- The write token stays in the backend. `brokerPush` (`conversation-publish.ts`) reads only a pack of objects from the sandbox. It then pushes from a backend temporary directory to the remote URL in the database.
- On `vercel` and `docker`, the sandbox read token is empty. The firewall or Agent Vault adds it outside the sandbox, for GitHub hosts only.
- A program that the repository config starts in the sandbox runs with the same rights as the agent. It gets no new secret. More deny entries in `SANDBOX_GIT_GUARD` add no protection.

Optional hardening (Low; not scheduled):
- Run `nativeGit` (`services/git/pack.ts`) with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`. Then the git config of the backend host cannot change a push that holds the write token.
- Make the `SANDBOX_READ_GIT` helper answer only for `host=github.com`, or fetch the explicit clone URL. This matters only for the `unsandboxed` provider, which has no isolation by design.
