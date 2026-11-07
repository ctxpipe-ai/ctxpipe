# ADR-051: MCP read surface: small read tools, slugs, scopes, and an org set per grant

**Status:** Accepted | **Date:** 2026-10-13 | **Tags:** mcp, oauth, multi-tenant, graph, search, observability

## Context

The public MCP server has one tool, `ctx_advisor`. It runs Workspace chat for each call and returns an answer. This tool comes from the older design, where ctxpipe was an advisor. Now ctxpipe is a context management system. The client agent (Claude Code, Codex, Cursor) is a strong reasoner, and it must drive the search loop itself.

The CTO requirements (CTX-586) are: read and write scopes; a read slice first; several orgs and Workspaces in one session; eager discovery of orgs and Workspaces; search over the context and the linked repositories; no search of the repository that the agent works in; tests and evals for each tool; and correlation ids for each call.

Facts that the design uses:

- The OAuth grant stores one org in `referenceId` (`auth/config.ts`, `auth/oauth-organization.ts`). The JWT carries `https://ctxpipe.ai/organization_id`. Better Auth stores only one `referenceId` for each consent and token ([ADR-026](ADR-026-claude-plugin-mcp-distribution.md) Decision item 3).
- A Workspace graph is immutable for each revision ([ADR-046](ADR-046-workspace-revision-projection-identity.md)). FalkorDB has an index on `(projectionKey, id)`. Today the chat graph tools read all nodes and all edges of the revision for each call.
- `claim-confidence.ts` decays a signal at read time (validity window and a half-life for each source).
- Knowledge search runs in memory over all units, with `jsonb` embeddings.

The design is the Linear document [CTX-586 design v2](https://linear.app/ctxpipe/document/ctx-586-design-v2-public-mcp-tools-for-context-management-read-slice-7ea6fd362674). The plan is the Linear document [CTX-586 plan](https://linear.app/ctxpipe/document/ctx-586-plan-public-mcp-read-tools-58654c0846e9).

## Decision

### 1. Seven small read-only tools; `ctx_advisor` goes at once

The client agent is the reasoner. ctxpipe returns facts with stable refs. It runs no LLM for each call.

| Tool | Job |
| -- | -- |
| `list_workspaces` | Compact list of the orgs and Workspaces that the connection can read. Detail (repositories, sources, readiness) for one named Workspace. |
| `search_knowledge` | Hybrid search (natural language and keyword) over the knowledge units of one org, in one or more Workspaces, with filters (`kinds`, `pathPrefix`, `sources`, `updatedAfter`, `validAt`). |
| `search_code` | One search across the linked repositories: `literal`, `regex` (RE2, Zoekt), or `structural` (ast-grep). |
| `find_symbol` | SCIP lookup: definition, references, callers, callees. |
| `read_file` | Read a knowledge unit or a repository file by ref, with line ranges. |
| `list_files` | Folder tree of a Workspace repository or a linked repository. |
| `get_related` | Units near one or more seeds in the graph **and** relevant to a query: ranked, explained, bounded (section 6). |

- The release that adds these tools removes `ctx_advisor`: its tool code, `mcp/advisorThread.ts`, its tests, its Langfuse session, its progress notifications, and the plugin skill `ctx-advisor`. No release has both, and no release has neither. Workspace chat in the product stays.
- The plugin goes to 0.2.0. A `ctxpipe-context` skill replaces the `ctx-advisor` skill. The plugin URL stays `https://app.ctxpipe.ai/mcp`, with no `?orgSlug=` ([ADR-026](ADR-026-claude-plugin-mcp-distribution.md) Decision item 2).
- MCP tools and Workspace chat tools call the same domain functions.
- A later slice adds write tools (`propose_knowledge_change`, `record_learning`, `flag_knowledge`, `get_job`) under `ctxpipe:write`.
- The removal of `ctx_advisor` deletes no LangChain code. A separate cleanup has four steps, in this order:
  - L1 removes LangGraph.
  - L2 moves the host model calls to the TanStack AI setup of chat.
  - L3 deletes the ingestion agents ([ADR-052](ADR-052-ingestion-sandbox-skills-patches.md) phase 5).
  - L4 removes the LangChain packages and bans their imports.

### 2. Scopes: one endpoint, `ctxpipe:read` and `ctxpipe:write`

- One `/mcp` endpoint. The OAuth scopes are `ctxpipe:read` and `ctxpipe:write`. `tools/list` shows only the tools that the token's scopes allow. Each call checks the scope again.
- A request with no credential gets 401 with `scope="ctxpipe:read"`. A call without the necessary scope gets 403 `insufficient_scope`, which names the full scope set.
- Legacy grants and API keys count as read. API keys get `permissions`.
- Until the write tools ship, ctxpipe offers only `ctxpipe:read`. An authorization that asks for `ctxpipe:write` gets `ctxpipe:read`, and no OAuth token passes the REST write gate. Stored grants from before can still list `ctxpipe:write`. Thus the write slice must not trust a stored grant, and must ask for new consent.
- Each tool has a `title` and the annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- Rejected: a second endpoint for write. It needs two connections and duplicate tools.

### 3. Several orgs: an org set per grant, one org per call

- **One tool call = one org.** The `org` slug argument names it. `org` is necessary on every tool except `list_workspaces`. On `list_workspaces` it is optional; without it, the tool lists each org of the grant set. A session can call several orgs, but no call mixes orgs. So RLS ([ADR-042](ADR-042-postgres-rls-app-role.md)) stays one org per request.
- **Consent** lists the orgs of the user with check boxes. The org of the current session is ticked. At least one org is necessary.
- **Storage:** the table `oauth_grant_organizations (grant_id, api_key_id, organization_id, created_at)`. A grant row sets `grant_id`; a personal API key row sets `api_key_id` (see API keys below). The grant `referenceId` becomes a grant id that points to the set. The JWT carries `https://ctxpipe.ai/grant_id`. The set is not in the JWT, so a change applies on the next call.
- **Each call:** resolve the `org` slug to an org id. Allow the call only when the org is in the grant set **and** the membership of the user is active (one indexed query). Then set the RLS org context for that request.
- **Change without a reconnect:** the "Connected apps" page in settings lists each grant (client name, scopes, orgs) with check boxes and "Revoke". A new membership never joins a grant until the user ticks it.
- **Errors:** an org outside the set, an org without membership, and an unknown org give the same `org_not_found` text. For each OAuth connection, that text also points the user to Connected apps (`/.auth/account/connected-apps`), where the user can add an org to the connection. The hint depends only on the kind of connection, not on the org, so it does not tell whether the org exists. An API key gets no hint. Connected apps lists each OAuth consent, also a legacy one-org consent (revoke only).
- **Legacy grants** (`referenceId` = an org id) read as a one-org set. They need no data migration.
- **API keys:** an org key stays one org, and the `org` argument must match it. A personal key gets an org set when it is made. The set is in the same table, in a nullable `api_key_id` column beside a nullable `grant_id` column. In each row, exactly one of `grant_id` and `api_key_id` is set (a check constraint). An existing personal key with no rows acts as the set of all current memberships of its user. This is the same power that it has today. The live membership check still applies on each call.
- **`?orgSlug=`:** the `/mcp` URL parameter no longer selects the org. The server accepts it and ignores it, so old client configurations do not fail. A later release removes it.
- Rejected: a grant without orgs that uses only live membership (a new membership joins old tokens with no consent; [ADR-026](ADR-026-claude-plugin-mcp-distribution.md) rejects this); one grant for each org (duplicate tools and a reconnect for each org); the org set in the JWT (a removal stays valid until the token expires).

This section amends [ADR-026](ADR-026-claude-plugin-mcp-distribution.md) Decision items 3 and 4, and [ADR-030](ADR-030-organization-owned-mcp-api-keys.md) for personal keys.

### 4. Identifiers and refs

- **No internal ids** in arguments or results.
- **Org and Workspace:** two slug arguments, `org` and `workspace` (or `workspaces`). Not one `org/workspace` handle, because a list of handles can mix orgs. `org` is necessary on every tool except `list_workspaces` (section 3). `search_knowledge` takes `workspaces` (default: all Workspaces of the org, at most 8). The other tools take one `workspace`; for `read_file` it is optional with a `<handle>:<path>` ref (the handle resolves at org level and the read uses the published checkout of the repository).
- **Repository handle:** the path of the normalized git URL, `owner/name` (for example `example/payments-api`). When two repositories of one org have the same `owner/name` on different hosts, both handles become `host/owner/name`. Each argument that names a repository also accepts a git URL (SSH or HTTPS, with or without `.git`). The server normalizes both forms with `normalizeWorkspaceRepositoryUrl`. Results show only the handle.
- **Ref:** short and relative to the `org` and `workspace` of the call. A knowledge unit ref is its path in the Workspace repository (`knowledge/services/payments-api.md`). A repository file ref is `<handle>:<path>` (`example/payments-api:src/limits.ts`). The server reads a ref as a repository file only when the part before the first `:` is a linked repository handle of the Workspace. A later resource template maps refs to `ctxpipe://{org}/{workspace}/{+ref}`.
- `search_code` and `find_symbol` resolve repositories at org level. They search a repository that several Workspaces link only once. A file ref from them is valid in `read_file` with each Workspace of the org that links that repository.

### 5. Discovery, responses, and the current repository

- **Server instructions** are dynamic for each principal: the rules first (the first 512 characters stand alone), then each org of the set with its Workspace slugs, under 2,048 characters in total. The rules say: ctxpipe serves the default branch; do not use it for the working repository; send independent calls in parallel; search knowledge before a design choice; name one org for each call; cite refs. The last rule gives the docs index for agents (`https://docs.ctxpipe.ai/llms.txt`), so that a client can answer a question about ctxpipe itself.
- `list_workspaces` has `_meta["anthropic/alwaysLoad"]: true`. List mode is about 20 tokens for each Workspace (slug, title, repository count, readiness), with 100 Workspaces per page. Detail mode is for one named Workspace (at most about 600 tokens).
- Resources come later, only for `@`-mention. They do not reach the model on their own.
- **Parallel calls:** the instructions and the tool descriptions tell the client to send independent calls in parallel.
- **Responses:** `structuredContent` and compact TOON text. Each response states the served branch and SHA (`served { branch, sha }`). Each tool has a token budget, in TOON tokens of the whole result, inside the 24,000-character cap: `read_file` 6,000; `get_related` 3,000 by default and 8,000 at most (`maxTokens`); `list_files` 3,000; `list_workspaces` detail 600; each other tool 4,000. The hard cap for each response is 24,000 characters, counted as the TOON text and `structuredContent` together. One helper (`fitPage`) measures that real size and shrinks a page until it fits both limits, so a tool that can page never returns `response_too_large`. An item that does not fit alone is cut and the result says `truncated: true`. Cursors are opaque and bound to the projection SHA (`stale_cursor` after a change). Errors have `isError: true` and `{ code, message, retryable }`. An unknown Workspace and a Workspace outside the grant give the same error.
- **Not the current repository:** `excludeRepositories` (handles or git URLs) is necessary on `search_code` and `find_symbol` (`[]` is allowed) and optional on the other tools. `read_file` refuses an excluded repository with `excluded_repository`. Results list what the call excluded.
- **Stateless:** one `McpServer` for each request. The design fits spec 2025-11-25 and the stateless 2026-07-28 revision.

### 6. `get_related`: graph relevance, bounded

`get_related` finds units that are near the seeds **and** relevant to a query. Plain neighbors are one setting of the same tool (`maxDepth: 1`, no `query`).

- **Parameters:** `seeds` (1 to 10 refs), `query`, `intent` (`general`, `why`, `ownership`, `change`, `dependencies`, `structure`, `provenance`), predicate filters and weights, result kind filters, `direction`, `maxDepth` (1 to 4), `maxFanOut`, `minConfidence`, `validAt` or `validBetween`, `recencyHalfLifeDays`, `restart`, `queryWeight`, `hubPenalty`, `diversity`, `maxPerKind`, `explain`, `includeSeeds`, `limit`, `cursor`, `maxTokens`. The agent sets `intent`, or gives the question as `query`. A call with no `intent` is `general`. The tool does not guess the intent from the words of `query`: a word list was tried and removed, because the agent knows its question and a guess adds a second rule to the ranking.
- **Algorithm:**
  1. Postgres resolves the seed refs to the ids of the published projection. Unknown refs give `unknown_ref`.
  2. FalkorDB expands the graph with one bounded Cypher query for each hop: predicate, direction, validity, and minimum confidence filters, and at most `maxFanOut` edges for each node. The caps are 5,000 nodes, 25,000 edges, 1 s for each hop, and 3 s in total. At a cap, the tool stops and marks `partial: true` with the reason. `cappedHubs` lists every node with more than `maxFanOut` matching edges in the explored frontier. Such a node takes its edges in turns by predicate: the strongest edge of each predicate, then the second strongest, and so on. Of two equal edges, the newer (`validFrom`) comes first. Thus one predicate with many edges (pull requests, notes) cannot fill the fan-out and hide the owner or the decisions of the node. This order applies to every walk: the default walk of an intent, a walk of all edges, and a call with explicit `predicates` that names more than one predicate. The Cypher query reads at most `maxFanOut + 1` predicates of a node (those with the strongest edges) and at most `maxFanOut + 1` edges of each predicate, so the memory of one node does not grow with the edges of a hub.
  - **Default walk for each intent.** When the call gives no `predicates`, the walk follows the edges of the intent (`INTENT_PRESETS[intent].walk`) and the link edges `LINKS_TO`, `REFERENCES`, and `MENTIONS`. Workspace claims have free-form predicates (for example `GOVERNS`), and hydrate turns each body link into `LINKS_TO`, so the named edges of an intent can miss the answer. When this walk gives fewer than `limit` results or no unit of an answer kind, the tool also walks all edges. It keeps intent-walk answers first, then all-edges answers, then other results. A duplicate keeps its first rank. Explicit `predicates` replace the default walk and never add the walk of all edges.

    | Intent | Default walk (each with the link edges) |
    | --- | --- |
    | `general` | All edges |
    | `ownership` | `OWNS` |
    | `why` | `INFLUENCES`, `SUPERSEDES`, `DEPENDS_ON`, `AFFECTS`, `APPLIES_TO`, `TRACKED_BY` |
    | `change` | `CHANGED`, `ADDED`, `MODIFIED`, `REMOVED`, `RENAMED`, `TARGETS` |
    | `dependencies` | `DEPENDS_ON`, `CONSUMES_API`, `CONSUMES_FROM`, `READS_FROM`, `WRITES_TO`, `USES_LIBRARY` |
    | `structure` | The dependency edges, `EXPOSES_API`, `HAS_OPERATION`, `PRODUCES_TO`, `RUNS_ON` |
    | `provenance` | `FROM_SOURCE` (unit to its `Source` file, [ADR-050](ADR-050-workspace-sources-config-file.md) revision 2026-10-16) |

    No default walk follows `FROM_SOURCE`, also not the walk of all edges and not the fallback walk. Only `provenance`, or explicit `predicates` that name `FROM_SOURCE`, walk it.

    The graph relevance eval measured the reason: on a walk of all edges with fan-out 50, a service with many pull-request edges hid its owner, its decisions, and its dependencies (recall@5 of 0 for `ownership`, `why`, and `dependencies`). The eval asserts its floors on the defaults of the tool: the call with only `intent`, and the call with no `intent`. It runs on two vocabularies: the predicates of the presets, and free-form predicates with plain body links. Each walk of the eval gets 30 s, so the load of the machine does not change a result; the cost check is the size of the explored graph. The 24 tool calls of the eval take less than 1 s together, so the eval tests keep the default test timeout of 5 s.
  - **Answer kinds.** `ownership`: team, person, group; `why`: decision, incident; `change`: pull request, commit, change; `dependencies`: library, database, service, API, package, queue, stream. Kind names ignore case and separators. `structure` has no kind preference.
  - **Answer group.** The units of the answer kinds of the intent come first, with their own MMR selection; the other units follow with a second MMR selection. A strong query hit (a query match of at least 0.5 of the top query score) also joins the answer group, for every intent. In that group, the query factor of the score puts a strong hit before an answer kind that the query missed. Thus a query that names a runbook still finds it first, also with `intent` `why`. A weaker hit can be a loose semantic match, so it stays in the second group. `rankRelated` marks each result that is in the answer group, and `get_related` uses only that mark to merge its walks: the answers of all walks, then the other results. There is no second sort by kind.
  - **`general`.** For `general`, the answer kinds are the union of the named answer kinds, and MMR diversity is 0.5 (0.3 for the other intents). With no `query`, one page of five must serve four kinds of question. On the eval, the gold of one service is 1 owner, 2 decisions, 5 changes, and up to 5 dependencies, so no order of five results can give recall@5 near 0.6 for both changes and dependencies without a loss for owners or decisions. The eval measured 0.83 (owners), 0.67 (decisions), 0.27 (changes), and 0.24 (dependencies) there. This is the bound of a call with only seeds, and we accept it. The tool text tells the agent to set `intent` or give the question as `query`.
  3. The backend weights each edge: predicate weight for the intent × decay (`decayWorkspaceSignal`) × recency × `degree^-β` (hub penalty). Seeds and query hits get no hub penalty. Recency applies to change edges only. Node authority (ADR status, review decision) waits until the projection stores those fields.
  4. With a `query`, Postgres runs one hybrid search per walk over the chunks of the explored units only. Both walks and both searches share the total time budget. Each operation gets the time left. At the deadline, the search aborts its embedding request and returns graph-only ranks with `partial: true` and `total_timeout`. SQL statements get the remaining time as their timeout. The fallback also shares the node and edge caps.
  5. The backend runs personalized PageRank (power iteration) on the explored subgraph. The seeds and the query hits make the restart vector.
  6. Score: `ppr^(1 − queryWeight) × (0.1 + queryMatch)^queryWeight`. Then MMR diversity, and a path explanation for each result (the path with the highest weight product).
  7. The ranking is cached in process for 10 minutes by revision, parameter hash, and ranking time. A cursor holds the offset and the ranking time. A page after the entry ended, or on another replica, ranks again as of that time and gives the same order. One call loads the projection once and refuses to run when it does not hold the served revision. `excludePredicates` removes predicates from every walk, in the Cypher query. A weight of 0 in `predicateWeights` removes a predicate from the ranking only. `excludeKinds` removes kinds from the results; the walk still passes through them. `predicates` and `excludePredicates` are not case-sensitive. `maxFanOut` is 5 to 200 and `hubPenalty` is 0 to 1.
- **Where the work runs:** FalkorDB does the seed lookup and the filtered expansion. The backend does the scoring, so it works the same on each graph engine and an eval can turn off each signal. FalkorDB's built-in PageRank is global, not personalized, so it is not used.
- **Never load the whole graph.** The chat graph tools use the same bounded expansion. Chat `graph_neighbors` preserves parallel claims as separate edges. The Graph pane still merges parallel claims. The projection stores `path`, `degree`, `inDegree`, and `outDegree` on each node. A revision graph is immutable, so the stored degree is always correct. A projection version enters the projection key, so each Workspace graph projects again one time on the next hydrate.
- **Target:** p95 under 300 ms for depth 2 on a 50,000-edge graph. The check is `pnpm --filter @ctxpipe/backend test:latency` (needs Postgres and FalkorDB). It checks `general`, `ownership`, and `dependencies` calls, and a `dependencies` call with a `query`. A call embeds its `query` once, and each walk searches with that embedding. It is outside the PR suite, because a wall-clock bound is flaky on shared runners.

### 7. Reuse from PR #350

PR #350 ("Weight graph traversal, link decisions to services, and index graph writes") targets the older objects graph. We do not merge or cherry-pick it. We port these parts into new files (CTO approval of candidates 1 to 7):

1. The signal model of `retrievalScore.ts` (weighted product with a floor, recency for events, specificity `degree^-0.5`, authority by ADR status, which waits as section 6 says), with `decayWorkspaceSignal` in place of the old "truth" signal.
2. The intent presets (`why`, `ownership`, `change`, `structure`, `general`). The regex classifier is not ported: the agent sets `intent` (section 6).
3. The node index DDL for each graph engine (`platform/graph/indexes.ts`), applied to `(projectionKey, id)`.
4. The Cypher rules: no `datetime()` in FalkorDB (compare ISO strings), degree scoped by label, batched `IN $ids`.
5. The graph eval harness: a synthetic engineering org with real hub shapes, and recall@5 floors for each intent, adapted to `WorkspaceKnowledgeUnit` nodes.
6. The decision-to-service scoping and the supersession parsing, as a specification for the `decisions` skill of [ADR-052](ADR-052-ingestion-sandbox-skills-patches.md) (not as code).
7. The `PullRequest CHANGED package` claim, as an idea for the GitHub pull-request mirror.

We do not port the weighted walk, the advisor planner, its eval, or the old retraction code. PR #350 has its own ADR-035, ADR-036, and ADR-040 files. They are not merged; this ADR takes the parts above from them. (Numbers 035 and 036 are unused in this repository, and this repository's ADR-040 is a different decision.)

### 8. Data layer

- **Knowledge search:** a table `workspace_knowledge_chunks` (unit, Workspace, org, projection SHA, ordinal, text, generated `tsvector`, `vector` with an HNSW index). Hybrid search uses reciprocal rank fusion in SQL, with filters, and returns the best chunk of each unit with its line range. Chat uses the same function. The vector ranking is exact (a distance scan over the scoped chunks) when the filters leave at most 10,000 chunks, because all orgs share one HNSW index and a filtered scan stops after `hnsw.max_scan_tuples` tuples. Larger scopes use HNSW with `hnsw.iterative_scan = relaxed_order` on pgvector 0.8.0 or later, and a raised `hnsw.ef_search` before that. On pgvector below 0.8, a scope over 10,000 chunks can still lose vector hits to the scan cap. Every ordering ends with the chunk key, so ties are stable. `validAt` T matches a unit that has no claim with a validity window, or that has one such claim with `validFrom` at or before T and `validTo` null or after T. A bound is a time only when it starts with `YYYY-MM-DD` and Postgres accepts it as a `timestamptz` (compared as `timestamptz`, UTC when it has no offset); any other value, such as a Git SHA that hydrate has not rewritten, is no bound. Embeddings are reused by chunk hash.
  - **Chunk rule:** one chunk for each Markdown heading section. A section longer than 512 tokens (about 2,048 characters) packs its paragraphs (blank-line runs) into chunks up to that length; a longer paragraph splits on length, at code points. Sections do not merge, so an edit changes only the chunks of its own section. In a section over the limit, an edit can move the later chunk boundaries of that section. The indexed and embedded text of a chunk starts with the unit title and the heading path. Each chunk records its first and last file line. The chunk hash covers the embedding model id and the text, so a model change embeds again.
  - **Lifecycle:** chunk rows belong to the active projection and stay across SHAs. The key is `(workspace_id, unit_id, chunk_hash, occurrence)`. The transaction that activates a SHA inserts the new chunks, updates only the line columns of moved chunks, and deletes the gone chunks. An unchanged chunk gets no write. A new chunk copies the embedding of a chunk with the same hash before the gone chunks are deleted. Hydrate then embeds only the hashes that have no embedding. Units have no embedding of their own; search ranks chunks. Embeddings are not marked ready while a chunk or a unit with text has no chunk.
- **Unit columns** `title`, `source`, and `updated_at`, for the filters. `title` is the front-matter `title`, else the first heading. `source` is the connector mirror root (`connectorMirrorRoot`), else `authored`. `updated_at` is the time of the last commit that changed the path. An active projection with a unit that has text but no chunk rows (a projection from before this change) is published again on the next hydrate run of that revision, with no new commit. That run fills the chunks, `title`, and `source`, and runs the graph and index phases again.
- **Grant org set:** `oauth_grant_organizations` (section 3).
- **Code search:** a wrapper maps org and handles to checkout keys and drops excluded repositories first. SCIP fans out in parallel over at most 10 repositories, the first 10 in handle order; each other repository is `skipped` as `over_limit`, with a hint to narrow the call with `repositories` or `workspace`. Text search is one Zoekt request over the full scope. Code search reads the published checkout of each repository, not the Workspace revision. Codesearch has no admission limit for SCIP loads (only an index cache of 8 indexes and 256 MiB), so each backend process sends at most 20 SCIP and structural requests at once, and all codesearch requests of one call stop after 20 s, retries included. [ADR-027](ADR-027-codesearch-openworkflow-concurrency.md) budgets apply.

### 9. Correlation

- No tool arguments for correlation, because models invent ids.
- The server reads `_meta` (`traceparent`, `baggage`, `ai.ctxpipe/conversationId`, `ai.ctxpipe/turnId`, `openai/session`) and `x-ctxpipe-*` headers when they are present.
- ClickHouse always derives a session (30-minute gap) and a turn (60-second gap) for each connection key. Parallel calls of one turn arrive within milliseconds, so the derived turn groups them.
- Spans get `ctxpipe.mcp.org.slug_hash` for each call. No query text, paths, or handles go on spans.

### 10. Tests and evals

- Contract tests on each PR: the MCP SDK `Client`, real Postgres, msw for codesearch and embedding providers. They cover schemas, scopes, the same error for a foreign and an unknown org, an untick that denies the next call with no reconnect, a removed membership, exclusion by handle and by URL, paging, budgets, the `get_related` caps, and no `ctx_advisor` in `tools/list`.
- A graph relevance eval with no LLM, on live FalkorDB in CI: recall@5 floors for each intent and a p95 latency budget.
- MCPJam evals nightly and on a label, against a preview environment with a seeded fixture org. They include parallel calls in one turn and sessions with two orgs.

### 11. Accepted deviations from the design

The CTX-586 design v2 sets the limits below. The code is different, and we accept each difference for the reason in the table.

| Tool | Design | Code | Reason |
| --- | --- | --- | --- |
| `search_code` | Budget 5,000 tokens | 4,000 tokens | A smaller page keeps the agent context smaller. |
| `search_code` | Each match has 3 lines of context | The matching line only, and at most 3 matches for each file (`matchCount` counts all) | Less context for each file. `read_file` gives the lines around a match. |
| `search_code` | `limit` counts files | Structural search: `limit` counts matches, and consecutive matches of one file share one entry | The ast-grep fan-out pages by match. A page by file needs all matches of each repository. |
| `get_related` | `restart` default 0.25 | 0.15 | With 0.25 the graph relevance eval loses recall for change questions with no intent (0.27 to 0.23 in both vocabularies), under the floor of 0.25. Questions with an intent gain a little (change 0.93 to 0.97). |
| `read_file` | Front matter of a unit | `frontMatter` holds the fields that ctxpipe parsed (kind, title, source, last update, at most 20 claims), only on the page that starts at the body | The projection does not keep the raw front matter. The parsed fields need no repository read. |
| `list_files` | A size for each entry | A size for knowledge unit files only | The codesearch glob gives no file size. |
| `list_files` | `glob` filter | With `glob`, only matching files are listed, not folders | A folder list does not help to find files by pattern, and it costs context. |
| `list_workspaces` | Description from the Workspace `AGENTS.md` | Read from the published index checkout through codesearch; omitted when the checkout is not indexed or codesearch fails | The projection does not keep `AGENTS.md`. The description is optional, so the call does not fail. |
| `search_code` | `pathGlob` for text and structural modes | One meaning in every mode: a gitignore-style glob. A glob with no `/` matches at any depth; a glob with a `/` starts at the repository root. A `!` negation gives `invalid_argument`. | Zoekt and ast-grep must give the same files for one glob. |
| `list_workspaces` | Detail mode lists all repositories | Detail mode lists 50 repositories for each page and gives a `cursor` for the next page. The header holds at most 10 sources and 10 unit kinds; the rest is a count (`sourcesNotShown`, `unitKindsNotShown`). A title is cut at 60 characters. A repository handle is never cut. | The detail page must stay inside 600 tokens. |
| `find_symbol` | `language` input | The file extension decides, else the SCIP indexer scheme. With `language`, each repository gives its full 200 rows before the filter | Codesearch has no language filter for SCIP. |

## Consequences

- The client agent does the reasoning, so a call costs no model tokens on our side, and responses are facts with refs that the agent can cite.
- One connection reaches all ticked orgs. A removal from an org or an untick cuts access on the next call.
- Clients that call `ctx_advisor` break at the cutover. Plugin 0.2.0, the server instructions, and the rewritten docs teach the new tools.
- The new tables and the unit columns need migrations (approved). Each Workspace graph projects again one time.
- Parallel calls can burst the rate limit and codesearch. A per-principal limit allows bursts (8 in flight), and ADR-027 budgets protect codesearch.
- The PageRank weights start from the PR #350 values. The graph eval tunes them later.

## Alternatives considered

- **Keep `ctx_advisor` beside the new tools for 60 days:** rejected by the CTO. It goes in the same release.
- **GraphQL with filters:** rejected. The schema costs many tokens, models need validation loops, the response has no bound, and code search does not fit.
- **One `org/workspace` handle argument:** rejected, because a list can mix orgs.
- **Multi-org options B, C, and D:** see section 3.
