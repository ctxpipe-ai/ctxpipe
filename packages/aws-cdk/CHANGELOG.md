# @ctxpipe/aws-cdk

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
