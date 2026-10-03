# Main intent carried into Workspaces

Ledger for ticket [07](issues/07-carry-main-intent.md). One row per `main` PR since the fork (`ba7c9f80`, 2026-08-13). Status: `done` (with proof) · `todo` · `verify (NN)` (code path is carried; proof comes from ticket NN) · `n/a` (reason).

Timing matters: PRs up to #296 reached the branch before the recovery rewrite (#319, 2026-09-11) and were reworked by it. #297–#358 arrived in the plain 2026-09-27 merge after the rewrite. #359–#377 arrived in `9fe4ba0c` (2026-10-01) and were reconciled by intent.

## Open work (in fix order)

| # | Row | Main PRs | Status |
| --- | --- | --- | --- |
| 1 | Job attribution: 25 workflows called `openworkflow`'s `defineWorkflow` directly (all `workspace-*` writes, Confluence/Notion/Linear config+entity, Slack agent), so their spans carried no org/workspace/connection attribution | #364, #343 | done — all use `defineObservedWorkflow`, which now accepts union schemas (`workspace-bootstrap`); proof `defineObservedWorkflow.test.ts` "accepts enqueue telemetry on a union schema…" |
| 2 | Product analytics: `advisor_question_sent` and `repository_index_started` disappeared with the old Chat and Repositories pages | #343 | done — `advisor_question_sent` on first send (`openWorkspaceConversation`) and follow-up turns (`WorkspaceChatSession`), `repository_index_started` on linking repositories, new `workspace_created`; names kept so HyperDX dashboards keep working; proof `start-workspace-conversation-ui.test.ts`. Test policy now treats `@hyperdx/browser` as an external SDK |
| 3 | Workspace graph dropped ontology v2 kinds: every node was `KnowledgeUnit` although extraction and export write `kind` front matter | #335 | done — hydrate keeps `kind`, `workspace_knowledge_units.kind` (migration `20261001134018`), graph nodes use it (fallback `KnowledgeUnit`); proof `hydrate.test.ts` "keeps the ontology kind…". Existing projections pick it up on next hydrate |
| 4 | Graph quality tooling read the legacy `objects`/`claims` tables, which this branch no longer writes | #335 | done — `computeWorkspaceGraphQuality` over the active projection; `GET /workspaces/{slug}/graph/quality`; `graphQualityReport --org-id --workspace-id`; org-wide `/knowledge-graph` routes and `knowledgeGraphQuality.ts` removed (UI no longer called them). Proof `hydrate.test.ts` "computeWorkspaceGraphQuality…". `repoGraphSizeCheck` still counts legacy objects → ticket 04 |
| 5 | Workspace graph queries on Neptune (CDK) | #341 | done (review) — only `MATCH`/`MERGE`/`UNWIND`/`SET`/`ORDER BY` with map params; no `LIMIT`/`SKIP` params, APOC or dialect functions; counts read via `Number()`; tenant-unique `projectionKey`. Live proof: Graph pane on the CDK example in ticket 03 |
| 6 | Codesearch partial results: `main` keeps an incomplete SCIP shard and reports `complete_with_issues` | #286, #290, #371 | done — no user decision needed: the branch already published on SCIP-only failure but marked the repository `ready` and dropped the reason. `indexingOutcome` (proof `indexing-outcome.test.ts`) now marks `complete_with_issues` with the SCIP reason; Zoekt failure still keeps the previous revision. Workspace Settings shows "Indexed with issues" + reason on linked repositories (story `LinkedRepositoryWithIssues`) |
| 7 | Connector assets: capture recorded paths only, so every connector re-downloaded all assets each sync | #298, #362 | done — `captureConnectorMirrorTarget` returns blob ids (`listTreeBlobs`, proof `services/git/pack.test.ts` on a real repo); Linear, Notion and Confluence content + entity workflows pass `existingBlobs` (skip proven in `linear/sync.test.ts` "omits unchanged binary assets…"). PagerDuty mirrors text only |
| 8 | Claim collapse per triple + source key and bind-cap batching | #368 | done — collapse already happens in the planner (claims unioned per target, predicate and evidence source; objects merged per dedup key). Hydrate wrote every unit in one `INSERT` (~11 params/row → fails past ~6k units) and every embedding in one `UPDATE`; now batches of 500 / 200 in the same transaction. Proof: `hydration.contract.test.ts` 7,000-file case (red without batching, green with) |
| 9 | Verify `linkPackageHierarchy` claims pass the typed extract write | #371 | done — `plan-extraction.test.ts` runs the real `linkPackageHierarchy` output through `planCapturedExtraction`: `PART_OF` and `IMPLEMENTED_IN` (→ `AGENTS.md`) land in knowledge files |
| 10 | GitHub repository picker sorting and indexing queue clarity: the Repositories page was removed | #277, #299 | done — Workspace create picker and Add repositories dialog sort (recently pushed default, newest, oldest, name) via shared `GithubRepoSortSelect` + main's `sortGithubRepos` (proof `githubRepoSelection.test.ts`); link toast says repositories are queued for indexing. Visual check in ticket 06 |
| 11 | Public docs describe the removed org-wide Chat, Repositories and Knowledge graph pages and `ctx_advisor` as the main entry; rewrite for Workspaces (after ticket 08) | #300 | done — new Workspaces section (overview, create, knowledge files, linked repositories, chat, graph); getting-started, connections, connector, MCP, privacy and self-host pages moved from "context repository"/Repositories/Chat to Workspaces; old sections removed with redirects; docs build and internal links check. Sandbox specifics → tickets 02/03; the Add Workspace entry → ticket 11 |
| 12 | Dead legacy advisor: `graphs/conversationGraph` was unused except the title helper | #355 | done — 2,085 lines deleted; title helpers moved to `domain/workspaces/conversation-title.ts` (proof `conversation-title.test.ts`). ADR-006 still describes the deleted graph registry → ticket 08 |
| 13 | `deploy.yaml`: production images via `scripts/railway-set-images.sh` after the `ctxpipe_app` role steps | #365 | done (`9fe4ba0c`) |
| 14 | Confluence setup still picked a GitHub repository ("context repository") while mirrors only land in a Workspace's repository, so a non-Workspace pick failed every sync ("Connector target has no Workspace") | #262, #298 | done — Confluence uses the shared Workspace picker like Linear, Notion, Slack and PagerDuty (story `SelectSyncTarget` play asserts the saved target); the unused `ctxpipe-context` guidance component and helpers are deleted. MCP `ctx_advisor` text no longer claims the deleted CoALA graph |
| 15 | GitHub merged-PR mirror still picks its target like the old context repository (a repository another connector binds, else one named `ctxpipe-context`) rather than a Workspace; it works only when that repository is a Workspace's (`models/github-pr-mirror-target.ts`) | #262 | done (ticket 12) — merged PRs mirror into every Workspace that links the repository (`models/github-pr-mirror.ts` over `workspace_linked_repositories`; the broker's scope check re-reads the git declaration); hydrate backfills each newly linked repository; one `github-sync-pull-request` workflow reads a page per GraphQL request. Dropped by the "no setup, every linking Workspace" decision: the `github/config.yaml` scope policy, `connections.config.prMirror` (stale JSON in existing rows is ignored), the install-time `contextRepository` (the branch UI has no picker for it), the startup sweep, the bind API and `ctxpipe-context` heuristics (proof `github-pr-mirror-native.contract.test.ts`, ADR-031 revision). Browser check in ticket 06 |

## Ledger

| PR | Intent | Branch surface | Status |
| --- | --- | --- | --- |
| #277 | Git sources and connectors at real density | Repositories page removed; pickers in Workspace create/settings | todo (row 10) |
| #281 | Product-ui skill + DESIGN.md | Guidance only | n/a (applies to all UI work) |
| #283 | Cursor sub-agent models | Agent tooling | n/a |
| #284 | Roll existing PR preview images | CI | n/a |
| #285 | Cross-tenant MCP access fix, Streamable HTTP hardening | `mcp/transport.ts` 3-line diff vs main; RLS on tenant tables | done (transport unchanged; `mcp/transport.test.ts`, `db/rls-isolation.test.ts`) |
| #286 | Codesearch OOM → memory-fit error, `complete_with_issues` | Native source index publication | todo (row 6) |
| #287, #291, #296, #308, #353 | Memory-capture hook fixes | `packages/cli` | n/a (unchanged by branch) |
| #288 | Source-connectors skill | Guidance | n/a |
| #267 | Slack intent-based thread capture | Slack agent → typed native mirror (ADR-047) | done (reworked in recovery Gate 3) |
| #293 | Notion setup docs, connector status hardening | Connector routes unchanged | verify (06) |
| #294 | Slack OAuth scope drift diagnostics | Unchanged path | done |
| #297 | Simplicity review axis | Agent guidance | n/a |
| #299 | GitHub repo sorting, indexing queue clarity | Repositories page removed | todo (row 10) |
| #300 | Documentation overhaul | `apps/docs` | todo (row 11) |
| #302 | `step.runWorkflow` for in-workflow ingestion | Connector parents + ingestion use `runWorkflow` | done |
| #304 | Claude plugin for hosted MCP | Plugin skill calls `ctx_advisor` (deprecated shim still served) | n/a (shim kept; revisit when fine-grained MCP tools land) |
| #305 | Size-based codesearch concurrency | Codesearch admission + backend capacity | done (code carried; codesearch contract lane) |
| #298 | Durable assets across connectors | Native mirror capture | todo (row 7) |
| #311, #312 | Forge production deploy | CI | n/a |
| #290 | SCIP optional, graceful OOM | Native source index | todo (row 6) |
| #324, #327 | Railway region next to Neon | Infra | n/a (Cloudflare sandbox region chosen in ticket 02) |
| #329, #332 | Wait for codesearch index capacity | `repository-index.ts` rethrows admission-busy | done |
| #316, #330, #336 | MCP API keys (user + org-owned), Bearer keys | `ctx_advisor` shim handles `org-service` actor | done (verify in 06 `mcp` area) |
| #334 | SleepSignal is a park, not a failure | `isWorkflowControlSignal` across workflows | done |
| #335 | Graph ontology v2 | Extraction writes v2 to git; workspace graph flattens kinds; quality tooling reads legacy tables | todo (rows 3, 4) |
| #342, #344 | GitHub PR mirror setup + graph ingestion | PR mirror workflows publish via native mirror | done |
| #341 | ctx_advisor on Neptune | Workspace graph queries | todo (row 5) |
| #346 | Scope claim refresh DB reads | Legacy claims path | n/a (legacy tables no longer written) |
| #340 | Linear OAuth app creds on the connection | `linear-sync-*` use `getLinearOauthAppCreds` | done |
| #339 | Notion self-host OAuth | Connector routes | done |
| #328 | PagerDuty connector | `pagerduty-sync-*` publish via native mirror | done |
| #320 | Invite 403 when signed in as another account | Auth/UI unchanged | done (verify in 06 `auth`) |
| #348 | Start connector sync when config already matches after rebind | ADR-047 "unchanged config admits content work" | done |
| #351 | Committed memory reaches git and the graph | `extractInstructionUnits` instruction sources | verify (04) |
| #355 | ctx_advisor step-limit fallback | Legacy LangGraph advisor, no longer on the product path | n/a (row 12 deletes it) |
| #343, #358 | Self-hosted ClickStack + Langfuse | Branch workflows, chat, UI analytics | todo (rows 1, 2) |
| #359 | Cost dashboard | Ops | n/a |
| #360 | Railway credential sync fix | Infra | n/a |
| #362 | Linear budgeted GraphQL, page checkpoints, batched GitHub commits | `linear-sync-content.ts`, `commitFiles` | done (`9fe4ba0c`) |
| #363 | Default chat tiers (GPT-6 Luna, MiMo) | `modelProvider.ts` shared by workspace chat | done |
| #364 | OpenWorkflow native traces | `openworkflow/client.ts` | done (`9fe4ba0c`); attribution gap is row 1 |
| #365 | Production image deploys on one environment | `deploy.yaml` | done (row 13) |
| #368 | Ingest claims from prefetch, no giant `IN` | Extraction merge + hydrate | todo (row 8) |
| #369 | ClickHouse memory cap | Ops | n/a |
| #371 | TypeScript monorepos per project; incomplete shard reported | `repository-index.ts`, extraction | todo (rows 6, 9) |
| #372 | Fake clock in blob spacing test | Test | done |
| #374 | Sub-agents on Opus | Agent guidance | n/a |
| #376 | Bun 1.4.2 | Dockerfiles | done (`9fe4ba0c`) |
| #377 | Telemetry export off the request path | `migrate.ts`, chat WebSocket logger holder | done (`9fe4ba0c`) |

## Merge-time fixes (`9fe4ba0c`)

- Branch ADRs 039–047 renumbered to 040–048 (main took 039).
- One Better Auth type graph: `@daveyplate/better-auth-ui>better-call` override, backend `@opentelemetry/api` ^1.9.1, UI declares `zod`.
- Linear codegen `useTypeImports`; latent main typecheck errors fixed (main has no CI typecheck).
- Flaky SCIP serialization test from main → ticket 10.
