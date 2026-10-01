# Main intent carried into Workspaces

Ledger for ticket [07](issues/07-carry-main-intent.md). One row per `main` PR since the fork (`ba7c9f80`, 2026-08-13). Status: `done` (with proof) · `todo` · `verify (NN)` (code path is carried; proof comes from ticket NN) · `n/a` (reason).

Timing matters: PRs up to #296 reached the branch before the recovery rewrite (#319, 2026-09-11) and were reworked by it. #297–#358 arrived in the plain 2026-09-27 merge after the rewrite. #359–#377 arrived in `9fe4ba0c` (2026-10-01) and were reconciled by intent.

## Open work (in fix order)

| # | Row | Main PRs | Status |
| --- | --- | --- | --- |
| 1 | Job attribution: 25 workflows called `openworkflow`'s `defineWorkflow` directly (all `workspace-*` writes, Confluence/Notion/Linear config+entity, Slack agent), so their spans carried no org/workspace/connection attribution | #364, #343 | done — all use `defineObservedWorkflow`, which now accepts union schemas (`workspace-bootstrap`); proof `defineObservedWorkflow.test.ts` "accepts enqueue telemetry on a union schema…" |
| 2 | Product analytics: `advisor_question_sent` and `repository_index_started` disappeared with the old Chat and Repositories pages; the Workspace UI emits no equivalent (chat message sent, workspace created, repository linked / index started) | #343 | todo |
| 3 | Workspace graph drops ontology v2: every node is `kind: "KnowledgeUnit"` although extraction writes `kind` front matter and v2 predicates | #335 | todo |
| 4 | Graph quality tooling reads the legacy `objects`/`claims` tables, which this branch no longer writes: `graphQualityReport`, `repoGraphSizeCheck`, `GET …/knowledge-graph/quality` must read the workspace projection (also needed by ticket 04) | #335 | todo |
| 5 | Workspace graph queries on Neptune (CDK): check `UNWIND`/`MERGE` with map parameters and integer limits against Neptune openCypher | #341 | todo |
| 6 | Codesearch partial results: `main` keeps an incomplete SCIP shard and reports `complete_with_issues`; the branch publishes a source revision only when Zoekt and SCIP both complete. Decide the rule; surface index issues on the Workspace (the Repositories page that showed them is gone) | #286, #290, #371 | todo (needs user decision) |
| 7 | Connector assets: capture records paths only, so every connector re-downloads all assets each sync; return blob SHAs and pass `existingBlobs` | #298, #362 | todo |
| 8 | Claim collapse per triple + source key and bind-cap batching in the branch's extraction merge and hydrate projection | #368 | todo |
| 9 | Verify `linkPackageHierarchy` claims pass the typed extract write | #371 | todo |
| 10 | GitHub repository picker sorting and indexing queue clarity: the Repositories page and its setup form were removed; apply to the Workspace create form and linked-repository picker | #277, #299 | todo |
| 11 | Public docs describe the removed org-wide Chat, Repositories and Knowledge graph pages and `ctx_advisor` as the main entry; rewrite for Workspaces (after ticket 08) | #300 | todo |
| 12 | Dead legacy advisor: `graphs/conversationGraph` (~1,700 lines) is unused except `conversationNaming`; `langgraph.json` lists stale graphs. Delete (ticket 13 intent) | #355 | todo |
| 13 | `deploy.yaml`: production images via `scripts/railway-set-images.sh` after the `ctxpipe_app` role steps | #365 | done (`9fe4ba0c`) |

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
