# Coding-agent desktop UI reference

Research date: 2026-08-13; **primary stills replaced 2026-08-15** with product-window crops (no marketing chrome, browser, or desktop). Facts for a later prototype — this file does not lock IA.

## Official visuals — product windows (primary)

These six are the set to use. Each is the **product UI only**, cropped from the live dark-mode demos on [cursor.com](https://cursor.com/), [claude.com/product/claude-code](https://claude.com/product/claude-code), and [chatgpt.com/codex](https://chatgpt.com/codex/). Do not treat surrounding marketing headlines, nav, or OS chrome as layout.

### Cursor

1. **Desktop review queue (primary):** [`ui-reference/cursor-desktop-ready-for-review.png`](ui-reference/cursor-desktop-ready-for-review.png). Three panes plus a **Cursor CLI** overlay. Left: **IN PROGRESS** / **READY FOR REVIEW** agent runs (Build Landing Page selected). Centre: prompt, reads, thought, file pills (`app/page.tsx`, `app/globals.css`), composer **Agent** + **Grok 4.6**. Right: `localhost:3000` Acme Labs preview with an inspect highlight (`Tagline · span`).
2. **Plan + PRD (primary):** [`ui-reference/cursor-plan-mission-control.png`](ui-reference/cursor-plan-mission-control.png). Left: Plan mode, clarifying **Questions** widget (radio options, Skip / Continue). Right: `feature-prd.md` with a **3 Tasks** checklist. Composer: **Plan** + **Grok 4.6**.
3. **Cloud agent run (primary):** [`ui-reference/cursor-agent-acme-dashboard.png`](ui-reference/cursor-agent-acme-dashboard.png). Sidebar grouped **This Week / This Month** by project name. Centre: one run (prompt, time worked, walkthrough video, Summary). Composer: **∞ Agent** + **Opus 5**.

### Claude Code

4. **Workspace (primary):** [`ui-reference/claude-code-workspace.png`](ui-reference/claude-code-workspace.png). Left: one project (`acme-dashboard`) with Home/Code, **+ New session**, Routines, Pinned, Scheduled, Recents, user chip. Centre: prompt + plan + `ThemeProvider.tsx` diff (+ related file chips). Right: `localhost:5173/settings` **Appearance** preview (Light/Dark, Density, Reduce motion). Composer: **Opus Extra high**.

### Codex / ChatGPT Work

5. **Work empty (primary):** [`ui-reference/chatgpt-work-empty.png`](ui-reference/chatgpt-work-empty.png). Chat / **Work** toggle. Sidebar: **Workspaces** (Codex / ChatGPT folders with timed tasks) + **Chats**. Empty canvas: “What should we get done?” Input: **Choose project**, **Ask for approval**, model **5.6 Sol Extra High**.
6. **Workspace + pane-local tabs (primary):** [`ui-reference/chatgpt-codex-workspace.png`](ui-reference/chatgpt-codex-workspace.png). Same sidebar; header `New app launch / openai/codex` with **Open** / **Commit**. Centre: thought/edit log (`hero.tsx`, `build.py`). Right tabs **Code changes | ChatGPT app launch brief | Launch readiness tracker**; Code changes shows the diffs.

## Older docs stills (secondary)

Kept for pane-local Browser tabs and Agents Window file viewer. Not the marketing demos.

- Claude web (Sanity CDN, 2026-08-13): [`ui-reference/claude-code-web.webp`](ui-reference/claude-code-web.webp)
- Cursor Agents Window docs: [`ui-reference/cursor-agents-window.png`](ui-reference/cursor-agents-window.png)
- Codex Browser docs (light): [`ui-reference/codex-app-browser.webp`](ui-reference/codex-app-browser.webp)

## Layout and project naming

- **Cursor desktop:** sidebar is a **review queue of agent runs**, labeled by task title (“Build Landing Page”), not a git worktree path. Cloud-agents view groups runs by calendar under **project names** (Acme Research Dashboard). Composer sits under the active run.
- **Codex / Work:** sidebar is **Workspaces → tasks** (Codex / ChatGPT) plus **Chats**. Task chrome shows a **repo** (`openai/codex`) and **Open / Commit**. Right pane is **pane-local tabs** (code / doc / sheet).
- **Claude Code:** sidebar is **one project** (`acme-dashboard`) with New session, Routines, Pinned, Scheduled, Recents. Session title is the task (“Add a dark mode toggle…”).

Docs still useful for Desktop-only behaviour: [Claude Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop#manage-sessions), [Cursor Agents Window](https://cursor.com/docs/agent/agents-window), [Codex worktrees](https://developers.openai.com/codex/app/worktrees).

## New conversations and recent sessions

- Cursor desktop: parallel runs in **In progress / Ready for review**; cloud view: This Week / This Month. No fixed last-N.
- Codex: new chat in the sidebar; tasks sit under a project with a duration chip (`4h`).
- Claude: **+ New session**; Recents is an unbounded task list; Scheduled / Routines are extra.

No primary source specifies a fixed “last N” count.

## File tree, preview, and tabs

- **None of the three product windows show a full-repo file tree.** Cursor shows diffs + preview/CLI. Codex shows a **changed-file diff pane** and other artifact tabs. Claude shows an inline diff plus a **product preview** window.
- Strongest tab pattern: Codex right-pane **Code changes | brief | tracker** (and the older docs `Summary | Browser | +`).
- Cursor plan uses the right pane as a **single open file** (`feature-prd.md`) with a task checklist — not an explorer.

No primary source establishes “automatically collapse the repository tree when a file is selected.”

## Patterns that are desktop-only or editor-native (do not treat as web requirements)

- Overlapping OS windows (Cursor hero CLI + browser), arbitrary docking, integrated terminals as a product requirement, local editor selection. ([Claude Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop#arrange-your-workspace), [Codex local environments](https://developers.openai.com/codex/app/local-environments))
- A permanent VS Code-style explorer, Monaco as the main canvas, many global file tabs. Cursor’s own docs still distinguish Agents Window from the classic IDE. ([Agents Window](https://cursor.com/docs/agent/agents-window#choosing-between-agents-window-and-editor))

## What this does NOT decide

- Nav structure, last-N count, right-panel tab set (`files | graph | settings` vs anything else), tree-collapse behaviour, or worktree-chip copy. Those belong to [Workspace UI prototype](../issues/15-project-workspace-ui-prototype.md) and [Workspace IA and interaction contract](../issues/16-project-workspace-ia.md).
