# Coverage ledger — Spec — `bb24210c...e5c80246`

## Boundary

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `e5c80246f08b2d5c41d7cf5f8eb72543cd8b8768`.
- Inspected the three-dot diff and complete commit log. All repository reads used `git show e5c80246:<path>` or pinned `git grep`; the moving worktree was excluded.
- Read-only review; no repository edits or test processes.

## Specifications

- `docs/plans/workspace-chat-recovery.md:642-659`: Gate 3 native broker, credential ownership, default safety, and explicit conversation-publisher audit.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:7,11-25`: durable identity, transient/scoped credentials, binding checks and session branches.
- Locked ticket 10, `issues/10-ingest-to-git-write-protocol.md:39,43-48,64,68-82,119-132`: binding, broker, no-op, default and credential rules.
- Locked ticket 14, `issues/14-worktree-and-agent-change-lifecycle.md:68-104,112-147`: explicit session publish, relink, restored branch, PR-generation binding and sandbox lifetime.
- Supporting ticket 17, `issues/17-tanstack-sandbox-not-diy-opencode.md:14-38`: TanStack workspace clones are shallow by default.
- Target `status.md:392-402` and `write-path-audit.md:1-30`: checkpoint claims and explicitly open inventory.

## Previous findings replayed

- **Stale sandbox:** both HTTP routes now obtain the `RegisteredSandbox` and handle together, and `planCapturedConversationPublication` checks connection, URL, generation, SHA and default (`conversation-publish.ts:37-61`; routes `conversation-files-routes.ts:535-552`, `conversations.ts:777-799`). Native HTTP matrix includes stale push and each identity field.
- **Post-push relink:** PR route rechecks exact revision after push and before PR lookup/create (`conversations.ts:811-860`); PR credential helper repeats the full check immediately before every create attempt (`installation-write-client.ts:579-617`); conversation persistence locks the exact workspace row and updates conversation in one short transaction (`models/conversations.ts:124-163`). Original barrier trigger is fixed. A relink after the external PR request begins may leave the new PR but cannot project stale state; this unavoidable external-I/O edge was not raised.
- **Large base:** agent produces a thin pack excluding the captured default, measures it on disk, and transfers 256 KiB chunks (`conversation-publish.ts:155-240`); broker fetches the excluded base and `index-pack --fix-thin` validates it. The >8 MiB-base test proves the original full-tree/stdout issue. Finding 1 covers the untested restored-session topology.

## Conversation paths and callers

- Exhaustively traced `pushConversationSessionBranch` callers: standalone Push, Create PR, native domain tests and native HTTP tests.
- Broker checks authenticated conversation/current URL-generation-connection-default binding before and after token issue, current session lease, actual default, explicit destination ref, token sanitization, and post-push local ref update (`conversation-publish.ts:92-283`). Desired-SHA advancement remains intentionally tolerated inside the broker after route capture.
- Sandbox metadata flow traced through prepare (`conversations.ts:675-716`), `checkoutPreparedConversationBranch` registration (`conversation-files-routes.ts:583-617`), registry shape/merge/lookups, memo fallback, Files warm/read/write and both publication routes. Finding 2 is the only path where handle creation omits registration.
- Native HTTP matrix covers missing/stale capture, relink after push on both routes, relink during PR credential issuance and stale projection. It does not cover Files-only warm or cross-repository PR-number collision.
- Runtime restore selects the persisted session ref when it exists (`workspace-chat-turn-runtime.ts:86-125`); current native publisher tests always initialize/fetch main, explaining finding 1’s gap.

## Scoped GitHub APIs

- `getInstallationOctokitForOrg` and `getInstallationToken` now require repository plus permissions and mint a narrowed token (`models/github-installation.ts:712-819`). Read/write clone helpers remain repository-scoped; legacy ingestion derives URL/connection from the stored repository and rejects an explicit changed connection (`:853-923`).
- Production callers traced: repository ref resolution, workspace commit activity, write probe, installation write client and MCP config preview/create. Installation-level repository discovery/account metadata calls necessarily remain installation-wide and perform no repository content mutation.
- `installation-write-client.ts` maps tree/blob/ref/commit/compare reads to contents-read, PR reads to pull-requests-read, branch/object writes to contents-write, and PR/close mutations to pull-requests-write. `getGithubRepoWriteView` uses scoped read plus app-authenticated installation permission fallback.
- Config writers: `commitFiles` checks the actual default before object creation and again before ref update (`:295-385`); `createPullRequestWithFiles` checks the feature ref and delegates the checked commit (`:387-462`); MCP setup re-resolves the actual default before every Contents write (`github-mcp-config-pr.ts:545-580`). Unborn-repository initialization is removed and declared for typed bootstrap.
- Native repository client suite covers scoped read tokens, config default switch, empty repositories, MCP per-repo scope, review branches, non-fast-forward/captured parent, binary/omitted content, compare/rename, timestamps and stored ingestion binding.

## Other changed surface

- Verified deletion of the obsolete `codeIngestionGraph/nodes/reindex` implementation has no remaining imports; active repository ingestion uses the registered workflow child.
- Reviewed target status/evidence names and unchanged prior pause/hydrate corrections. No unlisted default writer or unrestricted repository-data token consumer was found in the pinned source search.
- Connector setup/finalization identity, canonical extraction, typed empty-repository bootstrap, remaining provider/legacy cleanup, persisted Gate 4 sandbox authority and Gates 4–6 remain declared open and were not counted as findings.
