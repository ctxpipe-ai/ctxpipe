# Workspace chat sandbox reuse and parallelism

Status: accepted (2026-08-23)

Workspace chat (`chat()` + `withSandbox` + `opencodeText`) must reuse one TanStack sandbox / workdir per conversation so turn latency stays low, and must run many conversations at once. Do not reclone or reboot OpenCode plugins on every send. Do not serialize the host on one hardcoded OpenCode port.

## Requirements

- **Reuse:** keep the provider sandbox and workdir across turns (`reuse: "thread"`, `snapshot: "after-setup"`). `reuse: "none"` and `destroyOnComplete: true` are rejected — a full git clone plus plugin boot per turn is unacceptable.
- **Parallelism:** many users and conversations run concurrently. A process-wide mutex or a single host port (for example 4096) for all `local_process` chats is rejected.
- **TanStack stays stock:** do not patch, fork, or wrap-hack `@tanstack/ai*`. ServeError, echo, and failed resume are treated as our wiring. Do not add `OPENCODE_SERVER_PASSWORD`.
- **Simplicity:** prefer official `chat()` + `withSandbox` + `opencodeText` practices. Per-turn OpenCode serve/session is TanStack’s model; reuse the sandbox, not a long-lived daemon.

Models and LLM host stay in [workspace-chat-models](workspace-chat-models.md).

## Not this document

Implementation details (ephemeral port lease, instance-store key, definition-hash stability) belong in the working plan / code, not here. A Railway-native sandbox provider is later work.
