# OpenCode as the project chat runtime

Type: research
Status: claimed

## Question

Can we run **OpenCode** as the in-product project chat agent, inside an isolated container, scoped to a git worktree of the project repository?

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
