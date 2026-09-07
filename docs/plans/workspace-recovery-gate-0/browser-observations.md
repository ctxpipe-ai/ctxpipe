# Browser observations — 2026-09-07

Built Storybook using the locked dependencies and Node 22, then served the static
build at `http://127.0.0.1:6016` with `python3 -m http.server 6016 --bind 127.0.0.1 --directory apps/ui/storybook-static`.
Inspected with Codex in-app browser through CUA.

## Workspace conversation navigation

- Story: `pages-workspaces--conversation-nav-is-chat-only` (`WorkspaceSurface.stories.tsx`).
- URL: `http://127.0.0.1:6016/?path=/story/pages-workspaces--conversation-nav-is-chat-only`.
- Actions: expanded Pages/Workspaces, selected Conversation Nav Is Chat Only, selected Interactions.
- Visible result: **Story status: Fail**.
- Failed play step: `within(<div #storybook-root>).findByText("Ask about this Workspace.")`.
- Rendered text: `Ask about this Workspace. The first message creates the conversation.`
- Error: `Unable to find an element with the text: Ask about this Workspace.`

The real production compose surface rendered with navigation and Send/Files/Graph/Settings controls.
The play function failed before exercising conversation navigation. This is an
existing assertion/copy mismatch; it does not demonstrate that navigation is broken.
The static build pass is not an interaction-suite pass. Only this selected story
was inspected so far; other stories and integrated backend behavior remain unproven.
