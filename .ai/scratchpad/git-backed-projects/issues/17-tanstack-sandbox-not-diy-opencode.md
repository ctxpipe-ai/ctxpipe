# Chat uses TanStack sandbox, not DIY OpenCode

Type: grilling
Status: resolved

## Question

Do we drive OpenCode ourselves (`opencode serve`, our own containers, host git worktrees, custom process lifecycle), or do we use TanStack AI's documented sandbox + harness path?

## Answer

**Use TanStack's path. Do not orchestrate OpenCode by hand.**

Product chat is:

```ts
chat({
  adapter: opencodeText(model, { permissionMode: 'acceptEdits' }),
  threadId,
  messages,
  middleware: [withSandbox(defineSandbox({
    id: '…',
    provider: dockerSandbox({ image: '…' }), // or another TanStack provider where Docker is absent
    workspace: defineWorkspace({ source: githubRepo({ repo, ref }) /* or gitSource / local */ }),
    lifecycle: { reuse: 'thread', snapshot: 'after-setup' },
  }))],
})
```

That is the documented composition:

- [Sandbox overview](https://tanstack.com/ai/latest/docs/sandbox/overview) — `withSandbox` resumes/creates/bootstraps; the harness runs **inside** the sandbox; `chat()` fails fast if a harness requires a sandbox and none is provided.
- [Quick start](https://tanstack.com/ai/latest/docs/sandbox/quick-start) — `dockerSandbox` + `defineWorkspace` + harness adapter; Docker daemon required on the host that runs `chat()`.
- [OpenCode adapter](https://tanstack.com/ai/latest/docs/adapters/opencode) — `opencodeText` is the harness; swapping Grok/Claude/Codex/OpenCode is the adapter line. Docs say spawning `opencode serve` on the **host** is giving it a shell on that machine; the sandbox middleware is how you avoid that.
- [Workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace) — TanStack clones (`githubRepo` / `gitSource`, shallow by default) or uses `{ type: 'local', path }`. The agent working tree is **inside the sandbox**, so the host main checkout is not the write target.
- [Lifecycle](https://tanstack.com/ai/latest/docs/sandbox/lifecycle) — `reuse: 'thread'` is one sandbox per `threadId`; ensure order is resume → restore snapshot → create+bootstrap.

**Forbidden for chat:** starting `opencode serve` ourselves, `docker run` / sibling-DinD orchestration of OpenCode, host `git worktree add` as the chat isolation mechanism, custom process supervisors around the OpenCode CLI.

**Still open (not this ticket):** how each deploy target supplies a TanStack **provider** (Compose can give `dockerSandbox` a daemon; Railway/Fargate have no first-party TanStack provider). That stays on [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md). A custom `SandboxProvider` that still goes through `withSandbox` is in-bounds; a homemade OpenCode lifecycle is not.

**Ops vs chat:** [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md) later locked a **second** TanStack path: folder-map ops (`AGENTS.md`) use `chat()` **without** sandbox/harness. That is not product chat and does not reopen DIY OpenCode.

Human lock, 2026-08-13, after the research write-up still listed DIY orchestration as an option.
