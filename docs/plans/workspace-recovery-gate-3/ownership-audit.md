# Gate 3 ownership and retirement audit

Candidate: the commit containing this file; cumulative review base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`. Gate closure still requires the pinned cumulative reviews and complete CI.

## Git writes and credentials

A repository-wide search covered native Git pushes, GitHub commit/ref/content APIs, and `contents: write` issuance across apps, packages and scripts, excluding tests, generated assets and documentation. Remaining product write sites:

| Site | Authority and scope | Evidence |
| --- | --- | --- |
| `domain/workspaces/write-broker.ts` (`pushWorkspaceCommit`, `pushUnbornWorkspaceCommit`) | Only default-branch push sites. Typed OpenWorkflow steps call them. Full org/workspace/generation/URL/connection/SHA binding, live write status and actual native default are checked, including after credential I/O. No force push. Lost acknowledgements inspect native ancestry. | Native write/pause, admission ACK, three worker Git/handoff/root crash cases, unborn seven-case suite, and two Docker/model crash cases. |
| `domain/workspaces/conversation-publish.ts` | Backend-owned Git directory imports the session delta; write token stays there. The destination is the explicit session branch, checked against actual default after credential I/O; force-with-lease is scoped to that branch. | Conversation publication and protected-conversation native contracts. |
| `services/github/installation-write-client.ts` | GitHub API commits remain solely for configuration PR feature branches. `assertConfigBranch` rejects the actual default before object creation and again before ref update. No connector mirror calls `commitFiles`. | Native repository-client default-branch rejection; existing config PR contracts. |
| `models/github-mcp-config-pr.ts` | MCP onboarding feature-branch PRs. Actual default exclusion is checked before each file-content write. | Native repository-client/onboarding branch checks. |
| `models/github-installation.ts` | `getRepoWriteCloneToken` has only broker and conversation-publication runtime callers. Read helpers request read permissions. API configuration callers request scoped feature-branch write/PR permissions. | Caller enumeration and native token-request assertions. |

No connector, extraction graph, migration export, webhook, hydration path, or agent sandbox has another default push. All twelve concern-specific write kinds use typed workflows; semantic conflict continuation retains the parent's durable job identity.

## Retired lifecycle

The generic write runner and extraction-to-serving-store writer were removed in prior milestones. This audit found and removed the remaining unused `ensureJobSandbox` / `createTanstackJobSandbox` allocation, cloning, claim and registration choreography (337 lines) and its 24 obsolete mocked tests (958 lines). `job-sandbox.ts` now contains only the handle type/adaptation still consumed by conversation code, whose replacement belongs to Gate 4.

Workspace Files status no longer looks at the retired shared job sandbox. It reports the immutable published revision as clean. The native route regression first reproduced leakage of unrelated dirty job files, then all 19 Files contracts passed. The existing registry retains conversation behavior and destruction of persisted pre-upgrade job resources; it has no production job-creation caller after this retirement. Those cleanup paths must remain until Gate 4's native sandbox migration retires them safely.

## Connector identity and event order

`readBinding` and its comparison parse both stored/native binding and current config through the provider schema. JSON property order does not define binding identity. Linear parsing sorts scope rows; proposal identity already uses canonical Linear selection, rendered Notion configuration, or canonical Confluence selection.

The audit reproduced a gap in content admission after config pushes: Notion and Confluence hashed list order. Both now hash their existing canonical provider representation. Two native admission cases show reordered resources/spaces/page IDs and equivalent empty/all-page selection reuse one owner, while A→B→A creates three distinct generations. All 45 native finalization/ordering cases pass. Changing Notion's key representation may admit one fresh generation on the first post-upgrade config event; subsequent equivalent events reuse it.

`contentSyncWorkflowRunId` is one current native activation pointer shared across proposal/content phases, paired with an increasing generation, not two execution owners. Admission/recovery queries validate provider, purpose, org, connection, default namespace and null workflow version. Delayed config completion may acknowledge an already accepted owner without rewinding its content child. Existing native identity, failure, cancellation, reactivation, provider replacement and completed-owner proofs are retained; no second lifecycle field was introduced.

## Linked repository claims and clone authority

Extraction resolved repository references to existing declarations but filtered outgoing declaration claims out of publication. The native linked-source regression reproduced a missing `HAS_SERVICE` claim. Claims now persist in the captured source declaration, as they already do for the implicit workspace repository's `AGENTS.md`.

The original path/blob must still match the exact parent revision. A candidate may change only `claims` in that declaration: clone URL, branch, other metadata, body, and first-path canonical selection remain fixed. An earlier duplicate declaration is rejected. The broker checks these invariants before write credentials and again after credential I/O; linked remotes remain untouched. Six captured-history/source-ownership cases pass, including source removal and branch changes, plus seven bounded-admission/authority cases cover URL, branch, metadata, body and canonical-path rejection. Claims-only YAML editing retains customer text; the source declaration's new blob is captured normally by a later ingestion.

The separate live producer and held older clone tests remain the extraction integration/source-index proof. Historical replay tests are not presented as live model-extractor proof.

## Cumulative closure corrections after d3ba7e59

The final Standards review identified that root `AGENTS.md` skipped the candidate source guard. Root and linked repository sources now share claims-only publication validation against the acquired parent revision: instruction body bytes and non-claims metadata cannot change, and an existing source cannot be removed. Validation runs before write credentials and again before push, including semantic reconciliation output. Three actual native Git pushes reproduced the root body, metadata, and deletion gap before the fix.

The final Spec review found unused generic-runner model exports. Removed `persistLastJobAt`, `persistWriteJobIntent`, `persistWriteJobStart`, and `countWriteJobAttempts`; native typed command persistence remains the sole admission path. Repository-wide caller search found only the removed definitions.
