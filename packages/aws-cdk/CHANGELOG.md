# @ctxpipe/aws-cdk

## 3.1.6

### Patch Changes

- 5e29c73: Capture durable Slack, Linear, Notion, and Confluence assets in context repositories with bounded downloads and safe reconciliation.

## 3.1.5

### Patch Changes

- 041401e: Inject size-derived OpenWorkflow and codesearch indexer concurrency so a single codesearch replica is not overloaded when worker count grows.

## 3.1.4

### Patch Changes

- 6982d66: Fan out in-workflow repository ingestion with `step.runWorkflow` so parent workflows sleep and free concurrency slots while children run.

## 3.1.3

### Patch Changes

- d93a844: Pass Notion connector credentials to the self-hosted backend and worker services.

## 3.1.2

### Patch Changes

- 049e626: Add GitHub repository sorting and distinguish queued repositories from active indexing.
- 2456609: Ship explicit Slack app-mention permissions, installation diagnostics, and safe OAuth failure handling for hosted and self-hosted connectors.

## 3.1.1

### Patch Changes

- c7aef1e: Ship DB-only Linear and Notion status reads and stop stable connector-page polling to prevent GitHub throttling from exhausting PostgreSQL connections.
- 34f8818: Allow optional Slack app credentials (`SLACK_CLIENT_*`, `SLACK_SIGNING_SECRET`) in connector secrets for self-hosted ECS.

## 3.1.0

### Minor Changes

- b694aaa: Add the production-ready Notion connector, including scoped page and database mirroring, recursive child-page sync, GitHub-backed Markdown output, OAuth refresh handling, and app-level webhook-driven updates.
- b5dd479: Raise codesearch Fargate memory to 4/8/12 GiB on small/medium/large so ingest peaks fit. Upgrading this package and running `cdk deploy` also rolls pinned backend, worker, UI, codesearch, and migrate images: Zoekt-optional `complete_with_issues` ingest, the memory-fit error instead of `fetch failed`, and the Postgres enum migration (run automatically on deploy).
- 412a83d: Add the Git-native Linear connector, including OAuth, signed incremental webhooks, reviewable scope configuration, content mirroring, deployment wiring, and self-hosting support.
- b694aaa: Add Notion OAuth and webhook secret injection to the self-hosted AWS construct.

### Patch Changes

- 5423a9d: Fix invited-user onboarding so successful invitation acceptance joins the intended organization and failed acceptance remains visible instead of redirecting users to organization creation.
- 3e6bd1e: Make Git sources usable at hundreds of repositories (virtualised list and picker, merge-on-save) and unify the connectors list and setup wizard chrome.
- aa4987a: Select TypeScript SCIP only when a root `tsconfig.json` / `jsconfig.json` exists, so nested-only configs no longer schedule `scip-typescript` (and fail ingest) when the indexer always runs with cwd at checkout root.
- 52370f7: Require organisation membership for MCP and org-scoped REST. Harden Streamable HTTP transport and add ctxpipe doctor mcp plus version-pinned MCPJam diagnostic scripts.
- c07af15: Large-repository indexing reliability: SCIP/Zoekt phase orchestration, bounded indexer concurrency, tenant-safe Zoekt identity, safer indexer child env, durable repository deletion, and related ingestion scale fixes.
- 602f56c: Harden Linear and Notion connector setup sync edges: keep wizards on the merge step while config PRs are in flight, initialise empty GitHub repos before content commits, pass the binding branch into repository ingestion, and improve Linear mirror readability (names and private media placeholders).

## 3.0.2

### Patch Changes

- de67036: Improve chat, graph, and repository indexing UX.

## 3.0.1

### Patch Changes

- 7f9e003: Improve deterministic library extraction during code ingestion by adding manifest-based prepass detection across major ecosystems, running LLM fallback only for ambiguous roots, and preserving per-claim extraction provenance for deterministic vs LLM findings.
- 04c6fa9: Validate Bedrock embedding model IDs in `CtxPipe` so non-Cohere values fail fast at synth/deploy instead of causing runtime ingestion failures. Also treat blank `models.embedding` as unset and keep the default `cohere.embed-v4:0`.
- 868094c: Reduce instruction-unit extraction latency on dense agent-rule files by preferring one unit per normative span, capping `source_excerpt` length, disabling reasoning on that call, and deduping identical excerpts before promotion.
- 67e5ebf: Mitigate Bedrock repository-ingestion stalls by using non-streaming chat models for code-ingestion agents and hardening the ingest OpenWorkflow step retry (3 attempts with backoff). Conversation/MCP UI streaming is unchanged.

## 3.0.0

### Major Changes

- aff4d60: Breaking: remove `modelProvider.defaultModel` and separate embedding provider overrides (`embedding.baseUrl`, `embedding.apiKey`, `CtxPipeEmbeddingOverrides`). Configure openai-like and bedrock tiers through the required `models` prop (`models.fast` required).

  Migration:
  - Replace `defaultModel: "..."` with `models: { fast: "..." }`.
  - Remove `embedding.baseUrl` / `embedding.apiKey` — embeddings use the same provider URL and credentials as chat.

  Add Amazon Bedrock model provider support: `modelProvider.kind: "bedrock"` with per-tier model IDs and ECS task-role IAM (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`). The backend calls Bedrock Runtime natively with SigV4 credentials from the task role; no `MODEL_PROVIDER_API_KEY` secret is created.

### Minor Changes

- a4e252d: Allow users to manually trigger re-indexing and fix un-indexing bug

### Patch Changes

- 26701a1: Resolve idle transaction error
- aff4d60: Fix size profile database instance classes so Aurora PostgreSQL and Neptune use AWS-supported combinations (t4g.medium floor for small; r6g for larger Neptune tiers).
- aff4d60: Run the codesearch ECS container as uid/gid 1000 so Git repo-cache checkouts on EFS match the access point POSIX owner and avoid dubious-ownership reindex failures.

## 2.1.0

### Minor Changes

- 99dbb8b: Supports users' API key/tokens

### Patch Changes

- c5e635c: Use pg pool for codesearch to prevent dead connections
- 7e89d75: Fix GitHub repository setup so registering an installation no longer ingests all accessible repos before the user saves their selection. Select-mode saves now prune unselected connection-linked repositories and sync only chosen repos.
- 8607284: Fix org creation from the side nav so users redirect to the new org setup flow and the org switcher list refreshes immediately after create.
- 2be3a58: Fix the repositories page so select-specific GitHub setup only shows selected repositories as pending indexing, instead of every GitHub-accessible repository.
- 4247441: Ship the Elastic License 2.0 text with the package.
- 5bb0d02: Fix repo ingestion workflow
- 42653ff: Fix transaction behaviour for workflow
- 6650690: Resolve issues with ingestion timing out
- e60a18b: Fix selected GitHub repository saves so newly selected repos are linked and visible in the repositories list immediately while ingestion starts.
- 5890062: Fine-tune system prompt

## 2.0.0

### Major Changes

- 787a625: bugfix on unindexing repos

### Patch Changes

- 1945265: added CLI snippet to MCP slide during onboarding, and improved onboarding performance
- aeb90f3: Fix GitHub repository Manage flow so connected organisations open the correct GitHub App scope popup.
- 5e1ec05: Interaction fixes to the knowledge-graph UI

## 1.1.2

### Patch Changes

- 55c4840: Simplify backend Langfuse tracing: attach the LangChain callback handler once at graph boundaries and remove duplicate per-node callback wiring that caused Langfuse runMap warnings.

## 1.1.1

### Patch Changes

- 5b60917: Change how docker image tag is pinned

## 1.1.0

### Minor Changes

- Added size props to @ctxpipe/aws-cdk to allow customers configure AWS resources sizing.

## 1.0.2

### Patch Changes

- Ensure @ctxpipe/aws-cdk always get the latest changes for self-hosted customers.
- Add missing steps to Github Self-Host instructions.

## 1.0.1

### Patch Changes

- a797ca4: Remove serviceImageTag as allowing consumers to configure this can cause issue as provided image tag might not be compatible with the infra deployed by ctxpipe-ai/aws-cdk

## 1.0.0

### Major Changes

- 4574794: Customers can now self-host Ctxpipe on AWS with our @ctxpipe/aws-cdk
