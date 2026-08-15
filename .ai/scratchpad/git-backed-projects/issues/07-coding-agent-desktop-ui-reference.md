# Coding-agent desktop UI reference

Type: research
Status: resolved

## Question

Gather a **small** visual and interaction reference from Claude Code Desktop, Cursor, and Codex — enough to constrain a prototype, not a screenshot archive.

Capture only:

- Layout: left session/project list, centre chat, right panels/tabs
- How a project / folder / **worktree** is named in the chrome
- How new conversations appear; last-N sessions under a project
- File tree + preview + tabs; collapsing the tree when a file is selected
- Right-panel tab switchers in the top-right
- Patterns we should **not** copy (desktop-only, editor-native)

Save a few screenshots under `.ai/scratchpad/git-backed-projects/assets/ui-reference/` and write `.ai/scratchpad/git-backed-projects/assets/coding-agent-desktop-ui.md` citing each image. This feeds [Workspace UI prototype](15-project-workspace-ui-prototype.md).

## Answer

Official screenshots saved under [`assets/ui-reference/`](../assets/ui-reference/). Shared patterns: project/folder as the primary label; sessions grouped under it; centre conversation; right pane with **pane-local** tabs (Codex: Code changes | brief | tracker; docs: `Summary | Browser | +`). No vendor specifies a fixed last-N count or "collapse the file tree on select." Do not copy desktop docking, integrated terminals, or a VS Code-style explorer as web requirements.

Full write-up: [Coding-agent desktop UI reference](../assets/coding-agent-desktop-ui.md). Sol reviewed; prototype prescriptions (last-4, invented tab set) were stripped so IA stays on the prototype/grilling tickets.

## Comments

### 2026-08-15 — product-window stills (replaces page captures)

Primary set is **six product-window crops** (no marketing headline, browser chrome, or desktop): Cursor review queue, Cursor Plan + PRD, Cursor cloud-agent run, Claude Code workspace, ChatGPT Work empty, Codex workspace + Code changes tabs. Earlier full-page marketing captures were removed. Docs stills stay secondary.
