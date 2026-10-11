# CTX-528: A file read during a chat turn waits for the turn

Status: fixed on the PR branch.

## Cause

A turn holds the `chat-thread:{id}` lock until its reply ends. CTX-514 made `GET files/tree` and `GET files/status` answer `409 turn_running` at once. `GET files/blob` still waited for the lock in `withConversationFileLock`. The UI fetch stops after 30 s and shows an error.

A read cannot simply skip the lock. Its normal attach (`readySandboxHandle` with `existingOnly`) goes through the stock `ensureExisting`. That call sets the workspace secrets on the handle and updates the sandbox record. On Vercel, the provider `resume` also renews the GitHub access and sets the sandbox firewall policy. A read that does this while a turn runs can change the turn's sandbox.

## Fix

- `GET files/blob` tries the lock. When the lock is free, the read is as before.
- When a turn holds the lock, the read attaches to the turn's sandbox with `attachTurnSandboxForRead` (`domain/workspaces/conversation-files.ts`). This is a plain attach: Docker and Vercel use `attachProviderSandbox` (the sweep's attach), local-process uses the stock `resume`. It does no setup, sets no secrets, changes no firewall or token, and writes no record.
- Other holders also take the lock: the idle sweep, the sandbox stop, the token revoke backstop, and publish. Thus the read attach uses only a `live` row, and it never starts or resumes a sandbox (`onlyRunning`: Docker attaches only to a running container; Vercel uses `resume: false` and needs status `running`). When nothing runs, the read answers `409 turn_running` at once, and the pane polls again. The attach uses the request abort signal.
- The read itself (`git ls-files` and a file read) does not write the index, so it is safe while the agent writes.

`PUT files/blob` and `GET files/diff` still wait for the lock. The diff uses the full prepare, which can move the sandbox to a new commit.

## Tests

- `apps/backend/src/routes/v1/conversation-files-turn-read.contract.test.ts`: real Postgres, real Git, local-process sandbox. A test holds the turn lock. The blob read answers 200 in less than 3 s with the current content, also after the agent changes the file. Before the fix, the read waited and stopped at the 5 s request timeout.
- The same contract test: a `stopped` row, and a `live` row whose sandbox does not run, answer `409 turn_running` at once.
- `apps/backend/src/domain/workspaces/sandbox-attach-native.contract.test.ts` (real Docker): `onlyRunning` attaches to a running container, returns null for a stopped one and leaves it stopped; the sweep attach still starts it.
- `vercel-sandbox.contract.test.ts` (live Vercel, not run locally): `onlyRunning` returns null for a stopped sandbox and does not resume it.
