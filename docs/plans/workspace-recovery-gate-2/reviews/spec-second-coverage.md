# Gate 2 SPEC review — second-pass coverage supplement

## Review identity and verdict

- Fixed base: `d87858354a783a9fd95c46785208c9b699a45e3b`
- Reviewed candidate: `6d0f0709acf9bab60caa09813e2086251aa679aa`
- Three-dot range: `git diff d87858354a783a9fd95c46785208c9b699a45e3b...6d0f0709acf9bab60caa09813e2086251aa679aa`
- Gate 0 authority: `docs/plans/workspace-recovery-gate-0/changed-files.txt` (801-file sorted scope manifest), with `baseline.md` and the Gate 0 directory as provenance.
- Prior review: `docs/plans/workspace-recovery-gate-2/reviews/spec-first.md`; all five original findings are implemented in the reviewed candidate at their principal paths (connection-only `updateWorkspace`, common tip policy, complete linked CAS, provider-neutral canonical `connectionId`, explicit `legacyWorkspace`). The duplicate-create and other paths below are distinct remaining bypasses.
- Verdict: **BLOCKED** by correctness/security/performance/spec-oracle findings below. The later clean Kubernetes rerun was reported passing at 5,484,331,008 bytes with exit 0 including cleanup. Exact-pushed-SHA CI had main Tests and all type jobs passing, with two codesearch jobs still pending. These facts are evidence status, not terminal acceptance.

## Requirement-by-requirement matrix

| Gate 2 requirement / locked invariant | Result | Evidence |
| --- | --- | --- |
| 1. `WorkspaceRevision` + `ProjectionState` at DB seam; temporary mappings | **Partial** | `domain/workspaces/revision.ts`; `models/workspaces.ts`; migration `20260908012604_workspace-revision-identity`. Complete canonical values exist and upgrade proof preserves legacy state. Duplicate-create and FK/repository connection mutation paths bypass generation identity. |
| 2. Resolve immutable revision in one product-policy function | **Fail** | `resolve-revision.ts` centralizes tip/credential policy, but candidate lines 84–87 reject `desiredSha = null` instead of resolve-if-null. Create/delete/shared-rebind writers also mutate identity outside that policy. |
| 3. One native checkout/read path; no per-file GitHub contents loop | **Pass for hydrate; fail hot-reader contract** | `workspace-hydrate.ts` uses `listMarkdownFilesAtGitSha`; `clone-tree.ts` uses one tree listing and `cat-file --batch`; no hydrate provider loop found. Files reuse the fetch helper per request instead of the published index required by issue 11:102; workspace chat filters `glob_files/get_file` out entirely. Remaining GitHub `getContent` calls are write/MCP-config paths outside hydrate and owned by later gates. |
| 4. Pure parse + single generation/SHA CAS activation | **Pass with temporality defect** | `hydrateKnowledgeTree` is pure; `commitHydrateProjection` conditionally updates full identity and replaces units/membership in one transaction (`models/workspaces.ts:1073–1191`). Missing `valid_from` derivation is absent before activation. |
| 5. Embedding, graph, search freshness as derived results | **Fail** | Embedding/index results are fenced. Search drops the last published index during replacement/failure. `StoreFreshness.graph` is hard-coded PostgreSQL; no Falkor projection/result exists. |
| 6. Route hydrate/search through canonical value; delete obsolete reconstruction/provider models | **Fail** | Hydrate, index, search, SCIP, structural search, chat snapshots, and codesearch JWT mostly carry canonical values. Hot Files read active Git directly. Dead primitive reconstruction helpers remain. Provider-specific DB columns are documented Gate 6 mappings, but live FK mutation bypasses identity. |
| Same-SHA no-op | **Pass** | Named hydration/native PostgreSQL contracts; embedding/index retries skip completed independent phases. |
| Rewind | **Pass** | Native default-branch/tip and hydrate contracts accept non-monotonic SHA changes. |
| Relink/generation race | **Fail** | `updateWorkspace` principal path passes; duplicate-create ordinary/race branches and connection deletion/shared repository mutation bypass reset. Post-candidate regressions were reported for duplicate-create only. |
| Malformed files | **Pass** | Pure parser skips malformed files and activation continues; named hydration contract. |
| Deletion / atomic replacement | **Pass** | PostgreSQL transaction deletes prior workspace units/membership then inserts the revision set; rollback proof retains prior snapshot. |
| 100-file call budget | **Pass** | Native batch reader and required contract evidence: eight-command ceiling. |
| Embedding failure | **Pass** | PostgreSQL stays active; failed result is fenced and retryable from captured units. |
| Index failure | **Fail oracle/behavior** | Failure is recorded independently, but the contract asserts search becomes empty and has no previously published different SHA. Locked behavior requires continuing to serve it. |
| No partially exposed active revision | **Pass** | One-statement snapshot and transaction rollback/membership contracts. |

## Blocking findings

### Correctness and security

1. **Credential-identity mutation bypass.** Candidate `models/workspaces.ts:552–568,649–665` mutates an existing workspace’s connection in duplicate create without `nextRelinkFields`. `connections` deletion automatically nulls both workspace and repository foreign keys (`db/schema/workspaces.ts:29–31`, `db/schema/repositories.ts:62–65`) without enqueue/reset. `workspace-lifecycle.ts:30` → `ensure-org-repository.ts:37–44,57–64` → `models/repositories.ts:256–270` can rebind an org-shared repository while every linked row retains desired/indexed SHA. A linked index can therefore remain authorized/published under a credential identity different from the one captured. Required fix: one transactional lifecycle command for every connection mutation, resetting owner generation or linked desired/indexed state as applicable, with real PostgreSQL create-race, connector-delete, and cross-workspace shared-link contracts.

2. **Published-index state is conflated with active revision freshness.** `projectionFromWorkspace` exposes index ready only for the active `WorkspaceRevision`; `commitHydrateProjection` overwrites `hydratePhases`; failure clears `indexedSha`; snapshot authorization admits only the active revision when ready. Preserve a separate last-published index revision/repository set through hydrate and failed replacement, while keeping staged B invisible until activation. Prove A remains searchable after B activates but before/failing B index, then B atomically replaces it.

3. **Resolve-if-null missing.** Candidate `resolveWorkspaceReadRevision` throws before resolution when `desiredSha` is null, and normal enqueue/hydrate callers do not set refresh. Implement the issue-11 start rule in the common resolver and cover new, relinked, and retry invocations. Parent reported post-candidate initial/generation-2 proofs passing; they require re-review at the new SHA.

4. **Temporality contract omitted.** Candidate hydrate calls `applyEffectiveValidFromToUnits(parsed.units, null)`. Issue 02 requires each missing value to derive from the file/claim’s introducing commit, not merely the revision timestamp. `looksLikeGitSha` accepts at most 40 characters despite canonical 64-hex SHA support. Add native per-file history acquisition within a bounded command budget and a deterministic PostgreSQL/recall proof for multiple file introduction commits plus SHA-256.

5. **Graph derived store removed without a decision.** Gate 2 line 629 explicitly includes graph. Issue 02 says Falkor is derived from hydrated PostgreSQL through `project()`; issue 13 requires the workspace-scoped Falkor graph tool family. Candidate instead hard-codes `{kind:"postgres"}` and constructs a local unit graph. Implement and fence Falkor projection/result, or reopen and update the locked design plus recovery plan before changing behavior. Prove pending/failure/stale behavior and workspace isolation.

6. **Files hot path fetches a remote clone, and chat omits required tools.** Every Files list/read calls `mkdtemp`, `git init`, credential resolution and `git fetch`. Besides violating issue 11:102, this makes file browsing fail when the old remote/credential disappears after relink and gives request cost proportional to remote fetch latency. Issue 13:84–92 requires workspace chat to expose `glob_files/get_file`, but `workspace-chat-tools.ts:203–209,292` filters both out. Route these tools and Files HTTP through the captured last-published immutable checkout/index; prove tool presence, zero remote/tip calls and continued stale service.

### Migration

- Fresh/upgrade migrations correctly avoid fabricating historical `activeRevision`; legacy projections remain explicit.
- Blocking migration invariant: existing `ON DELETE SET NULL` constraints perform identity writes behind the lifecycle/CAS model. Schema/model deletion must preserve access revocation while transactionally invalidating affected desired/index state.

### Performance

- Hydrate’s 100-file native batch budget passes.
- Blocking regression: `listPathsAtGitSha` and `readFileAtGitSha` each fetch a fresh temporary repository on the interactive hot path. No Files request-count/remote-call budget covers this incorrect source.

### Test oracles

- `index-workflow.contract.test.ts:746–766` codifies empty search after failure and never seeds a prior different published SHA.
- No contract observes introducing-commit timestamps during production hydrate; helper unit tests only pass a supplied scalar.
- Graph proofs validate the replacement PostgreSQL implementation, not the required Falkor projection/freshness lifecycle.
- No connector-deletion or shared-repository rebind race proof covers revision/link invalidation.
- No chat contract requires or executes `glob_files/get_file`; their deliberate filtering currently passes.
- Exact-SHA CI remained incomplete at review handoff (two codesearch jobs pending); terminal review must use the corrected, pushed SHA.

## Obsolete owners and compatibility state

| Remaining path | Reachability / disposition |
| --- | --- |
| `domain/workspaces/git-explorer.ts:19–71` `workspaceGitExplorerTarget` and primitive remote reconstruction | Only `git-explorer.test.ts` callers found. Delete now under Gate 2 line 630–631. It can combine active URL with the current connection. |
| `hydrate.ts` `hydrateReadsStoredDesiredSha`, `hydrateIsNoop`, `shouldReplaceKnowledgeProjection` | Only `hydrate.test.ts` callers found. Superseded by revision equality/model snapshot. Delete tests/helpers. |
| `hydrate-phases.ts` `pendingHydratePhases`, `hydrateHasPendingWork` | Only `hydrate-phases.test.ts` callers found. Production calculates canonical phase state directly. Delete. |
| Hydrate workflow primitive `generation/url/sha/defaultBranch` input | No production enqueue supplies these; canonical enqueue supplies `revision`. Confirm durable old-command compatibility policy, then delete or explicitly document bounded migration compatibility. |
| `repositories.lastIngestedHash` / default checkout | Still used by generic org repository ingestion, but workspace projection/search paths do not use it as workspace truth. Keep owned by generic ingestion until Gate 6 verifies removal/retention. |
| `active_projection_*`, `indexed_sha`, `github_connection_id` DTO/schema fields | ADR032 calls these temporary DB/wire mappings. Gate 6 owns removal after upgrade proof; they must not gain new policy writers meanwhile. |
| Desired-SHA chat/sandbox runtime and direct GitHub warm-turn calls | Gate 4 owns sandbox/chat lifecycle and warm-turn provider removal. Desired URL+SHA is the locked sandbox snapshot identity; do not incorrectly route sandbox startup to active projection. |
| UI transitional projection fields/polling | Gate 5 owns UI workflow collapse; Gate 2 only needs truthful backend DTOs and captured retrieval. |
| Write workflow/runner and provider content writes | Gate 3 owns transactional write-command convergence and deletion. |

## Codebase coverage map

| Subsystem / entry points searched | Files and conclusion |
| --- | --- |
| Scope/provenance/docs | Gate 0 `baseline.md`, `changed-files.txt`, Gate 1 terminal handoff, Gate 2 `status.md`, `spec-first.md`, recovery spec 515–730, ADR032, issues 02/09/11/13. Gates 3–6 ownership was preserved. |
| Schema/migrations/RLS | `db/schema/workspaces.ts`, `repositories.ts`, `connections.ts`; new revision migration SQL/snapshot; fresh/upgrade logs. Found FK identity bypass; no fabricated active identity. |
| Workspace model/lifecycle | All `models/workspaces.ts` projection, snapshot, capture, activation, failure, embedding/index, linked membership/tip paths; `workspace-lifecycle.ts`, `relink.ts`, `ensure-org-repository.ts`, create/update/delete routes. Found duplicate-create and shared-rebind bypasses. |
| Connector/auth mutation | GitHub installation delete route/model, repository connection setter, connector destination routes, GitHub webhook producers. Found `SET NULL` bypass; webhook now queues common resolver. |
| Resolution/hydration | `resolve-revision.ts`, hydrate enqueue/workflow, pure parser, phase helpers, native Git service. Found null-tip and temporality omissions; hydrate provider loop removed. |
| Indexing/codesearch | Workspace/repository index workflows, checkout keys, publication CAS, JWT/admission, Zoekt search/version filtering, SCIP/structural tools and routes. Found last-published-index loss; immutable claims/admission otherwise pass. |
| Files/read paths | Workspace Files HTTP route, `checkout-read.ts`, `clone-tree.ts`, explorer helpers, standard repo explorer tools. Found remote fetch per request and dead reconstruction. |
| Chat/graph/retrieval | Conversation HTTP/WebSocket runtime, TanStack tool construction, captured PostgreSQL snapshot, hybrid retrieval, graph route/tools, MCP compatibility. Snapshot fencing passes; Falkor derived-store replacement is undesigned. Desired sandbox identity is later Gate 4 work. |
| Generic ingestion/write jobs | `repository-ingestion.ts`, `workspace-write-commit.ts`, job enqueue/models/sandboxes, MCP/project commit helpers. Generic `lastIngestedHash` is not used as workspace truth; default-branch write convergence remains Gate 3. |
| UI | Workspace queries/types/projection, Settings, Linked Repositories, Workspace pane/conversation list, connector destination pickers, repository presentation. Transitional state remains owned by Gate 5/6; no additional Gate 2 blocker found. |
| Tests/evidence/deploy | 77-test mandatory inventory, 215 Linux codesearch inventory, seven-project types, migration proofs, CI status, Kubernetes memory logs/script, named hydration/index/chat/Files contracts. Identified stale-index, graph, temporality and connector mutation oracle gaps. |

## Commands and searches used

All searches were run from `/private/tmp/ctxpipe-recovery-01a07aba`; large logs/JSON were inspected through bounded status summaries rather than dumped.

```text
git diff --stat BASE...CANDIDATE
git diff --name-status BASE...CANDIDATE
git diff BASE...CANDIDATE -- <targeted source files>
git log --oneline --reverse BASE..CANDIDATE
git show CANDIDATE:<file> | nl -ba | sed -n <bounded ranges>
rg -n '(update|insert|delete)\(workspaces\)|desiredSha|activeProjection|hydratePhases|indexedSha' apps/backend/src --glob exclusions
rg -n 'lastIngestedHash|workspaceRepositoryUrl|activeProjectionSha|desiredSha|hydratePhases|indexedSha|repositorySha' apps packages
rg -n 'repos\.getContent|getContent\(|/contents/|contents\.get' apps/backend/src apps/codesearch/src --glob production exclusions
rg -n 'listMarkdownFilesAtGitSha|listPathsAtGitSha|readFileAtGitSha|git (fetch|clone|ls-remote)' apps/backend/src --glob production exclusions
rg -n 'workspaceHydrate\.spec|repositoryIndex\.spec|workspaceIndexInputSchema|linkedRevisionSchema|legacyWorkspace' apps/backend/src apps/codesearch/src
rg -n 'workspaceGitExplorerTarget|hydrateReadsStoredDesiredSha|hydrateIsNoop|shouldReplaceKnowledgeProjection|pendingHydratePhases|hydrateHasPendingWork' .
rg -n 'deleteGithubConnectionById|setRepositoryGithubConnectionId|ensureOrgRepository' apps/backend/src
rg -n 'graph_find_symbol|graph_get_callers|graph_get_callees|workspaceGraph|graphProjection|stores\.graph' apps/backend/src
rg -n 'skip|todo|fails|retry' required tests/workflows (targeted follow-up against inventories)
find docs/plans/workspace-recovery-gate-2 -maxdepth 2 -type f
git status --short; git rev-parse HEAD
```

## Owned later-gate follow-ups

- **Gate 3:** one typed transactional write command; native stage/validate/commit/CAS/push; retry/idempotency and deletion of parallel runner/write choreography.
- **Gate 4:** TanStack sandbox authority, restart/replica races, HTTP/WebSocket convergence, warm-turn GitHub removal, MCP compatibility, process/persistence cleanup.
- **Gate 5:** idempotent first-message UI command, canonical route identity, save/publish state, polling/invalidation removal, Storybook browser proofs.
- **Gate 6:** remove transitional columns/adapters/legacy fixtures after upgrade proof; decide generic ingestion compatibility; full golden journey, deployment/resource and deletion ledger.
- None of these later owners absorbs the Gate 2 revision, freshness, native-reader, graph, or required-proof blockers listed above.
