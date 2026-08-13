# TanStack AI for product chat

Type: research
Status: open

## Question

Can **TanStack AI** power the new project chat on **both** the frontend (`apps/ui`) and the backend (`apps/backend`, Bun/Hono), replacing today's LangGraph + Vercel AI SDK (`@ai-sdk/react` `useChat`) path?

Investigate against primary sources (TanStack AI docs, package APIs, this repo's current chat transport) and answer:

- Official FE and BE packages, and whether they run on Bun.
- Streaming, tool calls, conversation persistence; a chat transport we can hang off Hono.
- What breaks if we stop using LangGraph `PostgresSaver` checkpoints for chat.
- Honest constraints: auth, multi-tenant org/project scoping, resumable streams, attaching a **separate** OpenCode runtime (do not research OpenCode or Docker here).

Write findings to `.ai/scratchpad/git-backed-projects/assets/tanstack-ai-product-chat.md` with citations. Do not recommend a product decision beyond what the sources support.
