# CTX-586 implementation plan: public MCP read tools

Design: the Linear document "CTX-586 design v2" (attached to CTX-586). Base: PR 280 head (`2ad28beb`). Paths are under `apps/backend/src/` unless noted. Names in examples are made up.

Status of approvals:

- Approved: scopes option A (req 1), tests and evals (req 7), migration with `ctx_advisor` removed at once.
- **Needs CTO approval before work starts:** the tickets marked **[migration]** (new tables and columns), the multi-org option A and the ADR-026 amendment, and the PR #350 reuse candidates marked **[PR350 #n]**.

Sizes: S = up to 1 day, M = 2 to 4 days, L = 5 days or more. Each ticket proves its change with tests through the public interface (real Postgres, real FalkorDB in CI, msw for codesearch and the embedding provider), as the repo testing rules say.

## Release rule

Phase 3 ships as **one release**: the seven tools, the `ctx_advisor` removal, plugin 0.2.0 and the docs. No release has both `ctx_advisor` and the new tools, and no release has neither. Phases 1 and 2 can merge earlier, because they change no visible behavior.

## Phase 0: decisions

### P0-1 ADR-051 and the ADR-026 amendment (S)

- Goal: record the MCP read surface (tools, identifiers, refs, scopes, multi-org rule, correlation, budgets) and amend ADR-026 §3 to an org set per grant.
- Scope: `.ai/memory/decisions/ADR-051-mcp-read-surface.md`, ADR-026 amendment note, `decisions/index.md`. Cite PR #350 ADR-035/036/040 for the parts we reuse.
- Tests: none (docs).
- Depends on: CTO approval of the design v2.
- Parallel: blocks nothing in code; land it with P1-1.

## Phase 1: foundations (all parallel)

### P1-1 Scopes and tool annotations (M)

- Goal: `ctxpipe:read` and `ctxpipe:write` scopes on `/mcp`; filtered `tools/list`; per-call check.
- Scope: `auth/config.ts` (`oauthProvider` `scopes`, `scopeExpirations`), `routes/auth.ts` (protected resource metadata `scopes_supported`), `auth/withAuth.ts` (401 `scope="ctxpipe:read"`, 403 `insufficient_scope`), legacy grants and API keys = read, API key `permissions`, consent page scope text (`apps/ui`).
- Tests: `routes/mcp.scopes.integration.test.ts`: no credential → 401 with scope; read token → write tool hidden and 403 on call; legacy grant, personal key and org key → read; consent with write unticked → token without write.
- Depends on: none.

### P1-2a Multi-org grant: storage and per-call check (M) [migration]

- Goal: one grant covers a set of orgs; each call names one org; set ∩ live membership decides.
- Scope: Drizzle table `oauth_grant_organizations (grant_id, organization_id, created_at)`; `referenceId` = grant id; JWT claim `https://ctxpipe.ai/grant_id`; legacy `referenceId` = org id read as a one-org set; personal API key org set; `auth/oauth-organization.ts`, `auth/withAuth.ts` (org from the tool `org` argument, not `?orgSlug=`), RLS context per call.
- Tests: `auth/oauth-grant-orgs.integration.test.ts`: org in set + member → allowed; org not in set and unknown org → same `org_not_found`; membership removed → denied on the next call; untick → denied with no new token; legacy grant still works; org key with another `org` → denied.
- Depends on: CTO approval (migration, option A).

### P1-2b Consent org picker and Connected apps page (M)

- Goal: the user ticks orgs at consent and edits or revokes them later, with no reconnect.
- Scope: `apps/ui` consent page (org check boxes, current org ticked), settings page "Connected apps" (client name, scopes, orgs, revoke), backend routes to list and edit the set (OpenAPI + Zod).
- Tests: UI Vitest with msw for the routes; backend route integration test (only own grants, at least one org, membership checked on add).
- Depends on: P1-2a.
- Parallel: with P1-3, P1-4, phase 2.

### P1-3 MCP tool framework (L)

- Goal: one shared base for the seven tools.
- Scope: new `mcp/` modules: tool registry with `title`, annotations, `inputSchema` and `outputSchema`; `org` and `workspace` slug resolution with the same error for unknown and foreign; repository handles (`owner/name`, `host/owner/name` on collision) and URL normalization with `normalizeWorkspaceRepositoryUrl`; `excludeRepositories` matching; ref parse and format (`path` or `handle:path`); cursor (bound to projection SHA, `stale_cursor`); token budget and truncation; TOON text + `structuredContent`; error codes; dynamic server `instructions` (rules first, under 2,048 characters, first 512 stand alone) on `initialize` and `server/discover`; per-principal in-flight limit (8) for parallel bursts.
- Tests: unit tests for handles, refs, cursors and budgets; `mcp/framework.integration.test.ts` with the MCP SDK `Client`: instructions under 2,048 characters with 50 Workspaces in 3 orgs; SSH, HTTPS, `.git` and handle forms exclude the same repository; `tools/list` order is stable; update `routes/mcp.conformance.test.ts`.
- Depends on: none (uses the one-org path until P1-2a lands).

### P1-4 Correlation and telemetry (M)

- Goal: group calls by conversation and turn with no tool arguments.
- Scope: read `_meta` (`traceparent`, `baggage`, `ai.ctxpipe/*`, `openai/session`) and `x-ctxpipe-*` headers; connection key; span attributes per call (`observability/attribution.ts`); `_meta["ai.ctxpipe/callId"]` on results; ClickHouse view for derived session and turn (`ops/observability`).
- Tests: `InMemorySpanExporter`: attributes set, no query text or paths on spans; `traceparent` continues the trace; correlation source `client` vs `derived`.
- Depends on: none.

## Phase 2: data layer

### P2-1 Unit title, source and updated_at (M) [migration]

- Goal: filters by source and time, and titles in results.
- Scope: columns on `workspace_knowledge_units`; hydrate fills `title` (front matter or first heading), `source` (mirror path prefix or `authored`), `updated_at` (last commit time of the path); one `isConnectorMirrorPath` source of truth (CTX-582 suggestion 2, coordinate with CTX-584 phase 1).
- Tests: hydrate integration test on a fixture Workspace repository: each kind of mirror and an authored unit get the right values.
- Depends on: CTO approval.

### P2-2 Knowledge chunks with pgvector and tsvector (L) [migration]

- Goal: indexed search per Workspace instead of the in-memory scan.
- Scope: table `workspace_knowledge_chunks` (unit id, Workspace, org, projection SHA, ordinal, text, generated `tsvector`, `vector` with HNSW, chunk hash); RLS policy (ADR-042); hydrate chunks units and reuses embeddings by chunk hash (replaces the body-hash reuse of CTX-582 suggestion 3; agree with CTX-584 phase 1 who owns it).
- Tests: integration: a second hydrate with one changed unit embeds only its changed chunks (msw counts embedding calls); RLS denies another org.
- Depends on: CTO approval. Parallel with P2-1.

### P2-3 Indexed hybrid knowledge search (M)

- Goal: one domain function for MCP and chat: hybrid RRF in SQL with filters (Workspaces, kinds, path prefix, source, time, unit id set).
- Scope: new `domain/workspaces/knowledge-search.ts`; chat `hybrid_search` (`workspace-chat-retrieval.ts`) switches to it; the org `objects` hits leave the Workspace search.
- Tests: integration on seeded chunks: filters, ranking of an exact keyword and a paraphrase, the unit-id filter that `get_related` uses, latency on 20,000 chunks.
- Depends on: P2-1, P2-2.

### P2-4 Graph projection v2 (M)

- Goal: nodes carry what bounded reads need.
- Scope: `domain/workspaces/graph-projection.ts`: node `path`, `degree`, `inDegree`, `outDegree`; projection version in `workspaceGraphRevisionKey` (old revisions project again); index DDL per engine **[PR350 #3]**.
- Tests: `graph-projection.integration.test.ts` on FalkorDB: properties are set; the version change triggers a new projection; the index statement runs twice without error.
- Depends on: CTO approval of the re-projection (open question 5). Parallel with P2-1 and P2-2.

### P2-5 Bounded graph expansion (M)

- Goal: never load the whole Workspace graph.
- Scope: `domain/workspaces/graph-expand.ts`: per-hop Cypher with predicate, direction, validity (ISO string compare) and confidence filters, top `maxFanOut` per node, caps (5,000 nodes, 25,000 edges, 1 s per hop, 3 s total), `partial` and `cappedHubs` **[PR350 #4]**. Chat `graph_lookup` and `graph_neighbors` (`workspace-chat-tools.ts`) and `routes/v1/workspace-graph-routes.ts` neighbor reads move to it where they read a neighborhood.
- Tests: integration on live FalkorDB: a 2,000-edge hub keeps the top 50 by confidence; expired edges are not walked; caps set `partial`; result is the same in two write orders.
- Depends on: P2-4.

### P2-6 Org-level code search and SCIP fan-out (M)

- Goal: one search over the org's linked repositories by handle, with exclusion before the query.
- Scope: wrapper over `retrieval/services/codeSearch.ts`: org + optional Workspace + handles → checkout keys; deduplicate a repository that several Workspaces link; drop excluded repositories; SCIP fan-out over ≤ 10 repositories in parallel, merge, cap; `skipped` for not-indexed repositories.
- Tests: integration with msw for codesearch: an excluded repository is never in the request; a repository linked twice is searched once; one failing repository gives `skipped`, not an error.
- Depends on: P1-3.

## Phase 3: tools (one release)

### P3-1 `list_workspaces` (M)

- Goal: compact list (≤ 20 tokens per Workspace) and detail for one Workspace.
- Scope: `mcp/tools/list-workspaces.ts`; `_meta["anthropic/alwaysLoad"]`; readiness per store; repository handles; sources one line each.
- Tests: contract: 100 Workspaces fit the list budget; detail lists handles, not `repo_` ids; a foreign org gives `org_not_found`.
- Depends on: P1-3 (P1-2a for several orgs).

### P3-2 `search_knowledge` (M)

- Scope: `mcp/tools/search-knowledge.ts` over P2-3; `workspaces` default all of the org (max 8); snippet = best chunk.
- Tests: contract: filters, cursor walk with no duplicates, `stale_cursor` after a new projection, budget cap, `workspace_not_ready`.
- Depends on: P2-3, P1-3.

### P3-3 `read_file` and `list_files` (M)

- Scope: `mcp/tools/read-file.ts`, `mcp/tools/list-files.ts`; units from the projection, repository files from codesearch; line ranges, `nextStartLine`; `excluded_repository`.
- Tests: contract: unit ref and `handle:path` ref; a path with `:` that is not a handle reads as a unit; line paging; excluded repository refused.
- Depends on: P1-3. Parallel with P3-2.

### P3-4 `search_code` and `find_symbol` (M)

- Scope: `mcp/tools/search-code.ts`, `mcp/tools/find-symbol.ts` over P2-6; `excludeRepositories` required; `excluded` and `skipped` in results.
- Tests: contract with msw codesearch: literal, regex, structural (`language` required); the four SCIP relations; refs work in `read_file`.
- Depends on: P2-6.

### P3-5 Graph relevance scoring (L) [PR350 #1, #2]

- Goal: a pure module for `get_related`: edge weights, query-seeded personalized PageRank, MMR diversity, best-path explanations.
- Scope: `domain/workspaces/graph-relevance.ts` (no I/O): port the signal model of PR #350 `retrievalScore.ts` with `decayWorkspaceSignal` as truth; intent presets; PPR by power iteration; Dijkstra on `−ln w`; MMR with hub and kind overlap.
- Tests: unit tests on small graphs with known PPR values; a hub does not fill the top 10 with `diversity` 0.3; the explanation is the highest-weight path; each signal at weight 0 has no effect.
- Depends on: CTO approval of PR350 #1–2. **Can start at once**, parallel with phases 1 and 2.

### P3-6 `get_related` (M)

- Scope: `mcp/tools/get-related.ts`: seeds → expansion (P2-5) → query relevance on explored units (P2-3) → P3-5 → page and budget; in-process cache by projection key + parameter hash for cursors.
- Tests: contract on live FalkorDB + Postgres: the two examples of the design return the expected order on a fixture graph; `kinds` filters results but not the walk; `validBetween` includes ended edges; cursor page 2 makes no graph query; p95 under 300 ms on the 50,000-edge fixture.
- Depends on: P2-5, P3-5 (P2-3 for `query`; without it the tool runs graph-only).

### P3-7 Remove `ctx_advisor` (S)

- Scope: delete the advisor in `mcp/tools.ts`, `mcp/advisorThread.ts` and tests, `ctx-advisor-*.integration.test.ts`, the MCP Langfuse session and the advisor progress path in `mcp/transport.ts`; `apps/backend/AGENTS.md` and `README.md` mentions.
- Tests: `tools/list` snapshot has the seven tools and no `ctx_advisor`; MCPJam protocol conformance passes.
- Depends on: P3-1 to P3-6 in the same release.

## Phase 4: tests and evals

### P4-1 Eval fixtures and seed (M)

- Scope: `apps/backend/evals/mcp/fixtures/`: two made-up orgs, three Workspaces, fixture Workspace repositories (services, decisions, runbooks, a mirrored ticket, an incident), pinned small public upstream repositories; seed script for local and preview environments.
- Tests: the seed runs on a clean database and produces ready projections.
- Depends on: P2-1, P2-2, P2-4.

### P4-2 MCPJam eval suite and CI (M)

- Scope: `@mcpjam/sdk` suite under `apps/backend/evals/mcp/` (about 20 cases: the design sessions, parallel calls in one turn, two orgs in one session, no-repository agent, stale cursor, structural search, a `get_related` question, the current-repository trap); workflow nightly and on label `mcp-evals`; 3 iterations, pass rate 0.9.
- Depends on: P4-1, phase 3.

### P4-3 Graph relevance eval (M) [PR350 #5]

- Scope: adapt PR #350 `test/engineeringOrgGraph.ts` and `graphRetrievalEval.integration.test.ts` to Workspace units: recall@5 floors per intent, latency budget; runs in the backend test job with FalkorDB.
- Depends on: P2-4, P2-5, P3-5.

## Phase 5: distribution (same release as phase 3)

### P5-1 Plugin 0.2.0 (S)

- Scope: `plugins/ctxpipe`: skill `ctxpipe-context` replaces `ctx-advisor` (loop, parallel calls, exclusion, refs, orgs); version bump; README and SETUP.
- Tests: `.github/workflows/claude-plugin-test.yaml` passes.

### P5-2 Docs, CLI and changeset (M)

- Scope: `apps/docs` `(guide)/mcp/*`, getting-started, workspaces/chat, FAQ, data-processing, self-hosting MCP, authentication and operations; new pages "Use ctxpipe from your agent" and "Connected apps"; `packages/cli/src/mcp/doctor.ts` and `program.ts` text; `.changeset/*` for `@ctxpipe/aws-cdk`.
- Tests: docs build; CLI tests.

## Phase 6: LangGraph and LangChain cleanup

### L1 Remove LangGraph (S)

- Scope: `getConfig()` from `@langchain/core` context in the nine node files; delete `patches/@langchain__langgraph@1.4.7.patch`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint`, `@langchain/langgraph-checkpoint-postgres`, `db/migrate-checkpoints.ts` and its test. Dropping the unused checkpoint tables is a migration **[migration]**.
- Tests: ingestion tests pass without the patch.
- Depends on: none. **Overlap:** CTX-584 lists the same deletion; it moves here, first.

### L2a Model provider and write-path calls off LangChain (M)

- Scope: `retrieval/services/modelProvider.ts` and `providers/*` move to the TanStack AI adapters of chat; callers `commit-subject.ts`, `folder-list.ts`, `semantic-merge.ts`, `dest-workspace-first.ts` (enum schema), `conversation-title.ts`, `chat-sandbox-policy.ts`, `workspace-hydrate.ts`, `workspace-chat-tools.ts`; Langfuse generations for these calls (CTX-582 suggestion 4).
- Tests: msw model provider: each call sends the expected request on OpenRouter, Bedrock and Azure settings; structured outputs parse.
- Depends on: L1. **Overlap:** CTX-584 keeps the write path out of scope, so no conflict; the ingestion callers stay on the old provider until CTX-584 phase 5.

### L2b Slack mention agent and Bedrock proxy route (S)

- Scope: `services/slack/mention-agent.ts` becomes one structured call (CTX-582 suggestion 8); `routes/v1/bedrockOpenAiProxy.ts` off `@langchain/aws`.
- Tests: "yes" captures and noise does not (msw); proxy route test.
- Depends on: L2a.

### L3 Delete the ingestion agents (owned by CTX-584 phase 5)

- Not in this plan. CTX-584 deletes the 10 ReAct agents, `createAgent`, `repoExplorerTools`, `withIngestAgentContext`, `getLangfuseHandler` and the `extractInstructionUnits` LangChain call. PR350 #6 (decision scoping and supersession rules) goes into the CTX-584 `decisions` skill spec.

### L4 Remove the LangChain dependencies (S)

- Scope: remove `langchain`, `@langchain/*`, `@ai-sdk/langchain`, `@langfuse/langchain` from `apps/backend/package.json`; a lint rule bans the imports.
- Tests: build, lint and the backend test suite pass.
- Depends on: L2a, L2b, L3.

## Phase 7: later (not in this release)

- R-1 Resource template `ctxpipe://{org}/{workspace}/{+ref}` for `@`-mention (M).
- C-1 GitHub pull request mirror writes `CHANGED` claims to package units **[PR350 #7]** (S).
- W-* Write slice (`propose_knowledge_change`, `record_learning`, `flag_knowledge`, `get_job`): separate plan.

## Parallel lanes and critical path

| Lane | Tickets |
| -- | -- |
| Auth | P1-1 → P1-2a → P1-2b |
| Framework and code | P1-3 → P2-6 → P3-4; P1-3 → P3-1, P3-3 |
| Knowledge search | P2-1 + P2-2 → P2-3 → P3-2 |
| Graph | P3-5 (from day 1); P2-4 → P2-5 → P3-6 → P4-3 |
| Telemetry | P1-4 |
| Release | P3-7, P4-1 → P4-2, P5-1, P5-2 |
| Cleanup | L1 → L2a → L2b → L4 (after CTX-584 L3) |

Critical path: migration approval → P2-2 → P2-3 → P3-2 / P3-6 → P4-2 → release. P3-5, P1-x and L1 do not wait for approval of the migrations.

## Counts

Phases 0 to 6 hold 28 tickets: phase 0: 1; phase 1: 5; phase 2: 6; phase 3: 7; phase 4: 3; phase 5: 2; phase 6: 4 in this plan (L1, L2a, L2b, L4) + L3 in CTX-584. Phase 7 holds 2 tickets and the write slice. Tickets that need migration approval: P1-2a, P2-1, P2-2, L1 (table drop).
