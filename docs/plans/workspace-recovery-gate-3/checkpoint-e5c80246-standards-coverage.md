# Standards coverage — `e5c80246f08b2d5c41d7cf5f8eb72543cd8b8768`

## Identity and method

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target: `e5c80246f08b2d5c41d7cf5f8eb72543cd8b8768`. The merge base equals the fixed base; all 21 commits were enumerated.
- New increment: `e5c80246 Gate 3: fence conversation publication and scope repository APIs`.
- Reviewed only pinned objects with `git diff BASE...TARGET`, `git log BASE..TARGET`, `git show TARGET:path`, `git grep TARGET`, and `git cat-file`; ignored moving checkout state. No tests or implementation changes.
- Standards: root and backend `AGENTS.md`; ADR-027/028/033; accepted Gate 3 status/audit; TDD and mocking proof rules; complete supplied Fowler baseline. Tool-enforced formatting was excluded.

## Incremental changed surface

The increment contains 77 paths: 18 TypeScript paths (including five test files and one shared fixture), deletion of the unused reindex implementation/test, backend guidance, and checkpoint evidence/status/audit. Production review covered:

- publication domain, sandbox capture, both HTTP publication routes, conversation projection, and native Git streaming;
- GitHub credential/token model, installation API client, MCP config PR writer, commit activity reader, and repository ref ingestion;
- all changed interfaces and their production callers, plus the retained and replacement proof seams.

## Interface and caller ledger

### Conversation publication

- `RegisteredSandbox.githubConnectionId` is populated by `checkoutPreparedConversationBranch`; `planCapturedConversationPublication` consumes the whole registered record.
- `pushConversationSessionBranch` production callers are exactly direct push (`conversation-files-routes.ts:553`) and PR publication (`conversations.ts:801`). Each route now gets the registered record once, resolves a revision, runs the shared plan, and passes the same revision to the broker.
- The broker validates the authenticated conversation/current workspace, commits locally without credentials, captures HEAD, creates a thin pack excluding the captured base, resolves actual default and session tips with a read token, obtains a repository-scoped write token, fetches the base into a fresh broker directory, streams the pack in 256 KiB chunks, validates decoded lengths and commit identity, rechecks default and DB binding, then pushes the exact session ref with `--force-with-lease`. Agent-pack cleanup and broker-directory cleanup are explicit.
- `persistConversationPublication` callers are the direct-push projection and the existing/new PR projections. It locks the exact workspace binding and updates the user/org/workspace-scoped conversation inside one `orgSql` transaction. No Git or HTTP I/O is inside that transaction.
- `createPullRequestFromBranch` is called only by the PR route and rechecks the same revision inside the retry closure immediately before GitHub PR creation. A final projection CAS rejects a relink during the response.

### Credential boundaries

- `getInstallationOctokitForOrg` requires `RepositoryInstallationScope`. Production callers: `fetchGithubWorkspaceCommits` requests contents-read/metadata-read; `installation-write-client` derives exact scopes for every operation.
- `getInstallationToken` requires the same scope. Its only production callers are MCP preview (contents read) and per-repository MCP config PR creation (contents write plus pull-requests write).
- `getRepositoryReadCloneToken` is used by code-ingestion ref resolution. It reads the repository row in one short org transaction, rejects a supplied changed connection, then mints outside SQL from the stored URL/connection.
- `getRepoReadCloneToken` callers remain revision acquisition, chat runtime, MCP repository exploration, read-Octokit construction, and stored-repository resolution. `getRepoWriteCloneToken` callers remain the native write broker and conversation publisher. All requests are repository-name scoped.
- GitHub API client callers were traced across connector routes/services/webhooks and conversations: file/tree/ref/commit reads receive read scope; config commits and PR setup receive only their needed write capabilities; close/read/create PR paths receive pull-request scope. Config writes check the actual default before object construction and again before updating a ref. MCP onboarding checks before each contents write.
- Legacy `graphs/codeIngestionGraph/nodes/reindex.ts` had no remaining production caller and is deleted with its owned-mock test.

## Proof and evidence disposition

- Domain native publication contract covers ordinary push, binding change during credential issue, default switch, concurrent session advance, a greater-than-8-MiB base with a tiny edit, exact write-token wire scope, unchanged default, and absence of agent-visible credentials.
- Native HTTP contract covers push, PR, missing sandbox, every captured identity mismatch, relink after push for both routes, relink before PR, and relink during PR response; state projection stays empty on stale binding.
- Repository API native contract covers raw byte reads, exact read scope, default-branch rejection before API object writes, empty-repository read behavior, MCP per-repository scope/default switch, review-branch/captured-parent behavior, and stored repository binding.
- Retained unit tests cover parser and value behavior; obsolete mocked config-writer/PR cases were removed in favor of native/MSW third-party boundary contracts.
- Inspected committed claims: 30 publication checks, 25 repository API/parser checks, backend types at 140 acknowledged diagnostics, scoped Biome, and proof policy. Per instruction, none were rerun.

## Fowler baseline disposition

- Reported: two new **Duplicated Code** sites, remaining typed-admission **Duplicated Code**, and remaining connector-finalization **Data Clumps**.
- Previous **Mysterious Name** is resolved.
- No additional actionable Mysterious Name, Feature Envy, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest was found.
- Declared remaining connector/planning/topology inventory was excluded from hard findings and gate acceptance.

## Counts

- Documented-standard violations: **0**
- Heuristic smells: **4**
- Implemented-scope blockers: **0**
