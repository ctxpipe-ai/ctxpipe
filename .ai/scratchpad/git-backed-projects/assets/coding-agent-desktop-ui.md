# Coding-agent desktop UI reference

Research date: 2026-08-13. Primary sources only. Facts for a later prototype — this file does not lock IA.

## Official visuals (saved)

1. **Claude Code on the web (not Desktop):** [product page](https://www.anthropic.com/claude-code) screenshot saved as [`ui-reference/claude-code-web.webp`](ui-reference/claude-code-web.webp) (source: `https://cdn.sanity.io/images/4zrzovbb/claude-com/050b07bf101bc4712abb3a7e1ba6f4d8dde33fcd-920x920.webp`). Visible: `Claude Code` header, prompt, repository path (`acme/production/apps`), branch chooser, then sessions. Evidence for **repo/branch naming**, not for Desktop pane placement.
2. **Cursor Agents Window, file viewing:** [Agents Window docs](https://cursor.com/docs/agent/agents-window) screenshot saved as [`ui-reference/cursor-agents-window.png`](ui-reference/cursor-agents-window.png) (source: `https://cursor.com/docs-static/images/agent/file-agents-window-final.png`). Visible: a narrow conversation beside a dominant file viewer; workspace-root breadcrumb; editor-like tab chrome. **No persistent repository tree** in this captured state.
3. **Codex app, chat plus Browser:** [Codex Browser docs](https://developers.openai.com/codex/app/browser) screenshot saved as [`ui-reference/codex-app-browser.webp`](ui-reference/codex-app-browser.webp) (source: `https://developers.openai.com/images/codex/app/in-app-browser-light.webp`). Visible: chat on the left; pane-local `Summary | Browser | +` switcher in the **right pane header**; a compact, collapsible changed-files summary in the transcript.

Anthropic's [Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop) is the stronger source for Desktop interactions; it does **not** provide a comparable product screenshot. The Claude visual above is the web surface.

## Layout and project naming (docs)

- **Claude Code Desktop:** every conversation is a session with independent chat history, project folder, and changes. Sessions live in a sidebar that can filter by status, project, or environment and group by project. The active session title is renamed in its top toolbar. A new session starts by choosing an environment and a **project folder**; Git sessions use isolated worktrees. Docs describe project and session names; they do **not** show a worktree name in persistent chrome. ([Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop#manage-sessions))
- **Cursor:** the Agents Window is multi-workspace. The official file-view screenshot exposes the workspace root as the first breadcrumb segment. Cursor supports isolated worktrees and reusable multi-root workspaces; docs do not prescribe one canonical project/worktree label in the chrome. ([Agents Window](https://cursor.com/docs/agent/agents-window), [worktrees](https://cursor.com/docs/configuration/worktrees))
- **Codex app:** threads are organised by projects. A permanent worktree created from a project's overflow menu becomes a project of its own and can contain multiple chats. ([launch post](https://openai.com/index/introducing-the-codex-app/), [worktrees](https://developers.openai.com/codex/app/worktrees))

## New conversations and recent sessions

- Claude: persistent **+ New session** in the sidebar. Sessions can be grouped by project, renamed, filtered, split side by side, and archived. ([Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop#work-in-parallel-with-sessions))
- Cursor: multiple agent chats and Agent Tabs, including side-by-side/grid layouts. The cited Agents Window material does **not** define a fixed project-level recent-session count. ([Cursor 3](https://cursor.com/changelog/3-0))
- Codex: a new chat can start locally or with **Worktree** selected under the composer. Sidebar can be state-filtered or chronological; archived chats live in Settings. ([worktrees](https://developers.openai.com/codex/app/worktrees))

No primary source specifies a fixed “last N” count.

## File tree, preview, and tabs

- Claude: a clicked chat/diff file path opens in a **file pane**; HTML/PDF/image/video open in the Browser pane. Chat, diff, browser, terminal, file, plan, tasks, and subagent panes can be dragged and resized; extra panes open from **Views**. This is flexible desktop docking, not a fixed web layout. ([Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop#arrange-your-workspace))
- Cursor's agent-first window uses `Cmd+P` file search and can view files without returning to the IDE. Official screenshot: conversation + file preview, breadcrumb, top tabs — **not** an always-open file tree. Cursor says the classic editor is the surface for VS Code extensions and flexible file splitting. ([Agents Window](https://cursor.com/docs/agent/agents-window))
- Codex's review pane is a **changed-file list**, not a repository explorer. Clicking a file-name background expands/collapses its diff; clicking the name normally opens the configured external editor. Strongest pane-local tab pattern in the Browser screenshot: `Summary | Browser | +`. ([review pane](https://developers.openai.com/codex/app/review), [Browser](https://developers.openai.com/codex/app/browser))

No primary source establishes “automatically collapse the repository tree when a file is selected” as a vendor pattern.

## Patterns that are desktop-only or editor-native (do not treat as web requirements)

- Arbitrary drag-and-drop pane docking, integrated terminals, OS window controls, desktop keyboard chords, local editor selection, built-in browser permission machinery. Claude versions pane/file-editor functionality as Desktop; Codex labels local environments as desktop-only. ([Claude Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop#arrange-your-workspace), [Codex local environments](https://developers.openai.com/codex/app/local-environments))
- A permanent VS Code-style explorer, Monaco as the main canvas, many global file tabs, command-palette-first navigation, Git staging at hunk granularity, or opening multiple code editors in a grid. Cursor distinguishes its agent-first window from the classic IDE; Codex normally delegates a clicked file to the user's editor. ([Cursor Agents Window](https://cursor.com/docs/agent/agents-window#choosing-between-agents-window-and-editor), [Codex review](https://developers.openai.com/codex/app/review))

## What this does NOT decide

- Nav structure, last-N count, right-panel tab set (`files | graph | settings` vs anything else), tree-collapse behaviour, or worktree-chip copy. Those belong to [Project workspace UI prototype](../issues/15-project-workspace-ui-prototype.md) and [Project workspace IA and interaction contract](../issues/16-project-workspace-ia.md).
