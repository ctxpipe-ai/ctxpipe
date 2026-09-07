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


## Full browser suite and integrated application (2026-09-07)

The full static Storybook test-runner invocation executes 78 suites / 371 stories:
65 suites and 347 stories pass; 13 suites and 24 stories fail; zero pending.
See `storybook-results.tsv` and raw complete Jest JSON plus command metadata in
`logs/storybook-full-browser-ui-cwd.*` / `logs/storybook-full-results.json`.
Failures include stale expected text, interaction assertions, and two runner
`__test` availability failures. Do not classify every failed story as a product
bug. The earlier root-cwd invocation failed module resolution before execution
and is retained as a harness diagnostic, not another story-failure count.

Integrated app observations use real backend on localhost:3010 and Vite on 3012.
The Home first-send user bubble disappeared after reload without assistant text.
A subsequent Send returned Clockwork. Files showed two real repository entries;
README pane eventually exposed only the README label, with no editable field in
accessibility/DOM state. Actual file API read/write/diff was tested separately.
During failed graceful shutdown the browser redirected to sign-in; API login and
history succeeded after forced restart. See `golden-journey.md` for the full
step ledger and explicit fixture bypasses. Request counts are measured from
backend browser-session logs, not estimated from screenshots.
