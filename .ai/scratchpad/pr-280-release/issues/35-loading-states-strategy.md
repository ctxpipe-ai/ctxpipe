# Make loading states calm: delayed, matching and subtle skeletons

Status: in progress
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The UI has many loading skeletons (about 30 files use `Skeleton`). Many do not match the layout that renders after them, so the page jumps when the data arrives. Skeletons also show at once, so a fast transition flickers: skeleton, then content, within a few hundred milliseconds. The CTO wants one strategy for all of them.

## Spec (from the CTO)

1. **Delay:** a skeleton does not show at once. It shows only when the load takes longer than a delay, so fast transitions do not flicker.
2. **Match:** each skeleton matches the container that renders after it, as closely as possible: the same size, position, spacing, row count and shape. Nothing moves when the content arrives.
3. **Subtle:** skeletons are more subtle, either darker or more transparent than today.

Team lead defaults, to apply unless the evidence shows a problem:
- One shared delay constant in one place, set to 1000 ms. The CTO asked for "a few seconds". 1000 ms removes the flicker of fast transitions and does not leave a blank screen for long. Change the constant if the CTO wants longer.
- Before the delay ends, the space is kept with the final layout's size but stays empty, so nothing jumps when the skeleton or the content appears.
- After a skeleton shows, it stays for at least a short minimum time (for example 300 ms), so it does not flash.
- The delay and the subtle style are in the shared `Skeleton` component (or one wrapper), not in each call site.
- Under `prefers-reduced-motion`, the skeleton shimmer can stop, but the skeleton stays visible.

## Acceptance criteria

- [ ] One shared delay and minimum-time rule is used by every skeleton.
- [ ] Each skeleton is listed in Comments with its route or component and its match decision. Each one matches its loaded layout, so there is no layout shift when the data arrives.
- [ ] The skeleton style is more subtle, and the change is recorded in apps/ui/DESIGN.md (loading states).
- [ ] Storybook stories prove the delay (nothing before the delay, a skeleton after it) and, for the main surfaces, the match: the skeleton and the loaded state have the same layout box.
- [ ] UI tests and golden stories pass.

## Comments

### 2026-10-11 — placeholder list (claude)

The shared rule is in `apps/ui/src/components/ui/Skeleton.tsx`: `SKELETON_DELAY_MS` (1000), `SKELETON_MIN_MS` (300), the bone (hidden with its box until the delay), `useSkeletonHold`, `SkeletonSuspense`, `SkeletonReveal` and `SkeletonText`. Every bone gets the delay, because the delay is in `Skeleton`. No route has a `pendingComponent`, so TanStack Router `pendingMs`/`pendingMinMs` does not apply.

| Placeholder | Stands in for | Before | Decision |
|---|---|---|---|
| `WorkspaceNavList` fallback | side nav workspace rows | `SkeletonRow` in one `li`, no row margin | `SideNavRowSkeleton`, one `li` per row, same row classes |
| `WorkspaceConversationList` | side nav conversation rows | rows without the 2 px gaps | one `li` per row, hold; box proof `ConversationListSkeletonMatches` |
| `WorkspaceSurfaceSkeleton` | workspace page | fixed `w-md` pane, always open | follows the URL pane, same columns, tab strip and card; proof `SurfaceSkeletonMatches` |
| `ConversationThreadSkeleton` / `WorkspaceChatResumeFallback` | conversation | close | kept; uses `SkeletonSuspense` |
| `WorkspaceFilesPaneSkeleton` | Files pane | wait text shows at once | same grid (208 px tree); wait text in `SkeletonReveal`; hold |
| `WorkspaceFilePreviewSkeleton` | open file | close | kept; uses `SkeletonSuspense` |
| `WorkspaceGraphPaneSkeleton` | graph | the explorer wait view | kept: it is a process wait (`GraphWaitState`), same view as loaded wait |
| `WorkspaceActivityHeatmapSkeleton` | home heatmap | inline bone, extra line gap | block bone 128 px; proof `HeatmapSkeletonMatches` |
| `WorkspaceRecentCommitsSkeleton` | home recent commits | 2 px short per row | `SkeletonText` rows; proof `RecentCommitsSkeletonMatches` |
| Org home activity | home | two skeleton instances (delay restarted) | one `WorkspaceActivity` instance with `workspaceSlug: null` |
| Connectors list (`ConnectorListSkeleton`) | connector rows | catalog rows, no border on last, no header text in session wait | `ConnectorListItemSkeleton`, shared `ConnectorsHeader`; proof `ConnectorRowSkeletonMatches` |
| `WorkspaceCommandPalette` | workspace results | `SkeletonRow` | kept shape; hold |
| `GithubWorkspaceDestination` | workspace picker | catalog rows | kept shape; hold |
| `GithubRepoPickerSkeleton` (repo picker, MCP wizard) | repo rows | catalog rows | kept shape; delay only |
| `EditScopeModal`, `SpacePageTree` (2) | Confluence page tree | nav rows | kept shape; hold |
| `$orgSlug.github.setup` | GitHub setup | catalog rows | kept shape; hold |
| `OrganizationApiKeysCard` | API key rows | deprecated `ShimmerPlaceholder` | `Skeleton`; hold |
| `PageBodySkeleton` (index, setup, onboarding, auth, organization settings, new workspace, GitHub setup) | session wait for a page body | generic page | kept generic; delay only. Follow-up: match each page when it is touched |
| `InlineLoader`, spinners, pulse dots | process and status waits | — | out of scope (not skeletons) |

## Resolution
