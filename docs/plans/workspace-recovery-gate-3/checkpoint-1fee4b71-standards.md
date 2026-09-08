# Standards review — `1fee4b7142bd89ecd4e8280315c97dfb08fe665e`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...1fee4b7142bd89ecd4e8280315c97dfb08fe665e`
**Result:** 2 documented violations; 3 heuristic smells; 1 implemented-scope blocker.

## Documented-standard violations

1. **[Blocker] Conversation publication does not fence the captured sandbox binding.** `pushConversationSessionBranch` receives a handle plus the caller’s current revision, and `assertBinding` compares only that revision with the current workspace (`conversation-publish.ts:62-110`); no captured URL/generation/SHA accompanies the Git objects. The push route resolves an existing handle and then independently reads the current revision (`conversation-files-routes.ts:530-548`) without the PR route’s metadata plan. The PR route also reads workspace, revision and sandbox separately (`conversations.ts:787-818`), leaving a relink interleaving. An old-repository sandbox can consequently be packed and pushed to the newly linked repository. This violates ADR-033:25: “Full binding identity is checked immediately before push.” Pass the captured sandbox identity into the broker, fail closed when absent/mismatched, and prove stale push plus relink-between-reads over both HTTP endpoints. The current stale HTTP case exercises only PR with a stable registered mismatch (`conversation-publish-native.contract.test.ts:24-97`).

2. **Backend proof guidance points to a deleted test.** `apps/backend/AGENTS.md:23` names `job-sandbox.live.test.ts`, deleted in this range, while `.agents/skills/tdd/mocking.md:17` names the replacement native contracts. Update the mandatory guidance so future route/Git proof does not follow a dead link.

## Fowler heuristic smells (judgment calls)

- **Duplicated Code (remaining):** five admission arms repeat parse → persist → mark bound → wake → return (`enqueue-workspace-write-commit.ts:217-358`). Share that typed admission shape.
- **Data Clumps (remaining):** Linear/Notion/Confluence finalizers still carry `connectionId/repositoryId/branch/workflowStatus`; introduce one captured-finalization identity type.
- **Mysterious Name:** `token` beside `readToken` (`conversation-publish.ts:156-218`) should be `writeToken` so credential scope stays explicit.

The paused-owner claim/cancellation and local-dispatch violations are fixed. Export follow-ups now start from successful hydration, including replay/no-op, and the export handoff uses read access.
