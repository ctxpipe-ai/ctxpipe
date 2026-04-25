# UI (`apps/ui`) – agent instructions

When working in **`apps/ui`**, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **React skill (required for components)**: Before creating or substantially editing React components, hooks, or UI data flow, read and follow **[`.agents/skills/react/SKILL.md`](../../.agents/skills/react/SKILL.md)**. It starts from the official [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) guidance; **data fetching** is **TanStack Query only** (no `useEffect` for load/refetch). Extend that skill file as team conventions accumulate.
