# Backend, codesearch, and sandbox-runner topology

Type: grilling
Status: claimed
Blocked by: 01, 05, 06, 17

## Question

With knowledge moving to git and chat running through TanStack `withSandbox` (see [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md)), how many **deployables** do we keep, and **where does `dockerSandbox()` get a Docker daemon**?

Do **not** propose spawning `opencode serve` or `docker run` ourselves. Chat isolation is a TanStack `SandboxProvider`. Options to grill (add or kill with a named failure mode):

1. **Merge backend and codesearch**, and give that process a Docker API (socket or sibling). `withSandbox` + `dockerSandbox` runs next to Zoekt. Cost: extra instances duplicate in-memory Zoekt; Docker socket is root-equivalent on Compose.
2. **Keep them separate.** Backend (the process that calls `chat()`) gets Docker for `dockerSandbox`. Codesearch keeps `/data` for Zoekt. Independent disks. Railway: backend still cannot mount a volume *and* typically has no Docker API.
3. **Keep them separate, shared disk on one machine.** Already looking dishonest on Railway (one volume per service, no replicas). Unlikely to be the chat isolation story now that the agent tree is inside the TanStack container.
4. **Backend calls `withSandbox`; provider is not `dockerSandbox` on hosted.** Compose uses `dockerSandbox`. Railway/Fargate use a TanStack provider we did not write OpenCode for — either an official cloud provider (Daytona / Vercel / Sprites) or a small `SandboxProvider` adapter over Railway Sandboxes / ECS `RunTask` that still goes through `withSandbox`. **Not** a third service that shells OpenCode.

Hold:

- Prefer simplicity; we are not designing a mesh.
- Chat must not write the host main tree — TanStack clones into the sandbox ([Workspace](https://tanstack.com/ai/latest/docs/sandbox/workspace)).
- Freshness of codesearch clones uses **stored revision state**, not a git remote on the hot path (see [Project revision and derived-store freshness](11-project-revision-and-freshness.md)).
- Reopening [ADR-008](../../../memory/decisions/ADR-008-codesearch-zoekt-orchestration.md) is allowed if we merge; say so.

Recommend one option. Name each rejected option's killing failure mode. "It might be nice later" is not a reason to keep a deployable.
