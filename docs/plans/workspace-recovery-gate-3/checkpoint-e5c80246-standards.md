# Standards review — `e5c80246f08b2d5c41d7cf5f8eb72543cd8b8768`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e5c80246f08b2d5c41d7cf5f8eb72543cd8b8768`
**Result:** 0 documented violations; 4 heuristic smells; 0 blockers.

## Documented-standard violations

None found in the implemented scope. The prior capture-pairing breach is closed: both HTTP routes capture the registered handle and metadata together, `planCapturedConversationPublication` rejects URL/connection/generation/SHA/default mismatches, the broker rechecks the full binding before push, and publication state is saved by a binding-fenced transaction (`conversation-publish.ts:37-61,116-140,242-267`; `models/conversations.ts:124-164`). This satisfies ADR-033:20,25 and ADR-027:13. Repository API consumers now request exact repository and permission scopes, and the sandbox receives no credential. The proof reference and `writeToken` name are corrected (`apps/backend/AGENTS.md:23`; `conversation-publish.ts:161-162`). The thin-pack path streams file input into native Git rather than buffering the large base (`conversation-publish.ts:155-241`; `services/git/pack.ts:15-43`).

## Fowler heuristic smells (judgment calls)

- **Duplicated Code:** installation lookup, row resolution, app construction and token minting recur in `getInstallationOctokitForOrg` and `getInstallationToken` (`github-installation.ts:721-743,778-819`). Extract one scoped-token resolver and build Octokit only in the client-returning wrapper.
- **Duplicated Code:** direct push and PR routes repeat sandbox/revision capture, planning and branch publication (`conversation-files-routes.ts:535-568`; `routes/v1/conversations.ts:777-817`). A shared publication-preparation service would keep their fences aligned.
- **Duplicated Code (remaining):** five typed admission arms repeat parse → persist → bind → wake → return (`enqueue-workspace-write-commit.ts:217-358`). Share that typed admission shape.
- **Data Clumps (remaining):** Linear, Notion and Confluence finalizers repeatedly carry `connectionId/repositoryId/branch/workflowStatus` (`linear-sync-content.ts:181-187`; `notion-sync-content.ts:152-158`; `confluence-sync-content.ts:126-132`). Introduce one captured-finalization identity type.

Committed native/API evidence was inspected, not rerun. Declared connector/planning/topology work was not treated as checkpoint failure.
