# Commit+Push is unreliable and Create PR does not work

Status: done (one cause needs a preview check, see "Open")
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

- `withSandboxLockIfFree` takes an optional `waitMs`. The publish routes wait up to 10 s for the lock. A Files read or a warm-up ends in that time; a turn still answers `turn_running`.
- Create PR answers 400 `no_pr_access` when GitHub refuses the permission (403, or 422 with "permission"). Other GitHub errors still answer 502 `github_unavailable`.
- The UI shows a toast for each failure, with a message for each error code (`conversationPublishErrorMessage`).

Proof (each test failed first for the same reason as on the preview):

- `conversation-branch-push-native.contract.test.ts` "publishes with Commit+Push and Create PR": a short lock hold (as a Files read) made Commit+Push answer 409 `turn_running`; now 200.
- Same file, "answers no_pr_access when the GitHub App cannot open pull requests": answered 502 `github_unavailable`; now 400 `no_pr_access`.
- `apps/ui/src/features/workspaces/useConversationPublish.test.ts`: the error messages for `turn_running`, `no_pr_access` and `github_unavailable`.

## Open

- Confirm cause 2 on the preview. Look at the `conversation-pull-request` error in HyperDX (DeploymentEnvironment `pr-280`) for the two 502 requests. If it is the permission, set the GitHub App of the preview to Repository permissions → Pull requests: Read and write, and accept the new permission on the installation. After this fix, the UI names that cause.
- A polling client can keep the lock busy for more than 10 s. Then Commit+Push still answers `turn_running`, now with a message.
