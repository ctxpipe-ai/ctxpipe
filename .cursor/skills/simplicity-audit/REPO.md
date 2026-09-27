# This repo

Load when running simplicity-audit inside ctxpipe.

## Memory

Constraints live under `.ai/memory/`. Follow [`.ai/agents/domain.md`](../../../.ai/agents/domain.md). Recall via [`memory-search`](../memory-search/SKILL.md) — indexes first, then `rg`, skip `events/`. Do not look in `CONTEXT.md` or `docs/adr/`.

## Stack ADRs (out of scope unless the user reopens them)

Hono + OpenAPI + MCP, Drizzle, TanStack + React Aria, Better Auth, Zoekt, git-native source connectors. The review names leftover *inside* those decisions; it does not reopen the stack.

## Connector siblings

- **Aligned (thin):** Linear and Notion — binding on `connections.config`, scope in git yaml, work via OpenWorkflow. [ADR-022](../../../.ai/memory/decisions/ADR-022-linear-connector-git-native-mirror.md), [ADR-023](../../../.ai/memory/decisions/ADR-023-notion-connector-git-native-mirror.md).
- **Leftover analogue:** Confluence control-plane tables, custom dirty queues, scope dual-write, ceremony yaml with nothing to review.

## Models

Simplicity review runs as `gpt-5.6-sol-high`. Implementation and explore stay `cursor-grok-4.6-high-fast`.
