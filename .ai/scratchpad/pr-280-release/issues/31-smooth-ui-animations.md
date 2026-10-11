# Remove slow and large animations that make the UI janky

Status: in progress
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The CTO reports that the UI feels janky. One or more changes added animations, and some of them move large components such as panes.

## Rule (from the CTO)

- Large components get no animation. This includes panes, panels, sidebars, page and route content, layout changes, and resizes.
- Small elements may animate only when it helps, for example a hover color, a focus ring, a menu, a tooltip, a toast, or a chevron. Each animation must be very fast. Nothing slow.

Team lead defaults, to apply unless the evidence shows a problem:
- Small elements use at most 150 ms, and 100 ms or less is preferred. Use `ease-out` for enter and no exit animation, or an exit at most as long as the enter.
- Animate only `opacity`, `transform` and colors. Never animate `width`, `height`, layout, or `transition-all` on a large element.
- Loading indicators such as a spinner or a skeleton pulse are not motion of content, so they stay.
- `prefers-reduced-motion: reduce` turns off all motion that is not needed.

## Acceptance criteria

- [ ] Each animation in `apps/ui/src` is listed with its element, duration and decision (removed, made faster, or kept with the reason). The list goes in Comments.
- [ ] The change or changes that added the janky animations are named.
- [ ] No pane, panel, sidebar, route or layout animates.
- [ ] No animation in the UI is longer than 150 ms, except loading indicators.
- [ ] The rule is written in `apps/ui/DESIGN.md`, so new code follows it.
- [ ] Storybook golden stories and UI tests pass.

## Comments

### 2026-10-11 — implementing agent: inventory and decisions

**Janky changes.**
- `f5a1e06c` "Animate the workspace pane when it opens, closes, and maximises" (2026-10-08). It added `motion.aside` + `AnimatePresence` (fade + 16 px slide, 200 ms, with a 200 ms exit that kept the pane mounted) and a 200 ms `flex-grow` transition on the pane and the chat column. Every maximise and restore re-laid out the full workspace for 200 ms.
- `57976fe5` (2026-03) added `motionwind-react` and its Vite plugin; no file used its classes.
- Older: the onboarding fades (`76f1b9e3`, `1d58a9a3`, `19452659`: 500–900 ms page, slide, and app-shell fades plus 180–320 ms navigation timers), the side nav rail width transition, and the composer view transition (`7ff889fe`, 280 ms).

**Removed (large components).**

| Element | Was | Decision |
| --- | --- | --- |
| Workspace pane open / close (`WorkspacePane`) | motion fade + slide 200 ms, exit 200 ms | removed; `motion`, `motionwind-react` and the Vite plugin removed |
| Workspace pane width lock + chat column maximise | `flex-grow` / opacity 200 ms | removed |
| Side nav burger drawer | `translate` 200 ms | removed |
| Side nav rail width | `width` 200 ms | removed |
| Rail labels, kbd hint, status dot, conversation initials, load-more, new-conversation button | opacity / width / flex 200 ms | removed |
| Graph node drawer, selection inspector | `transform` 200 ms | removed |
| Graph canvas and canvas overlay | opacity 300 ms | removed |
| Disclosure panel, tab panels | `height` (and tab panel enter / exit opacity) | removed |
| Onboarding page fade on exit | opacity 500 ms + 320 ms timer | removed (navigates at once) |
| Onboarding scene background, dot nav | opacity 700 ms | removed |
| Onboarding and setup slide content | opacity 300 / 200 ms + 180 ms timer | removed (slide changes at once) |
| Onboarding headings and blocks (`onb-in-1..3`) | rise + fade 560 ms, 60–240 ms delays | removed |
| Onboarding welcome details | opacity / translate 700 ms | removed (the typewriter text stays) |
| Onboarding root (`onboarding-fade-in`) | opacity 700 ms | removed |
| App shell after onboarding (`app-shell-fade-in`) | fade + rise 900 ms | removed |
| Composer view transition | 280 ms | removed |
| Unused `useFadeNavigate` hook (500 ms timer) | — | deleted |

**Made faster (small elements), now 100 ms.**
- Global: Tailwind `--default-transition-duration: 100ms` (was 150 ms). This covers each bare `transition` and `transition-colors` (about 90 call sites).
- `duration-200` / `duration-150` → `duration-100` (25 sites): chevrons (Disclosure, Tree, ConnectorListItem, SpacePageTree ×3), Switch track and thumb, copy-button icons and colors (CopyableBlock, OrgAtlassianOauthPanel, LinearOauthAppPanel), repository node colors (RepositoryCard, PendingGitSourceRow), Popover enter / exit, Modal overlay and dialog enter / exit.
- Tooltip enter / exit: tw-animate default 150 ms → `duration-100`.
- Workspace nav row folder / caret swap: `transition-all` 150 ms → `transition-[opacity,scale]` 100 ms.
- `transition-all` → exact property: RadioGroup, SideNavLogo (`transition-colors`); onboarding and setup carousel dots (`transition-[background-color,scale]`).
- Toast queue view transition: browser default 250 ms → 100 ms (global `::view-transition-*` rule).
- Kept as they were (already 100 ms or less): dropdown menu, hover card.

**Kept (loading indicators).** `animate-spin` (5), `animate-pulse` (12), Skeleton shimmer 1.5 s, indexing / unindexing / status pulses (0.9–1.2 s), InlineLoader bounce 1.1 s and determinate fill 150 ms, GraphWaitState fill 150 ms, ProgressBar indeterminate 1 s.

**Not changed, for the team lead.** The knowledge graph camera moves (`fitView` 300–700 ms, zoom buttons 180 ms) are canvas camera animations in Cosmograph, not CSS. They help the user follow a node. Decide if they must also drop to 150 ms or less.

**Reduced motion.** New global rule in `styles.css`: under `prefers-reduced-motion: reduce`, all transitions and animations end at once, and view transitions do not run.

**Guard.** `scripts/ci/check-ui-motion.mjs` runs in CI. It fails on a duration above 150 ms or `transition-all` in `apps/ui/src` (53 findings on the base tree, 0 now).

## Resolution
