# Show one Create PR button, with an icon and no border

Status: done
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

On the pr-280 preview, when the Workspace right pane is open, Create PR shows two times. One button is at the top right of the conversation panel. The other is in the right pane's header, next to the maximize and close buttons. The CTO saw this on 2026-10-11.

## Spec (from the CTO)

1. Show only one Create PR button: the one at the top right of the conversation panel. Remove the one in the right pane's header. This applies with the pane open, closed or maximized.
2. Give the button the `git-pull-request` icon, from the icon set the UI already uses.
3. The buttons at the top right of the conversation panel have no border.

## Acceptance criteria

- [ ] With the right pane open, closed or maximized, exactly one Create PR button shows, at the top right of the conversation panel.
  - When the pane is maximized and the conversation panel is hidden, the publish actions stay reachable. Comments record how.
- [ ] The button has the `git-pull-request` icon and an accessible name.
- [ ] The conversation panel's top-right buttons (Commit and push, Create PR, Show PR, and any others there) have no border, and keep a visible hover and focus state.
- [ ] Storybook play tests cover the pane open, closed and maximized states, and fail before the change.
- [ ] UI tests and golden stories pass.

## Comments

- 2026-10-11, claude: The right pane's header shows the publish actions (Sync, Create PR, Show PR) only when the conversation column is hidden. This occurs when the pane is maximized, or below `lg` with the pane open. At `lg` and wider, with the pane beside the conversation, the pane hides its copy (`lg:hidden`). Only one copy is visible at a time.
- The Create PR button uses `IconGitPullRequest` from `@tabler/icons-react`. The UI already uses that library.
- The header buttons use the `ghost` Button variant. That variant already sets `border-0`, so the computed border width was already 0. The new story `SingleCreatePr` asserts this. Hover and focus-visible states did not change.
- Risk for ticket 30: the pane's `useConversationPublish` call does not pass `fallbackPrState`. When the pull-request query fails, the maximized pane can show Create PR while the conversation header shows Show PR. This change does not touch publish behavior.

## Resolution
