# Architecture Decision Records

Naming: `ADR-NNN-title-slug.md`. Status | Date | Tags; Context; Decision; Consequences.

Parent: [`.ai/memory/README.md`](../README.md).

## Index

| ADR | Title | Status |
|-----|-------|--------|

| [ADR-001](ADR-001-frontend-ui-app-stack.md) | Frontend UI app stack | Accepted |
| [ADR-002](ADR-002-backend-service-stack-and-runtime.md) | Backend service stack and runtime | Accepted |
| [ADR-003](ADR-003-drizzle-beta.md) | Drizzle ORM beta (v1.x) | Accepted |
| [ADR-004](ADR-004-local-development-docker-compose.md) | Local development with Docker Compose | Superseded |
| [ADR-005](ADR-005-langgraph-integration.md) | LangGraph + LangChain integration | Superseded |
| [ADR-006](ADR-006-langsmith-studio-dev-routes.md) | LangSmith Studio dev routes | Accepted |
| [ADR-007](ADR-007-remove-cloudflare-workers-runtime.md) | Remove Cloudflare Workers runtime | Accepted |
| [ADR-008](ADR-008-codesearch-zoekt-orchestration.md) | Codesearch service and Zoekt orchestration | Accepted |
| [ADR-009](ADR-009-ui-src-folder-structure.md) | UI src folder structure | Accepted |
| [ADR-010](ADR-010-opencypher-graph-db-falkordb-default.md) | OpenCypher Graph DB and FalkorDB as Default | Accepted |
| [ADR-011](ADR-011-backend-observability-otel.md) | Backend Observability via OpenTelemetry and evlog | Accepted |
| [ADR-012](ADR-012-postgres-17-neon-compatibility.md) | PostgreSQL 17 for Neon Compatibility | Accepted |
| [ADR-013](ADR-013-switch-infra-from-pulumi-to-terraform.md) | Terraform as our IAC | Accepted |
| [ADR-014](ADR-014-parallel-worktree-local-development.md) | Parallel worktree local development | Accepted |
| [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md) | Docker Compose profiles and small-scale container deploy | Accepted |
| [ADR-016](ADR-016-code-ingestion-react-agent-limits.md) | Code ingestion ReAct agents — recursion limits and context middleware | Accepted |
| [ADR-017](ADR-017-amplitude-analytics.md) | Amplitude analytics (UI + backend) | Accepted |
| [ADR-018](ADR-018-unified-connections-table.md) | Unified `connections` table | Accepted |
| [ADR-019](ADR-019-confluence-forge-self-host-and-per-org-atlassian-3lo.md) | Confluence / Forge self-host, per-org Atlassian 3LO, and provision pipeline | Accepted |
| [ADR-020](ADR-020-changeset-ci-guard-policy.md) | Changeset CI guard policy | Accepted |
| [ADR-021](ADR-021-local-agent-memory-agentmemory-hybrid-mcp-proxy.md) | Local agent memory with repo Markdown and AgentMemory hydrated cache | Superseded by [ADR-024](ADR-024-markdown-only-local-memory-capture.md) |
| [ADR-022](ADR-022-linear-connector-git-native-mirror.md) | Linear connector Git-native mirror | Accepted |
| [ADR-023](ADR-023-notion-connector-git-native-mirror.md) | Notion connector Git-native mirror | Accepted |
| [ADR-024](ADR-024-markdown-only-local-memory-capture.md) | Markdown-only local memory with candidate-first capture | Accepted |
| [ADR-025](ADR-025-slack-connector-git-native-mirror.md) | Slack connector as intent-based git-native capture | Accepted |
| [ADR-026](ADR-026-claude-plugin-mcp-distribution.md) | Claude plugin for hosted MCP distribution | Accepted |
| [ADR-027](ADR-027-codesearch-openworkflow-concurrency.md) | Size-based OpenWorkflow concurrency for single-instance codesearch | Accepted |
