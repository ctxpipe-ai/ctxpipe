# ADR-043: In-sandbox keep-alive OpenCode serve

**Status:** Superseded by [ADR-044](ADR-044-workspace-chat-stock-tanstack.md) | **Date:** 2026-08-24 | **Tags:** workspace-chat, opencode, latency

Kept for history. To hit the ~5 s first-answer target ([workspace-chat-latency](../PRDs/workspace-chat-latency.md)) on `@tanstack/ai-opencode` 0.2.5, which spawned and killed `opencode serve` every turn, chat kept one `opencode serve` per conversation sandbox alive and attached later turns through `startOpencodeSession({ baseUrl })`.

That second path ignored `chat({ messages })`, stored assistant text only, bypassed official persistence, and rebuilt the sandbox on prepare. Once the lock moved to `@tanstack/ai` 0.48 / `@tanstack/ai-opencode` 0.3.4, chat returned to the stock loop (ADR-044) and the attach path was removed.
