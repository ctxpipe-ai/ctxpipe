---
name: react
description: React UI patterns for apps/ui—Effects vs rendering, TanStack Query for all server data, useMemo, keys, event handlers. Start here when creating or editing React components.
skill_version: 1.0.5
updated_at: 2026-08-21T12:00:00Z
tags: [react, hooks, useeffect, usememo, performance, components]
progressive_disclosure:
  entry_point:
    summary: "Prefer deriving state and pure calculations during render; reserve Effects for synchronizing with external systems."
    when_to_use: "Creating, refactoring, or reviewing React components, hooks, and data flow in the UI app"
    quick_start: "1) Read the mental model below. 2) If you reach for useEffect, check the checklist. 3) Add future React guidance to this skill file."
  references:
    - label: "You Might Not Need an Effect (React docs)"
      url: "https://react.dev/learn/you-might-not-need-an-effect"
context_limit: 800
---

# React (UI) — you might not need an Effect

**Primary reference:** [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) — treat this skill as a project-local digest; extend it as team conventions grow.

## Mental model

**Effects** are for **synchronizing with things outside React**: third-party widgets, the network, the browser DOM, subscriptions, etc.

If there is **no external system**—for example, you only need to update local state when props or other state change—you usually **should not** use an `useEffect` for that. Unnecessary Effects make code harder to follow, can add extra render passes, and are easier to get wrong.

## You usually *don’t* need an Effect for

1. **Transforming data for rendering** — Compute from props/state in the component body. Don’t store derived values in state and “refresh” them in an Effect; that can cause a stale render, then a second render when the Effect runs.
2. **User-driven work** — Handle user intent in **event handlers** (clicks, submit, etc.). By the time an Effect runs, you don’t know *which* user action caused the update.

**You do** use Effects to **synchronize** with external systems (non-React UI, the browser DOM, third-party widgets, etc.).

**Data fetching in this repo:** use **TanStack Query** (`useQuery`, `useMutation`, `useInfiniteQuery`, etc.) for all server/API data. **Do not** use `useEffect` to load, refetch, or keep server data in sync—Query handles caching, loading and error state, and invalidation.

**SSR product screens (e.g. Workspace):** warm the cache in route loaders with `queryClient.ensureQueryData(…queryOptions)` and read with **`useSuspenseQuery`** (same `queryOptions` factories). Create the **`QueryClient` per request** in `getRouter()` — never a module-level singleton. Keep streaming, polling, infinite “load more”, and mutations client-only. Loaders warm **entry** (first SSR / workspace change). They must not gate **in-page chrome** — see **Feel fast**.

**Responsive layout:** CSS-first (Tailwind breakpoint classes). Do not use `useEffect` + `matchMedia` / `useMediaQuery` to toggle layout chrome when responsive classes can do it. JS only when CSS cannot express the behaviour — see [apps/ui/AGENTS.md](../../../apps/ui/AGENTS.md) and [product-ui](../product-ui/SKILL.md) Build.

## Patterns (read the official page for full examples)

| Situation | Prefer |
|-----------|--------|
| Server / API data (read, mutations, refetch) | **TanStack Query** only—never `useEffect` + manual fetch for data loading |
| First paint must include product data (SSR) | Route `ensureQueryData` + `useSuspenseQuery`; no module-level `QueryClient`. Do **not** put tab/pane search in `loaderDeps` |
| In-page tab / pane / nav highlight | Set selected chrome in the click handler (`useUrgentValue`); write the URL afterwards. `Link` / `useMatchRoute` still wait on the router. Load the region with local `Suspense`. Prefetch on hover/select; do not `await` it before navigate |
| Value derivable from props/state | Compute during render; avoid redundant state ([Thinking in React](https://react.dev/learn/thinking-in-react)) |
| Expensive pure calculation | `useMemo` with correct deps; measure before optimizing. **React Compiler** may reduce the need for manual `useMemo` ([docs](https://react.dev/learn/react-compiler)) |
| Reset *all* inner state when a prop changes (e.g. `userId`) | `key={userId}` on a child so React remounts a fresh subtree |
| Reset/adjust *some* state when props change | Often avoid Effect: e.g. adjust during render with a `prevX` pattern, or **store IDs not objects** and derive selection during render (see [same article](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)) |
| Shared logic for several buttons | Extract a function; call it from each **event handler**—not from an Effect that watches flags |
| POST / work that must run on a **specific** user action | **Event handler** (e.g. `submit`) |
| POST / work because the component *appeared* | Effect can be appropriate; watch for Strict Mode double-invocation in dev |
| Chains of Effects only updating state to trigger more state | Compute during render; compute next state in the **event handler** where the action happens |
| One-time app init that must be truly once per load | Module scope flag, root entry, or documented pattern—avoid “run once” Assumptions that break on remount |
| Child notifies parent of state | Update parent in the **same** event path as the child; consider **controlled** props from parent. Avoid `useEffect` that only mirrors child state to parent |
| Data needed by both parent and child | **Data flows down**—parent fetches/owns, passes props down |

**Rule of thumb:** If code runs *because the user did something specific*, it probably belongs in an **event handler**. If it runs *because the user saw the component on screen*, it might belong in an **Effect** (if it’s about an external system or real synchronization).

## Feel fast

Speed of the Operate UI is part of the product. **Chrome and the page body must move on the click. First HTML still includes the landing region.**

TanStack Router commits location inside `React.startTransition`. If `selectedKey`, `aria-current`, or “current workspace” is driven only from `useSearch()` / `useParams()` / `useMatchRoute()` / `router.state.location`, the highlight waits until the new page body is ready. `Link` does not fix that. RAC `Link` also does **not** fire `defaultPreload: "intent"` — prefetch with `prefetchQuery` on hover/press.

Urgent local state is for **in-page clicks**. **SSR / hard refresh / org identity** still `await ensureQueryData` so first HTML includes the landing region. **Client page enter** (Home ↔ Connectors ↔ Workspace) must not `await` landing data — `prefetchQuery` and local `Suspense`.

Use [`useUrgentValue`](../../../apps/ui/src/lib/useUrgentValue.ts): set the value in the event handler; adopt the committed URL during render when it changes (back/forward). Include org/workspace in the key so ids do not leak across identities.

Default checklist for any Operate screen:

- **Chrome** — `useUrgentValue` in the press handler. RAC `Link` + `prefetchQuery` on hover/press.
- **Shell stays** — `AppShell` / SideNav live on `/$orgSlug`, not on Home, Connectors, or Workspace leaves. In-page identity (tab, pane, conversation, compose vs thread) must not remount the shell or sibling columns. Hoist shared state to the layout that does not change. Sibling file routes that each mount the same surface are a bug.
- **Client loaders do not await page or in-page detail** — `await ensureQueryData` is for **SSR / hard refresh** (session, org membership, workspace identity). Client Home / Connectors / Workspace enter: `prefetchQuery` only. Conversation, blob, graph, messages: `prefetchQuery` on the client. Sibling `enter` still runs the child loader — `shouldReload: enter` does not save compose ↔ thread.
- **Suspense is local** — one region, skeleton fallback. Never put `AppShell` or a sibling pane inside that boundary. A cache miss must not flash the whole page. Session-pending fallbacks are main-column skeletons only.
- **Preserve `search`** — in-page `navigate` keeps `?pane=` and other chrome search.

Wrong: each org leaf wraps its own `AppShell`, and the workspace client loader `await`s files (previous page frozen until the tree returns).

Right: `/$orgSlug` owns `AppShell`. Workspace layout owns `WorkspaceSurface`; children return `null`. Client workspace loader only `prefetchQuery`. Conversation `useSuspenseQuery` lives under the chat column’s `Suspense`.

- **Loader:** identity queries on **SSR**. Warm the **landing** region on SSR enter (workspace default is files when `?pane=` is empty) **only when that region can succeed** (e.g. `workspaceProjectionReady`). Client enter prefetches the same queries and does not `await`. Do not list in-page search in `loaderDeps`. `shouldReload: ({ cause }) => cause === "enter"` so search-only / sibling stays do not re-await. Never pass `paneParam: undefined` on enter.
- **HTTP:** every product call goes through `apiFetch` / `readApiJson`. Bare `fetch` + `if (!res.ok) throw` is a bug. Expected 409/404 (not ready / not installed) are data via `emptyOn`, not thrown errors. Query retries never run on 4xx (`retryQuery`). `refetchInterval` always uses `pollWhileOk` (or equivalent: return `false` on error).
- **Loaders / `beforeLoad`:** `await` only queries required to **choose the route** on the server (session, org membership, workspace identity). Parallelize independent identity fetches (`Promise.all`). Keep the workspace SSR skip (`warmLandingPane` only in the browser). Do **not** flip the app to `ssr: false`.

A blocked tab or nav click is a bug, even if the data eventually arrives. Holding the HTML document on a retried 4xx or hung fetch until the edge 502s is also a bug.

## Checklist before adding `useEffect`

1. Can this be **derived** during render from props/state? → No Effect; no extra state.
2. Is this a **user event**? → Event handler.
3. Am I **syncing with an external system** (DOM, non-React widget, imperative subscription—not **fetching** data)? → Effect may be right; handle cleanup. **If it’s API/server data, use TanStack Query instead.**
4. Am I “fixing” props by copying into state? → Prefer keys, derived values, or controlled patterns.

## Extending this skill

This file is the **React** skill entry point for the repo. When the team adopts new rules (RSC, data loaders, testing patterns, etc.), add **short** sections here with links to official docs or internal docs—keep the file skimmable.
