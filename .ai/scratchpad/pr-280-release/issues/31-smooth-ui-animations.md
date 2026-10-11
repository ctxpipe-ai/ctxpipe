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

## Resolution
