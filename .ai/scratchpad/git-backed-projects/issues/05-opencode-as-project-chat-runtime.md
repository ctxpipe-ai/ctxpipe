# OpenCode as the workspace chat runtime

Type: research
Status: resolved

## Question

Can we run **OpenCode** as the in-product workspace chat agent, inside an isolated container, scoped to a git worktree of the project repository?

Today OpenCode appears only as an **external client** we configure MCP for. There is no server-side OpenCode process.

Investigate against OpenCode's own docs/source:

- Programmatic drive (CLI, HTTP, headless session, SDK).
- Operating on an existing worktree without touching the main checkout.
- Filesystem/network isolation it already provides vs wrapping it ourselves.
- Session/transcript persistence: files on disk, git, or its own store.
- Model/provider configuration vs ctxpipe's model factory.
- License and operational constraints for a hosted multi-tenant product.
- Whether OpenCode expects to **commit/push** itself, or only edit the worktree.

Write findings to `.ai/scratchpad/git-backed-projects/assets/opencode-project-chat-runtime.md` with citations. Facts only; later grilling picks the architecture.

## Answer

**Runnable as a process, not a sandbox.** CLI / `opencode serve` (OpenAPI) / JS SDK / ACP all exist. `--dir` sets cwd, not containment. Linked worktrees are understood; ordinary edits go to that worktree, but shared Git metadata is reachable and the shell can run `git`. Permissions are allow/deny gates, not kernel isolation — wrap it. Transcripts live in OpenCode SQLite under XDG, not in the project git tree. MIT licence. Chat does not require commit/push; default bash can still do both unless denied. HTTP server is unauthenticated unless `OPENCODE_SERVER_PASSWORD` is set (Basic auth, not tenant auth).

Full write-up: [OpenCode as the workspace chat runtime](../assets/opencode-project-chat-runtime.md). Sol reviewed; the opening overclaim on `--dir` as containment was corrected.

## Comments

- 2026-08-13 — These facts still stand (OpenCode is not itself a sandbox). Product chat isolation is TanStack `withSandbox`, not wrapping `opencode serve` ourselves. See [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md).
