# UI (`apps/ui`) – agent instructions

When working in **`apps/ui`**, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **React skill (required for components)**: Before creating or substantially editing React components, hooks, or UI data flow, read and follow **[`.agents/skills/react/SKILL.md`](../../.agents/skills/react/SKILL.md)**. It starts from the official [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) guidance; **data fetching** is **TanStack Query only** (no `useEffect` for load/refetch). Extend that skill file as team conventions accumulate.
- **Inline prose markup**: In user-facing copy inside components, use **plain JSX** for emphasis and code snippets (`<strong className="…">`, `<code className="…">`, etc.) in place. Do **not** add tiny helper functions or wrapper components whose only job is to wrap a string (e.g. `{lbl("Settings")}` or `ghStrong("Payload URL")`) — repeat the markup so the structure stays explicit at each call site.
