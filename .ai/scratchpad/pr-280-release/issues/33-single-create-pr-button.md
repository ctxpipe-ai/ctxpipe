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

- [x] With the right pane open, closed or maximized, exactly one Create PR button shows, at the top right of the conversation panel.
  - When the pane is maximized and the conversation panel is hidden, the publish actions stay reachable. Comments record how.
- [x] The button has the `git-pull-request` icon and an accessible name.
- [x] The conversation panel's top-right buttons (Commit and push, Create PR, Show PR, and any others there) have no border, and keep a visible hover and focus state.
- [x] Storybook play tests cover the pane open, closed and maximized states, and fail before the change.
- [x] UI tests and golden stories pass.

## Comments

- 2026-10-11, claude: The right pane's header shows the publish actions (Sync, Create PR, Show PR) only when the conversation column is hidden. This occurs when the pane is maximized, or below `lg` with the pane open. At `lg` and wider, with the pane beside the conversation, the pane hides its copy (`lg:hidden`). Only one copy is visible at a time.
- The Create PR button uses `IconGitPullRequest` from `@tabler/icons-react`. The UI already uses that library.
- The publish buttons use the `ghost` Button variant, which already sets `border-0`. The border the CTO saw was on the pane triggers (Files, Graph, Settings, Show pane). These sit at the top right of the conversation when the pane is closed. Review round 1 removed their `border border-white/10` class. They now use the idle tab style of the pane, with its hover and focus-visible states.
- Review round 1: `WorkspaceSurface` calls `useConversationPublish` one time, through `useWorkspaceConversationPublish`. It gives the result to the conversation header and to the pane. Before, the pane made its own call with other inputs. With no running sandbox and a pushed branch, the header showed Create PR and the maximized pane showed nothing. The story `MaximizedPaneMatchesHeader` covers this case.
- No story covers the pane open below `lg`. The golden runner uses one 1440 x 900 viewport.

## Resolution

Done on branch t33-create-pr-button. Create PR shows one time, with the `git-pull-request` icon. The pane header shows the conversation's publish actions only when the conversation column is hidden. One shared publish state feeds both headers. The pane triggers have no border. Golden stories `SingleCreatePr`, `SingleCreatePrPaneClosed`, `MaximizedPaneMatchesHeader`, `ConversationSandboxFiles` and `ConversationMaximizedSync` prove the change.
