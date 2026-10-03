# Proof

A test is **_proof_** only when the owned collaborator runs in this process and the assertion is an HTTP, status, or paths literal you wrote — not a value recomputed from the implementation.

Run for real:

- git workdirs (`localProcessSandbox`, tmp git)
- Hono routes via `app.request`
- domain listing on a real handle (`listConversationSandboxPaths`)

Substitute only what this process cannot run: paid or third-party network (GitHub, Stripe). Auth session and DB row fixtures so a route has a user or workspace are fixtures, not stubs of the listing.

Fake the **environment** at system boundaries; keep every module we own real.

| Boundary | Use |
| --- | --- |
| Outbound HTTP (our services, third-party APIs, OTLP, LLM providers) | `msw` (`setupServer` from `msw/node`) |
| Postgres | Real test database — `*.integration.test.ts` gated on `DATABASE_URL` (see root AGENTS.md → Testing) |
| Config | `vi.stubEnv`, or pass the value as an argument |
| Time / randomness | `vi.useFakeTimers()`; inject the random source |
| Telemetry output | OTel SDK in-memory exporters |

`vi.mock` of a repo module is reserved for an import-time side effect that cannot be configured, with a one-line comment naming it. Mocking our own env, db client, logger, or retry helper tests the mock: the test keeps passing when behavior breaks and fails when a refactor keeps it.

`vi.mock` of `warmTanstackWorkspaceChat`, `exec`, or `conversation-files` is not _proof_. Green on that mock is not a passing product test.

MSW in Storybook paints chrome. It is not _proof_ that a server listing is correct.

These patterns shape the boundary adapters msw or the test database exercises; they are not a licence to inject fakes of our own modules.

At system boundaries, design interfaces that are easy to mock:

See [`write-workflow-native.contract.test.ts`](../../../apps/backend/src/domain/workspaces/write-workflow-native.contract.test.ts) and [`conversation-files-routes.live.test.ts`](../../../apps/backend/src/routes/v1/conversation-files-routes.live.test.ts).
