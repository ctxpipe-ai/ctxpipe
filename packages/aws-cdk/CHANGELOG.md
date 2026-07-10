# @ctxpipe/aws-cdk

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
