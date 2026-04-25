---
name: storybook
description: Work with Storybook in apps/ui (colocated stories, MSW, TanStack Start, Storybook MCP). Use when writing or updating stories, using the ctxpipe-storybook MCP, previewing components in Storybook, or when adding new UI components or pages in apps/ui.
license: MIT
metadata:
  author: ctxpipe
  version: "0.1"
---

# Storybook (apps/ui)

This repo’s UI lives in **`apps/ui`**. Storybook is configured under **`apps/ui/.storybook/`**; run from the repo root with **`pnpm --filter @ctxpipe/ui storybook`** (dev server on **http://127.0.0.1:6006** by default).

## Storybook MCP (`ctxpipe-storybook`)

The project registers the Storybook MCP in **[.agents/mcp.json](../../mcp.json)** as **`ctxpipe-storybook`**, pointing at **`http://127.0.0.1:6006/mcp`**.

- **The Storybook dev server must be running** for the MCP to respond. Start it with `pnpm --filter @ctxpipe/ui storybook` before relying on the tools. If the port changed, update the URL in `mcp.json` to match.
- **What it’s for**: browse manifests, doc toolsets, story authoring help, and (when [Storybook Test](https://storybook.js.org/docs/writing-tests) is wired) test runs. Official overview: [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview).
- **Do not guess design-system or app props** when a component might have non-obvious APIs. Use MCP tools (e.g. `list-all-documentation`, `get-documentation`, `get-documentation-for-story`) before using props. Call **`get-storybook-story-instructions`** when creating or changing stories to align with Storybook’s current guidance. Use **`run-story-tests`** to validate when the test addon is available (this project does not yet ship Storybook’s Vitest test runner; see “Testing in Storybook” below).
- If tools fail, confirm the dev server is up and the URL still matches the script’s port in **`apps/ui/package.json`**.

## Mandatory: a story for every new component and page

When you add a **reusable component** or a **new page/screen** (a route that represents user-visible UI) in `apps/ui`, also add a **colocated** `*.stories.tsx` in the same PR (unless the user explicitly defers it). Trivial re-exports with no new UI are optional to discuss with the team.

- **Reusable component**: e.g. `MyCard.tsx` → `MyCard.stories.tsx` next to it.
- **Page / route content**: a story file **beside the route** with a **`-` prefix** so TanStack Router does not treat it as a route (e.g. `src/routes/-home.stories.tsx`).

## Colocation and naming

- **Component stories**: colocate with the component; `title` uses **`Components/...`** (or **`App/...`** for app shell) — see existing stories under `src/components/` and feature folders.
- **Full-page / route stories**: `title` under **`Pages/...`**, e.g. `Pages/Connections` for a connectors page story. See **`entryPageInnerDecorators`**, `parameters.storyRoute`, and **`layout: "fullscreen"`** as in [ConfluenceConnectionCard.stories.tsx](../../../apps/ui/src/features/connectors/components/ConfluenceConnectionCard.stories.tsx).
- **Route file naming**: use **`-` prefix** for story files next to routes (e.g. `-connectors.stories.tsx`) so they are not picked up as route modules.

## Render real components; mock data, not components

- **Do not** replace production components with “story-only” fakes. Stories should import and render the **same** components the app uses so visuals and types stay honest.
- **Do** use **MSW** for API, auth-adjacent, and other network boundaries. The addon is **`msw-storybook-addon`**; preview wires **`mswLoader`** and default handlers. Project defaults live in [apps/ui/.storybook/preview.tsx](../../../apps/ui/.storybook/preview.tsx) (auth/session org handlers from [apps/ui/src/mocks/handlers](../../../apps/ui/src/mocks/handlers)).
- **Per-story API behavior**: set **`parameters.msw.handlers.page`** (array of `http.*` handlers) in that story, matching patterns in existing connector and page stories. Use **`delay("infinite")`** for loading states when you need a hanging request.
- **Shared MSW**: put reusable handlers in **`src/mocks/handlers`** and import them in stories **only** when the same request contract is used across **multiple** story files. Otherwise keep handlers **inline** in the story for clarity.
- **Handlers**: use **`http.get` / `http.post`**, **`HttpResponse.json`**, and path/query checks consistent with the real API (see existing stories for org-scoped paths like `/:orgSlug/api/...`).

## TanStack Start + React Aria in Storybook

- Page-level stories use the decorator stack in [apps/ui/.storybook/decorators/entry-page-decorators.ts](../../../apps/ui/.storybook/decorators/entry-page-decorators.ts) (`withReactAriaRouter`, auth, `withStoryRoute`, etc.) so `useRouter` and org routes behave.
- **Do not** import the **`storybook-addon-tanstack-start` package entry** from story files; it can pull the Vite plugin into the browser bundle. The preset is only registered in [apps/ui/.storybook/main.ts](../../../apps/ui/.storybook/main.ts).

## Testing in Storybook

Vitest and Testing Library are used for **unit/component tests** (`*.test.tsx`). This app does not currently add **@storybook/addon-vitest**; the MCP’s **`run-story-tests`** tool applies when that integration exists. Until then, rely on Vitest in CI and a11y via **`@storybook/addon-a11y`** in Storybook.

## Quick reference (commands)

| Action | Command |
|--------|--------|
| Start Storybook | `pnpm --filter @ctxpipe/ui storybook` |
| Build static | `pnpm --filter @ctxpipe/ui build-storybook` |

## Related docs in-repo

- [apps/ui/AGENTS.md](../../../apps/ui/AGENTS.md) — product-specific Storybook rules, ports, and route naming.
