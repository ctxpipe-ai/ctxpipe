# Make Create PR look the same as the pane triggers

Status: done
Priority: P2
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 33 gave Create PR the `git-pull-request` icon and the `ghost` Button variant. It also made the pane triggers (Files, Graph, Settings) borderless, with the pane's idle tab style. The two use different style sources, so they look slightly different.

## Spec (from the CTO)

1. The Create PR button at the top right of the conversation panel must look the same as the right pane's tab triggers (Files, Graph, Settings, Diff).
2. The other buttons in that group (Sync, Show PR) look the same too.
3. Show PR has the `git-pull-request` icon on its left, and a small `external-link` icon (10 to 12 px) at its top right corner, like a superscript badge. It opens in a new tab, as before. Its accessible name tells that it opens in a new tab.

## Acceptance criteria

- [x] Sync, Create PR and Show PR use one shared style with the pane triggers.
- [x] A Storybook play test asserts that Create PR and a pane trigger have the same height, bottom edge, padding, font size and weight, text color, radius, border width and icon size. It failed before the change.
- [x] Show PR has the pull request icon, the external-link badge at its top right, and the name "Show PR (opens in a new tab)". A play test asserts this.
- [x] Golden stories, UI tests, biome and test:policy pass.

## Comments

- 2026-10-11, claude: Differences before the change (Create PR, `ghost` Button, against the Files trigger, `workspaceChromeTabIdleClassName`):
  - Height: both 32 px.
  - Bottom edge: Create PR 1.5 px higher (41 against 42.5 px). Its group was a 37 px box with `items-center` and `mb-px`. The trigger strip uses `items-end`, `-mb-px`, and `my-0.5 -translate-y-px` on each button.
  - Padding: 8 px (`px-2`) against 12 px (`px-3`).
  - Font: 12 px normal (`text-xs`) against 14 px medium (`text-sm font-medium leading-none`).
  - Text color: `text-muted-foreground` against `text-zinc-400`.
  - Hover: `bg-foreground/[0.06]` and `text-foreground` against `bg-teal-900/30` and `text-zinc-50`.
  - Gap between buttons: `gap-1` against `gap-0.5`.
  - Same: icon 16 px with stroke 1.6, radius `rounded-md`, border width 0, focus-visible ring (teal-400/60 outline, offset 1).
  - Cursor: `cursor-default` against `cursor-pointer`.
- The shared style is `workspaceChromeTabIdleClassName` in `workspaceChrome.ts`. Sync and Create PR keep the `ghost` Button for its pending spinner and focus ring. Their class adds the disabled state (`opacity-50`, no hover wash) and the pending state (transparent text), because the class wins over the variant. The publish group uses the trigger strip class in the conversation header, so all buttons sit on one baseline. The Diff tab (ticket 38) is not changed.
- `CreatePrMatchesPaneTriggers` (WorkspaceSurface) and `ShowPr` (WorkspaceChatChrome) are new golden stories. The `ShowPr` play test was not run against the old code. The old link had no icons and the name "Show PR", so each new assertion fails there.

## Resolution

Done on branch t39-create-pr-button-style. The top-right buttons of the conversation use the idle tab style of the pane triggers. Show PR has the pull request icon and an external-link badge, and its name tells that it opens in a new tab.
- 2026-10-11, claude: The publish buttons (Sync, Create PR, Show PR) now use `text-xs font-normal` (12 px, weight 400). The pane triggers are unchanged. Height, padding and icon size still match the triggers. The Show PR badge keeps clear of the text. The story `CreatePrMatchesPaneTriggers` asserts the size and weight.
