# Coding-agent desktop UI reference

Research date: 2026-08-13. Primary sources only. This is a compact prototype constraint, not a catalogue of every surface.

## Three useful official visuals

1. **Claude Code on the web (not Desktop):** [official product screenshot](https://cdn.sanity.io/images/4zrzovbb/claude-com/050b07bf101bc4712abb3a7e1ba6f4d8dde33fcd-920x920.webp) from the [Claude Code product page](https://www.anthropic.com/claude-code). It shows a deliberately simple hierarchy: `Claude Code`, prompt, repository path (`acme/production/apps`), branch chooser, then sessions. Use it only as evidence for repo/branch naming; do not infer Desktop pane placement from it.
2. **Cursor Agents Window, file viewing:** [official screenshot](https://cursor.com/docs-static/images/agent/file-agents-window-final.png) from the [Agents Window docs](https://cursor.com/docs/agent/agents-window). A narrow conversation remains visible beside a dominant file viewer. The file side has a workspace-root breadcrumb and editor-like tab chrome; there is no persistent repository tree in this captured state.
3. **Codex app, chat plus Browser:** [official screenshot](https://developers.openai.com/images/codex/app/in-app-browser-light.webp) from the [Codex Browser docs](https://developers.openai.com/codex/app/browser). Chat occupies the left half and a pane-local `Summary | Browser | +` switcher sits in the right pane header. The transcript keeps a compact, collapsible changed-files summary instead of becoming a full IDE.

Anthropic's current [Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop) is the stronger source for Desktop interactions, but it does not provide a comparable product screenshot. The Claude visual above is therefore intentionally labelled as the web surface.

## Interaction reference

### Layout and project naming

- **Claude Code Desktop:** every conversation is a session with independent chat history, project folder, and changes. Sessions live in a sidebar that can filter by status, project, or environment and group by project. The active session title is renamed in its top toolbar. A new session starts by choosing an environment and a **project folder**; Git sessions use isolated worktrees. The docs describe the project and session names, but do not show a worktree name in persistent chrome. ([Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop#manage-sessions))
- **Cursor:** the Agents Window is explicitly multi-workspace and works across repositories and environments. Its official file-view screenshot exposes the workspace root (`portal-website`) as the first breadcrumb segment. Cursor supports isolated worktrees and reusable multi-root workspaces, but its docs do not prescribe one canonical project/worktree label in the chrome. ([Agents Window](https://cursor.com/docs/agent/agents-window), [worktrees](https://cursor.com/docs/configuration/worktrees), [multi-root workspaces](https://cursor.com/changelog/04-24-26))
- **Codex app:** threads are organised by projects. A permanent worktree created from a project's overflow menu becomes a project of its own and can contain multiple chats. That is the clearest first-party precedent for treating a durable worktree as a named child/peer project rather than leaking its filesystem path into every conversation title. ([launch post](https://openai.com/index/introducing-the-codex-app/), [worktrees](https://developers.openai.com/codex/app/worktrees))

**Prototype constraint:** show the repository/folder name as the primary project label; show branch or worktree as a secondary chip. Keep the conversation title task-shaped. Never use a raw absolute path as the main label.

### New conversations and recent sessions

- Claude has a persistent **+ New session** action in the sidebar. Sessions can be grouped by project, renamed, filtered, split side by side, and archived. ([Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop#work-in-parallel-with-sessions))
- Cursor supports multiple agent chats and Agent Tabs, including side-by-side/grid layouts, but the cited Agents Window material does not define a fixed project-level recent-session count. ([Cursor 3](https://cursor.com/changelog/3-0))
- In Codex, a new chat can start locally or with **Worktree** selected under the composer. The sidebar can be state-filtered or switched to chronological order; archived chats live in Settings. ([worktrees](https://developers.openai.com/codex/app/worktrees), [troubleshooting](https://developers.openai.com/codex/app/troubleshooting))

No primary source specifies a fixed “last N” count. **Prototype choice:** show **four** recent sessions under the expanded project, newest first, followed by **View all**. Put **New conversation** directly under the project heading so the new thread appears immediately in that same group. The number four is a prototype density decision, not a claim about any vendor UI.

### File tree, preview, and tabs

- Claude opens a clicked chat/diff file path in a **file pane**; HTML, PDF, image, and video paths open in the Browser pane. Chat, diff, browser, terminal, file, plan, tasks, and subagent panes can be dragged and resized, and extra panes open from **Views**. This is flexible desktop docking, not a fixed web layout. ([Desktop reference](https://docs.anthropic.com/en/docs/claude-code/desktop#arrange-your-workspace))
- Cursor's agent-first window uses `Cmd+P` file search and can view files without returning to the IDE. The official screenshot shows conversation + file preview, a breadcrumb, and top tabs, but not an always-open file tree. Cursor itself says the classic editor is the surface for VS Code extensions and flexible file splitting. ([Agents Window](https://cursor.com/docs/agent/agents-window))
- Codex's review pane is a **changed-file list**, not a repository explorer. Clicking a file-name background expands/collapses its diff; clicking the name normally opens the configured external editor. Its Browser screenshot supplies the strongest pane-local tab pattern: `Summary | Browser | +`. ([review pane](https://developers.openai.com/codex/app/review), [Browser](https://developers.openai.com/codex/app/browser))

None of these primary sources establishes “automatically collapse the repository tree when a file is selected” as a vendor pattern. **Prototype choice:** make the right panel tabs **Files | Preview | Changes**. `Files` shows the tree; selecting a file switches to `Preview`, collapses the tree to a narrow back/breadcrumb affordance, and preserves the three tabs in the panel's top-right. This is an intentional responsive interaction, not copied UI.

## Patterns not to copy

- **Desktop-only:** arbitrary drag-and-drop pane docking, integrated terminals, OS app/window controls, desktop keyboard chords, local editor selection, and built-in browser permission machinery. Claude explicitly versions its pane/file-editor functionality as Desktop; Codex labels local environments as desktop-only. ([Claude Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop#arrange-your-workspace), [Codex local environments](https://developers.openai.com/codex/app/local-environments))
- **Editor-native:** a permanent VS Code-style explorer, Monaco as the main canvas, many global file tabs, command-palette-first navigation, Git staging at hunk granularity, or opening multiple code editors in a grid. Cursor distinguishes its agent-first window from the classic IDE, while Codex normally delegates a clicked file to the user's editor. ([Cursor Agents Window](https://cursor.com/docs/agent/agents-window#choosing-between-agents-window-and-editor), [Codex review](https://developers.openai.com/codex/app/review))
- **Do not copy visual ambiguity:** do not label both projects and conversations with generated task text. Keep `project → recent sessions` explicit, and keep branch/worktree metadata subordinate.

## Resulting shell for the prototype

```text
┌ Projects ─────────┬ Conversation ───────────────┬ Files | Preview | Changes ┐
│ repo-name         │ task-shaped session title  │ pane-local selected view   │
│  + New conversation                              │                           │
│  recent session 1│ chat / activity / composer  │ file, rendered preview,   │
│  … up to 4       │                              │ or diff                    │
│  View all        │                              │                           │
└───────────────────┴──────────────────────────────┴───────────────────────────┘
```

On a file selection, the right side changes state rather than adding editor chrome: `Files` tree → `Preview` with a compact back/breadcrumb control. The left project/session context and centre conversation remain stable.
