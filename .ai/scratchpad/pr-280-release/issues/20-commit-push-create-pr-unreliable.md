# Commit+Push is unreliable and Create PR does not work

Status: open: confirm the Create PR cause on the preview
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-07
Updated: 2026-10-07

## Context

On the pr-280 preview, in a Workspace chat conversation with changes, the user pressed Commit+Push. It failed some times and then worked. Create PR after that did not work at all. The user did not see an error message.

## Cause

1. **Commit+Push answered 409 turn_running when no turn ran.** The Railway HTTP log shows `POST …/push 409` in 73 ms at 08:42:13 UTC. In the same second, `files/status`, `files/tree` and `files/blob` held the conversation lock (`sandbox lifecycle lock-wait 2677ms`, `2431ms`). The Files reads (`withConversationFileLock`, `routes/v1/conversation-files-routes.ts`) and the sandbox warm-up use the same `chat-thread:<conversation>` lock as a turn. The publish routes used `withSandboxLockIfFree`, which refused at once when any holder had the lock. Thus Commit+Push failed while the Files panel loaded, and worked when the reads ended (`POST …/push 200` at 08:44:40).
2. **Create PR answered 502 github_unavailable.** The log shows `POST …/pull-request 502` two times (08:44:46, 08:44:54), each about 1.3 s after the sandbox was ready, and no `push_failed` path. The route answers 502 from its catch block when a GitHub call throws. The thrown GitHub error goes only to the request's wide event, which the Railway log does not show. HyperDX was not available (the MCP key was rejected), so the GitHub status is not known. The most likely cause is a GitHub App installation that cannot get a `pull_requests: write` token: GitHub answers the token request with 422 "The permissions requested are not granted to this installation." A contract test reproduces the same 502 from that answer.
3. **The UI showed no error.** `useConversationPublish` had no `onError` for either mutation. Each failure left the button as it was, with no message.

## Resolution

- The publish routes answer 409 `turn_running` at once when the conversation has a running chat run (`findActiveRun`). Otherwise they wait for the `chat-thread:` lock until the client aborts the request. Files reads keep their exclusive lock.
- `createPullRequestFromBranch` returns a refusal:
  - `no_pr_access` (400) when GitHub refuses the `pull_requests: write` token (422 "permissions requested") or the call (403 "not accessible by integration" or a 403 that names a permission). A rate limit 403 stays `github_unavailable` (502).
  - `no_changes` (400) for 422 "No commits between".
- The route logs GitHub's status and message: `conversation-pull-request refused` at warn for a refusal, and the `conversation-pull-request` error with `githubStatus` and `githubMessage` for other GitHub errors.
- The UI shows a toast for each failure. Every error code has a message (`conversationPublishErrorMessage`).

Proof:

- `conversation-branch-push-native.contract.test.ts` "publishes with Commit+Push and Create PR":
  - A running turn answers 409 at once.
  - A short lock hold (as a Files read) made Commit+Push answer 409 `turn_running` first. Now the push waits and gets 200.
  - An aborted request stops its wait, pushes nothing, and leaves the holder's lock alone.
- Same file, "names why GitHub refused to open the pull request": the token-mint 422 and the pulls.create 403 give `no_pr_access`. A rate limit 403 gives 502. "No commits between" gives `no_changes`. The token-mint case gave 502 `github_unavailable` before the fix.
- `conversationPublish.test.ts` and `useConversationPublish.test.ts`: the error codes and their messages.
- Storybook golden story `PublishErrorsToast`: the toast texts for `turn_running` and `no_pr_access`.

## Open

- Confirm cause 2 on the preview. In HyperDX (DeploymentEnvironment `pr-280`), find the `conversation-pull-request` error of the two 502 requests on 2026-10-07 at 08:44 UTC. Read the GitHub status and message on that event. After this change deploys, a new attempt logs `conversation-pull-request refused` with `githubStatus` and `githubMessage`. If GitHub refused the permission, set the preview's GitHub App to Repository permissions → Pull requests: Read and write, and accept the new permission on the installation.
