# Gate 4 narrow Standards review — `abea04b8`

**Pinned range:** `c8b502a689df7113194b4c00de53519cc4667350...abea04b839a6e9ef41b494385ed57ef92f12ce58`. I reviewed the production callers, native sandbox patch, native fixtures, ADR-034, and committed evidence. Declared later provider/fork work was excluded.

## Documented violations / blockers

**None (0).**

Production now holds one static definition for each supported provider (`tanstack-workspace-chat.ts:112-157`). Each invocation constructs a runtime workspace whose immutable identity includes the captured revision and selected image while credentials remain secret runtime values (`:261-300,343-405,487-550,554-601`). Prepare, chat middleware, and snapshot creation receive that same workspace explicitly.

The exact-version native patch consistently threads the captured workspace through key hashing, create/resume/restore, secret refresh, projection, watch roots, hooks, snapshot hashing/capture, named snapshots, and destroy (`patches/@tanstack__ai-sandbox@0.5.0.patch:23-194,224-280,294-588`). `ensureExisting` also hashes `ctx.workspace`; named snapshots stage the identity and resolved data before later operations. This implements ADR-034's native ownership extension without an application registry or cached handle. Source, ESM output, and declarations are all patched, the package version is pinned in `pnpm-workspace.yaml`, and ADR-034 records both retained proof and the upstream deletion condition.

Unlocked selection uses the same bounded Docker client probe as the provider (`sandbox-provider.ts:37-52`); an explicit provider setting remains authoritative. The Docker image is digest-pinned and included in the runtime identity (`chat-runtime.ts:18-28`), preventing an image change from reusing an old worktree.

The native regression exercises two bindings concurrently through one definition, credential rotation, named snapshot bytes, selective teardown, unlocked real-Docker discovery, captured SHA, and worktree reuse. This follows the real-infrastructure proof rule in `apps/backend/AGENTS.md:23`. Committed evidence records 18/18 cases and zero new backend type diagnostics; I did not rerun tests.

## Fowler heuristic judgments

No new heuristic. The previously retained nonblocking **Data Clumps** judgment remains unchanged.

**Counts:** 0 blockers; 0 new heuristics; 1 retained nonblocking heuristic. This is not Gate 4 acceptance.
