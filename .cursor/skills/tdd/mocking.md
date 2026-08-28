# Proof

A test is **_proof_** only when the owned collaborator runs in this process and the assertion is an HTTP, status, or paths literal you wrote — not a value recomputed from the implementation.

Run for real:

- git workdirs (`localProcessSandbox`, tmp git)
- Hono routes via `app.request`
- domain listing on a real handle (`listConversationSandboxPaths`)

Substitute only what this process cannot run: paid or third-party network (GitHub, Stripe). Auth session and DB row fixtures so a route has a user or workspace are fixtures, not stubs of the listing.

`vi.mock` of `warmTanstackWorkspaceChat`, `exec`, or `conversation-files` is not _proof_. Green on that mock is not a passing product test.

MSW in Storybook paints chrome. It is not _proof_ that a server listing is correct.

See [`job-sandbox.live.test.ts`](../../../apps/backend/src/domain/workspaces/job-sandbox.live.test.ts) and [`conversation-files-routes.live.test.ts`](../../../apps/backend/src/routes/v1/conversation-files-routes.live.test.ts).
