---
name: react
description: React UI patterns for apps/ui—Effects vs rendering, TanStack Query for all server data, useMemo, keys, event handlers. Start here when creating or editing React components.
skill_version: 1.0.1
updated_at: 2026-04-25T12:00:00Z
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

## Patterns (read the official page for full examples)

| Situation | Prefer |
|-----------|--------|
| Server / API data (read, mutations, refetch) | **TanStack Query** only—never `useEffect` + manual fetch for data loading |
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

## Checklist before adding `useEffect`

1. Can this be **derived** during render from props/state? → No Effect; no extra state.
2. Is this a **user event**? → Event handler.
3. Am I **syncing with an external system** (DOM, non-React widget, imperative subscription—not **fetching** data)? → Effect may be right; handle cleanup. **If it’s API/server data, use TanStack Query instead.**
4. Am I “fixing” props by copying into state? → Prefer keys, derived values, or controlled patterns.

## Extending this skill

This file is the **React** skill entry point for the repo. When the team adopts new rules (RSC, data loaders, testing patterns, etc.), add **short** sections here with links to official docs or internal docs—keep the file skimmable.
