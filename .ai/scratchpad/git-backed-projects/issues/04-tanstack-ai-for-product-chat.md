# TanStack AI for product chat

Type: research
Status: resolved

## Question

Can **TanStack AI** power the new workspace chat on **both** the frontend (`apps/ui`) and the backend (`apps/backend`, Bun/Hono), replacing today's LangGraph + Vercel AI SDK (`@ai-sdk/react` `useChat`) path?

Investigate against primary sources (TanStack AI docs, package APIs, this repo's current chat transport) and answer:

- Official FE and BE packages, and whether they run on Bun.
- Streaming, tool calls, conversation persistence; a chat transport we can hang off Hono.
- What breaks if we stop using LangGraph `PostgresSaver` checkpoints for chat.
- Honest constraints: auth, multi-tenant org/project scoping, resumable streams, attaching a **separate** OpenCode runtime (do not research OpenCode or Docker here).

Write findings to `.ai/scratchpad/git-backed-projects/assets/tanstack-ai-product-chat.md` with citations. Do not recommend a product decision beyond what the sources support.

## Answer

**Yes for transport, no as a drop-in.** `@tanstack/ai-react` + `@tanstack/ai` can sit on the UI and a Hono route (SSE `Response`; Hono needs explicit parse/error handling). Packages are `0.x`; engine field is Node `>=18`, not Bun. LangGraph `PostgresSaver` checkpoints (retrieval DAG state) have no TanStack equivalent — persistence is an app-owned store via `@tanstack/ai-persistence`.

First-party coding-agent path exists: `chat()` + `withSandbox` + harness. `@tanstack/ai-opencode`'s `opencodeText` is the OpenCode harness (spawns/attaches `opencode serve`, Node-only). Official sandbox providers: local process, Docker container, `sbx` microVM, Daytona, Vercel, Sprites — **not Railway or Fargate**. `opencodeText` has **no run journal** even on durable runs.

Full write-up: [TanStack AI for product chat](../assets/tanstack-ai-product-chat.md). Sol reviewed; the first draft omitted the sandbox/OpenCode harness — that is now in the write-up.

## Comments

- 2026-08-13 — Human lock: do not treat DIY `opencode serve` / container orchestration as an option. Recorded on [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md).
