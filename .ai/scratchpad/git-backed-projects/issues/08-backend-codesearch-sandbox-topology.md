# Backend, codesearch, and sandbox-runner topology

Type: grilling
Status: open
Blocked by: 01, 05, 06

## Question

With knowledge moving to git and chat running in an isolated container on a worktree, how many **deployables** do we keep, and who owns disk?

Do **not** assume the backend/worker owns the chat worktree. Options to grill (add or kill with a named failure mode):

1. **Merge backend and codesearch.** One deployable owns API, OpenWorkflow, Zoekt, clones, sandboxes. Simpler. Cost: extra instances duplicate in-memory Zoekt.
2. **Keep them separate, independent disks.** Backend/worker (or a sandbox runner) check out for worktrees; codesearch keeps `/data` for Zoekt + its clone.
3. **Keep them separate, shared disk on one machine.** One checkout tree visible to several services. Only honest if [Deployment storage and Docker-sandbox constraints](06-deploy-storage-and-sandbox.md) says the providers can do it under replica counts we actually run.
4. **Separate sandbox runner.** Codesearch stays the Zoekt/clone service (ADR-008). Backend stays API + workflows. A third unit (or per-conversation task) owns the worktree, OpenCode, and the isolated container. Backend never needs a repo disk.

Hold:

- Prefer simplicity; we are not designing a mesh.
- Chat sandbox must not write the main tree.
- Freshness of clones uses **stored revision state**, not a git remote on the hot path (see [Project revision and derived-store freshness](11-project-revision-and-freshness.md)).
- Reopening [ADR-008](../../../memory/decisions/ADR-008-codesearch-zoekt-orchestration.md) is allowed if we merge; say so.

Recommend one option. Name each rejected option's killing failure mode. "It might be nice later" is not a reason to keep a deployable.
