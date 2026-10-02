# Workspace chat sandbox reuse and parallelism

Status: accepted (2026-08-23)

Workspace chat (`chat()` + `withSandbox` + `opencodeText`) must reuse one TanStack sandbox / workdir per conversation so turn latency stays low, and must run many conversations at once. Do not reclone or reboot OpenCode plugins on every send. Do not serialize the host on one hardcoded OpenCode port.

## Requirements

- **Reuse:** keep the provider sandbox and workdir across turns (`reuse: "thread"`, `snapshot: "after-setup"`). `reuse: "none"` and `destroyOnComplete: true` are rejected — a full git clone plus plugin boot per turn is unacceptable.
- **Parallelism:** many users and conversations run concurrently. A process-wide mutex or a single host port (for example 4096) shared by all chats is rejected.
- **TanStack stays stock:** do not patch, fork, or wrap-hack `@tanstack/ai*`. ServeError, echo, and failed resume are treated as our wiring. The only exceptions are the temporary Vercel provider patches in [ADR-048](../decisions/ADR-048-native-postgres-sandbox-ownership.md), upstreamed after launch. Where the agent's port is reachable from outside the sandbox (Vercel), it requires an OpenCode server password.
- **Simplicity:** prefer official `chat()` + `withSandbox` + `opencodeText`. Persistence and the client both see that stream. Attach / keep-alive serve is retired; see [ADR-044](../decisions/ADR-044-workspace-chat-stock-tanstack.md). A host-wide daemon or shared port-4096 lock is still rejected.

Models and LLM host stay in [workspace-chat-models](workspace-chat-models.md).
Answer-time SLO stays in [workspace-chat-latency](workspace-chat-latency.md).

## Not this document

Implementation details (instance-store key, locks, providers) belong in [ADR-048](../decisions/ADR-048-native-postgres-sandbox-ownership.md) and code, not here. Hosted chat uses Cloudflare Sandboxes; self-hosters use Docker.
