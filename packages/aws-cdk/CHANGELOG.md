# @ctxpipe/aws-cdk

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
