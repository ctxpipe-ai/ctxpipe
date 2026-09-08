# Gate 2 standards review — second pass

Reviewed exact range `d87858354a783a9fd95c46785208c9b699a45e3b...6d0f0709acf9bab60caa09813e2086251aa679aa`, including all changed callers and parallel implementations. **Gate 2 standards result: FAIL.**

## Blocking documented-standard violations

1. **Retry admission drops immutable identity.** `apps/backend/src/openworkflow/workflows/workspace-tip-check.ts:163-170` delegates retry admission to `apps/backend/src/domain/workspaces/tip-resolve.ts:8-18`, which compares only `desiredSha !== activeProjectionSha`. After a same-SHA connection relink or default-branch rename whose first hydrate does not activate, later cron runs have no new `updated` result and never retry the replacement revision. This violates ADR-032:11-19: revision identity includes connection, branch, generation, and SHA; old URL/SHA fields are not proof. Compare the complete desired and active revision identities and cover same-SHA retry.

2. **Dead helpers preserve the prohibited partial-identity model.** `apps/backend/src/domain/workspaces/git-explorer.ts:19-72`, `apps/backend/src/domain/workspaces/hydrate-phases.ts:32-64`, and `apps/backend/src/domain/workspaces/hydrate.ts:101-139,157-187` reconstruct readiness/targets from legacy URL/SHA, `desiredSha`, and `indexedSha`. Exact-revision symbol tracing finds no production callers; only the adjacent `git-explorer.test.ts:12-125`, `hydrate-phases.test.ts`, and `hydrate.test.ts` characterize them. This violates ADR-032:7-19 and Gate 2’s obsolete-path deletion requirement, and contradicts `docs/plans/workspace-recovery-gate-2/status.md`’s deletion claim. Delete the helpers and their obsolete tests.

3. **Contract tests are unsliced orchestration scripts.** `apps/backend/src/domain/workspaces/chat-projection.contract.test.ts:29-277` puts parser, activation, tools, membership, graph, absence, relink, and stale/new-snapshot behavior in one test with 26 expectations. `apps/backend/src/routes/v1/workspace-files.contract.test.ts:156-193,255-312` combines unrelated tree/blob/error/security/legacy cases. `apps/backend/src/retrieval/services/code-search-projection.contract.test.ts:27-268` combines three scenarios and asserts call count at line 214 and fixture-close state at 262-268. This violates `.agents/skills/tdd/tests.md:19-23,38-45` and `.agents/skills/tdd/SKILL.md:30-37`. Split by public behavior and remove implementation-detail assertions.

## Judgment smells

- **Duplicated Code:** identical checkout-key regex/formatting exists in `apps/backend/src/domain/workspaces/derived-stores.ts:22-32` and `apps/codesearch/src/domain/repositories/paths.ts:8-18`; establish one shared protocol helper.
- **Middle Man:** `apps/backend/src/routes/v1/workspace-files-routes.ts:285-294` has two delegation-only wrappers; call `listWorkspaceCheckoutPaths` and `readWorkspaceCheckoutFile` directly.

The 77 native contracts, Linux codesearch suite, seven project typechecks, migration proof, and image build are recorded green. Exact-SHA CI and the clean Kubernetes memory rerun remain pending, so terminal completion is unproven. Gate 3-6 compatibility work is separately owned and is not reported as a Gate 2 violation.
