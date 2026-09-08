# Gate 2 — Standards review (first pass, nonterminal)

## Hard documented-standard violations

1. **Webhook tip persistence bypasses the accepted revision identity.** ADR-032 requires `WorkspaceRevision` to include generation, connection and default branch, and says desired generation/URL/SHA/connection must match (`.ai/memory/decisions/ADR-032-workspace-revision-projection-identity.md:11-13,23`). Yet `persistWorkspaceTipsOnDefaultBranchPush` still calls `persistResolvedDesiredSha` (`apps/backend/src/routes/webhooks/github/github-workspace-tip.ts:175-188`), whose CAS writes only `desiredSha` and checks generation/URL/old SHA (`apps/backend/src/models/workspaces.ts:927-955`). Route this producer through `resolveWorkspaceReadRevision`/`captureWorkspaceRevision`; delete the duplicate SHA-only writer once callers move.

2. **Linked indexing still has no immutable linked revision/connection identity.** ADR-032 says queued work carries immutable identity and repository reads use scoped credentials (`ADR-032:11,17,23-25`). `workspaceIndexInputSchema` keeps `revision` optional and explicitly exempts `role === "linked"` from matching the revision's URL/SHA (`apps/backend/src/openworkflow/workflows/workspace-index.ts:24-50`); the linked child then omits `revision` and derives a connection from the mutable repository row (`:122-157`). Add a linked-revision value containing link id/ref/SHA/connection and require it at enqueue, admission, credential resolution and publication.

3. **Chat does not consume membership and units from one snapshot.** ADR-032 requires readers needing metadata, units or membership together to consume one database snapshot and search tools to use captured membership (`ADR-032:15,17`). `workspaceChatTools` accepts a unit/projection snapshot but independently calls `loadAllowedRepositories` (`apps/backend/src/domain/workspaces/workspace-chat-tools.ts:194-213`), which issues another query (`:517-529`); search execution queries it again through `codeSearch` (`:363-368`; `apps/backend/src/retrieval/services/codeSearch.ts:138-151`). Extend `WorkspaceProjectionSnapshot` with bound repositories and pass that captured set through every tool.

4. **The proof tests violate one-test/one-behavior guidance.** TDD requires “one seam, one test” and one logical assertion (`.agents/skills/tdd/SKILL.md:34-37`; `.agents/skills/tdd/tests.md:17-23`). `hydration.contract.test.ts:49-85` drives one ~850-line body with 17 flag combinations and conditional sub-journeys (`:252-771`); `index-workflow.contract.test.ts:77-733` is one test spanning admission, search, graph, failure/retry, linked publication and tip refresh. Extract shared `NativeHydrationFixture`/`NativeIndexFixture` lifecycle helpers, then create named tests per required Gate-2 proof; retain one 100-file budget case.

## Judgement smells

- **Data Clumps / Primitive Obsession:** `workspace-index.ts:24-50` carries `workspaceId`, URL, SHA and generation beside `revision`, then validates equality. Make revision mandatory and keep only linked-specific identity alongside it.
- **Duplicated Code:** identical signed-revision target checks appear in `apps/codesearch/src/routes/indexPhases.ts:299-308` and `apps/codesearch/src/routes/repo.ts:414-423`. Move admission to one auth helper returning the authorized checkout/target.

