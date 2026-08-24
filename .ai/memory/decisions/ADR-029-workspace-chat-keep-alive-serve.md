# ADR-029: In-sandbox keep-alive OpenCode serve

**Status:** Accepted | **Date:** 2026-08-24 | **Tags:** workspace-chat, tanstack, opencode, latency

## Context

Workspace chat is locked to TanStack `chat()` + `withSandbox` + `opencodeText` ([workspace-chat-sandboxes](../PRDs/workspace-chat-sandboxes.md)). `@tanstack/ai-opencode@0.2.5` (and 0.3.x in-sandbox adapters) always spawn `opencode serve` inside the conversation sandbox and `dispose()` / kill it at the end of the turn. Official docs mention `baseUrl` attach, but that option is not on the in-sandbox `opencodeText` config in the lock-compatible 0.2.5 line. Newer 0.3.x packages require `@tanstack/ai` / `@tanstack/ai-sandbox` peers we do not have.

Per-turn serve spawn plus GitHub resolve, a new model proxy, a tool tour, and a judge LLM per read made `what's in this repo?` take ~30–45s. The [latency PRD](../PRDs/workspace-chat-latency.md) requires about 5s after compose is mounted.

## Decision

- Keep one TanStack sandbox / workdir per conversation (`reuse: "thread"`).
- Keep one model proxy and one `opencode serve` **inside that conversation sandbox** for the conversation lifetime (30m keep-alive, same as the sandbox).
- Attach subsequent turns with the official `startOpencodeSession({ baseUrl })` export. Do not patch `@tanstack/ai*`. Do not run a host-wide daemon or a shared port-4096 mutex. Do not add `OPENCODE_SERVER_PASSWORD`.
- First materialization still uses `chat()` + `withSandbox` + `opencodeText` so the sandbox and workdir exist. After that stream ends, start (or keep) serve via `startOpencodeServerInSandbox` when the handle exposes spawn/ports, otherwise `opencode serve` on the conversation’s leased local-process port.
- Pre-warm on compose mount (`POST /conversations/:id/prepare`) so Send does not pay clone + first serve.
- Judge only mutate/egress. Auto-allow in-sandbox read/grep/ls after hard-denies. Do not bake example questions or a precomputed inventory into the OpenCode prompt.

## Consequences

- Two conversations never share a sandbox, proxy, or serve.
- `@tanstack/ai-opencode` 0.2.5 still cannot attach through `opencodeText({ baseUrl })`. Attach uses the package’s documented session API, not a vendor patch.
- A later lock-compatible `opencodeText({ baseUrl })` can replace the attach helper without changing isolation rules.

## Alternatives considered

- Upgrade the whole TanStack AI stack to get `baseUrl` on `opencodeText`: rejected for this change; 0.3.4 still has no `baseUrl` on the in-sandbox adapter and requires `@tanstack/ai@^0.48`.
- Host OpenCode or answer from the Railway filesystem: rejected; tenant isolation.
- `pnpm patch` of `@tanstack/ai-opencode`: rejected; TanStack stays stock.
