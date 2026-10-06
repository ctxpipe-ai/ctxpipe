# Architecture Decision Records

Naming: `ADR-NNN-title-slug.md`. Status | Date | Tags; Context; Decision; Consequences.

Parent: [`.ai/memory/README.md`](../README.md).

**Updated:** 2026-10-05

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](ADR-001-frontend-ui-app-stack.md) | Frontend UI app stack | Accepted |
| [ADR-002](ADR-002-backend-service-stack-and-runtime.md) | Backend service stack and runtime | Accepted |
| [ADR-003](ADR-003-drizzle-beta.md) | Drizzle ORM beta (v1.x) | Accepted |
| [ADR-004](ADR-004-local-development-docker-compose.md) | Local development with Docker Compose | Superseded by [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md) |
| [ADR-005](ADR-005-langgraph-integration.md) | LangGraph + LangChain integration | Superseded |
| [ADR-006](ADR-006-langsmith-studio-dev-routes.md) | LangSmith Studio dev routes | Superseded — LangSmith removed; no replacement |
| [ADR-007](ADR-007-remove-cloudflare-workers-runtime.md) | Remove Cloudflare Workers runtime | Accepted |
| [ADR-008](ADR-008-codesearch-zoekt-orchestration.md) | Codesearch Zoekt, SCIP, and ast-grep | Accepted |
| [ADR-009](ADR-009-ui-src-folder-structure.md) | UI src folder structure | Accepted |
| [ADR-010](ADR-010-opencypher-graph-db-falkordb-default.md) | OpenCypher Graph DB and FalkorDB as Default | Accepted |
| [ADR-011](ADR-011-backend-observability-otel.md) | Backend Observability via OpenTelemetry and evlog | Accepted |
| [ADR-012](ADR-012-postgres-17-neon-compatibility.md) | PostgreSQL 17 for Neon Compatibility | Accepted |
| [ADR-013](ADR-013-switch-infra-from-pulumi-to-terraform.md) | Terraform as our IAC | Accepted |
| [ADR-014](ADR-014-parallel-worktree-local-development.md) | Parallel worktree local development | Accepted |
| [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md) | Docker Compose profiles and small-scale container deploy | Accepted |
| [ADR-016](ADR-016-code-ingestion-react-agent-limits.md) | Code ingestion ReAct agents — recursion limits and context middleware | Accepted |
| [ADR-017](ADR-017-amplitude-analytics.md) | Amplitude analytics (UI + backend) | Superseded by [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md) |
| [ADR-018](ADR-018-unified-connections-table.md) | Unified `connections` table | Accepted |
| [ADR-019](ADR-019-confluence-forge-self-host-and-per-org-atlassian-3lo.md) | Confluence / Forge self-host, per-org Atlassian 3LO, and provision pipeline | Accepted |
| [ADR-020](ADR-020-changeset-ci-guard-policy.md) | Changeset CI guard policy | Accepted |
| [ADR-021](ADR-021-local-agent-memory-agentmemory-hybrid-mcp-proxy.md) | Local agent memory with repo Markdown and AgentMemory hydrated cache | Superseded by [ADR-024](ADR-024-markdown-only-local-memory-capture.md) |
| [ADR-022](ADR-022-linear-connector-git-native-mirror.md) | Linear connector Git-native mirror | Accepted |
| [ADR-023](ADR-023-notion-connector-git-native-mirror.md) | Notion connector Git-native mirror | Accepted |
| [ADR-024](ADR-024-markdown-only-local-memory-capture.md) | Markdown-only local memory with candidate-first capture | Accepted (amended by ADR-037) |
| [ADR-025](ADR-025-slack-connector-git-native-mirror.md) | Slack connector as intent-based git-native capture | Accepted |
| [ADR-026](ADR-026-claude-plugin-mcp-distribution.md) | Claude plugin for hosted MCP distribution | Accepted |
| [ADR-027](ADR-027-codesearch-openworkflow-concurrency.md) | Size-based OpenWorkflow concurrency for single-instance codesearch | Accepted |
| [ADR-028](ADR-028-git-native-connector-assets.md) | Git-native connector assets | Accepted |
| [ADR-029](ADR-029-railway-us-east-next-to-neon.md) | Railway compute in US East next to Neon | Accepted |
| [ADR-030](ADR-030-organization-owned-mcp-api-keys.md) | Organization-owned MCP API keys | Accepted (amended 2026-09-27: OpenCode HOME hashing) |
| [ADR-031](ADR-031-github-pr-scoped-mirror.md) | GitHub pull-request scoped mirror (revised: follows linked repositories) | Accepted (revised 2026-10-03) |
| [ADR-032](ADR-032-path-located-graph-edges.md) | Path-located graph edges | Accepted (amended by ADR-033) |
| [ADR-033](ADR-033-graph-ontology-v2.md) | Graph ontology v2: relation families, shared identity, deterministic connector extraction | Accepted (amended by ADR-037) |
| [ADR-034](ADR-034-pagerduty-connector-git-native-mirror.md) | PagerDuty connector Git-native mirror | Accepted |
| [ADR-037](ADR-037-committed-memory-reaches-the-graph.md) | Committed memory reaches the graph | Accepted |
| [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md) | Self-hosted ClickStack + Langfuse (ops observability) | Accepted (amended 2026-09-29) |
| [ADR-039](ADR-039-production-image-deploys-one-environment.md) | Production image deploys stay on one Railway environment | Accepted |
| [ADR-040](ADR-040-pierre-files-pane-chrome.md) | Pierre trees/diffs as Workspace Files explorer chrome | Accepted |
| [ADR-041](ADR-041-short-org-sql-unique-sandbox-rows.md) | Short org SQL transactions, no held connections | Accepted |
| [ADR-042](ADR-042-postgres-rls-app-role.md) | Postgres RLS with a non-owner app role | Accepted |
| [ADR-043](ADR-043-workspace-chat-keep-alive-serve.md) | In-sandbox keep-alive OpenCode serve | Superseded by [ADR-044](ADR-044-workspace-chat-stock-tanstack.md) |
| [ADR-044](ADR-044-workspace-chat-stock-tanstack.md) | Stock TanStack workspace chat | Accepted |
| [ADR-045](ADR-045-required-recovery-ci.md) | CI proves what ran | Accepted |
| [ADR-046](ADR-046-workspace-revision-projection-identity.md) | Workspace revision and projection identity | Accepted |
| [ADR-047](ADR-047-native-durable-write-workflows.md) | Durable write workflows | Accepted |
| [ADR-048](ADR-048-native-postgres-sandbox-ownership.md) | Conversation sandboxes: stock providers, Postgres ownership, git as durable state | Accepted |
| [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md) | Self-host chat sandboxes: stock Docker on DinD and an EC2 host | Accepted |

Numbers 035 and 036 are unused. The next new ADR is 050.
