# Coding-agent desktop UI reference

Research date: 2026-08-13; **marketing demos recaptured 2026-08-15** in dark mode from the three product pages. Facts for a later prototype — this file does not lock IA.

## Official visuals — marketing demos (primary)

Captured from the live pages (dark). The **demo block** on each page is the source; surrounding marketing chrome is not a layout prescription.

### Cursor — [cursor.com](https://cursor.com/)

1. **Hero desktop (primary):** [`ui-reference/cursor-com-hero-desktop.webp`](ui-reference/cursor-com-hero-desktop.webp). Three overlapping surfaces: left **READY FOR REVIEW** agent list (Build Landing Page, Plan Mission Control, …); centre agent transcript (reads, diffs `app/page.tsx`); right **localhost preview** (Acme Labs) plus **Cursor CLI** follow-up. Composer: Agent + model.
2. **Plan + PRD (support):** [`ui-reference/cursor-com-plan-prd.webp`](ui-reference/cursor-com-plan-prd.webp). Agent asks clarifying questions; right pane is `feature-prd.md` with a **3 Tasks** checklist.
3. **Cloud agents list (support):** [`ui-reference/cursor-com-cloud-agents.webp`](ui-reference/cursor-com-cloud-agents.webp). Sidebar grouped **This Week / This Month** by project name; centre is one agent run + walkthrough video.

### Codex — [chatgpt.com/codex](https://chatgpt.com/codex/)

1. **Workspace, dark mode task (primary):** [`ui-reference/chatgpt-codex-workspace-dark-mode.webp`](ui-reference/chatgpt-codex-workspace-dark-mode.webp). Left: Projects (Codex / ChatGPT) with timed tasks + Chats. Centre: “Implement dark mode” on `openai/codex`, thought/explore/edit log. Right: file diff (`src/theme.ts`). Header **Open** / **Commit**.
2. **Workspace, pane-local tabs (primary):** [`ui-reference/chatgpt-codex-workspace-code-tabs.webp`](ui-reference/chatgpt-codex-workspace-code-tabs.webp). Same chrome; right pane tabs **Code changes | ChatGPT app launch brief | Launch readiness tracker**; Code changes shows `hero.tsx` + `build.py` diffs.
3. **Spreadsheet tab (support):** [`ui-reference/chatgpt-codex-workspace-spreadsheet-tab.webp`](ui-reference/chatgpt-codex-workspace-spreadsheet-tab.webp). Same tabs; Launch readiness tracker XLSX.
4. **Agent result card (support):** [`ui-reference/chatgpt-codex-agent-result-card.webp`](ui-reference/chatgpt-codex-agent-result-card.webp). Compact “Implement dark mode” card: thought time, files explored, **Changed N files**, **Review**.
5. **Sidebar + worktrees copy (support):** [`ui-reference/chatgpt-codex-sidebar-worktrees.webp`](ui-reference/chatgpt-codex-sidebar-worktrees.webp). Pinned items; page copy: Codex as command center with **built-in worktrees** and cloud environments.
6. **Hero Work empty (support):** [`ui-reference/chatgpt-codex-hero-work-empty.webp`](ui-reference/chatgpt-codex-hero-work-empty.webp). Chat / **Work** toggle; “What should we get done?”

### Claude Code — [claude.com/product/claude-code](https://claude.com/product/claude-code)

1. **Hero workspace (primary):** [`ui-reference/claude-com-hero-workspace.webp`](ui-reference/claude-com-hero-workspace.webp). Left: `acme-dashboard` Home/Code, **+ New session**, Pinned / Scheduled / Recents. Centre: prompt + plan + `ThemeProvider.tsx` diff. Right: localhost **Appearance** preview (Light/Dark).
2. **Diff + settings (support):** [`ui-reference/claude-com-workspace-diff.webp`](ui-reference/claude-com-workspace-diff.webp). Closer crop: recents, multi-file edits, Appearance overlay.
3. **Done + PR (support):** [`ui-reference/claude-com-workspace-done-pr.webp`](ui-reference/claude-com-workspace-done-pr.webp). Edited files + commands; branch/PR chip `#112 … claude/settings-dark-mode-…`; CI passing.

## Older docs stills (secondary)

Kept for pane-local Browser tabs and Agents Window file viewer; they are **not** the marketing demos.

- Claude web (Sanity CDN, 2026-08-13): [`ui-reference/claude-code-web.webp`](ui-reference/claude-code-web.webp)
- Cursor Agents Window docs: [`ui-reference/cursor-agents-window.png`](ui-reference/cursor-agents-window.png)
- Codex Browser docs (light): [`ui-reference/codex-app-browser.webp`](ui-reference/codex-app-browser.webp)

## Layout and project naming

From the **demos** (plus docs where the mock is silent):

- **Cursor:** sidebar is a **review queue of agent runs**, labeled by task title (“Build Landing Page”), not a git worktree path. Cloud-agents mock groups runs by calendar under **project names** (Acme Research Dashboard). Composer sits under the active run.
- **Codex:** sidebar is **Projects → tasks** (Codex / ChatGPT) plus **Chats**. Task chrome shows a **repo** (`openai/codex`) and **Open / Commit**. Right pane is **pane-local tabs** (code / doc / sheet) — same idea as the older Browser docs `Summary | Browser | +`.
- **Claude Code:** sidebar is **one project** (`acme-dashboard`) with New session, Routines, Pinned, Scheduled, Recents. Session title is the task (“Add a dark mode toggle…”). Result chrome can show a **branch/PR** id, not a host worktree path.

Docs still useful for Desktop-only behaviour: [Claude Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop#manage-sessions), [Cursor Agents Window](https://cursor.com/docs/agent/agents-window), [Codex worktrees](https://developers.openai.com/codex/app/worktrees).

## New conversations and recent sessions

- Cursor hero: parallel runs in a **Ready for review** list; cloud mock: This Week / This Month. No fixed last-N.
- Codex: new chat in the sidebar; tasks sit under a project with a duration chip (`4h`).
- Claude: **+ New session**; Recents is an unbounded task list; Scheduled / Routines are extra.

No primary source specifies a fixed “last N” count.

## File tree, preview, and tabs

- **None of the three marketing demos show a full-repo file tree.** Cursor shows diffs + preview/CLI. Codex shows a **changed-file diff pane** and other artifact tabs. Claude shows an inline diff plus a **product preview** window.
- Strongest tab pattern: Codex right-pane **Code changes | brief | tracker** (and the older docs `Summary | Browser | +`).
- Cursor plan mock uses the right pane as a **single open file** (`feature-prd.md`) with a task checklist — not an explorer.

No primary source establishes “automatically collapse the repository tree when a file is selected.”

## Patterns that are desktop-only or editor-native (do not treat as web requirements)

- Overlapping OS windows (Cursor hero CLI + browser), arbitrary docking, integrated terminals as a product requirement, local editor selection. ([Claude Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop#arrange-your-workspace), [Codex local environments](https://developers.openai.com/codex/app/local-environments))
- A permanent VS Code-style explorer, Monaco as the main canvas, many global file tabs. Cursor’s own docs still distinguish Agents Window from the classic IDE. ([Agents Window](https://cursor.com/docs/agent/agents-window#choosing-between-agents-window-and-editor))

## What this does NOT decide

- Nav structure, last-N count, right-panel tab set (`files | graph | settings` vs anything else), tree-collapse behaviour, or worktree-chip copy. Those belong to [Project workspace UI prototype](../issues/15-project-workspace-ui-prototype.md) and [Project workspace IA and interaction contract](../issues/16-project-workspace-ia.md).
