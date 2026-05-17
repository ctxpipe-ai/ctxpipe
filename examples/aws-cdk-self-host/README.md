# `@ctxpipe/aws-cdk-self-host`

Example of how to self-host Ctxpipe on AWS using our @ctxpipe/aws-cdk

This directory is a private workspace package; it is **not** published.

## What it deploys

One CloudFormation stack whose resources are defined entirely by `CtxPipe`. See [packages/aws-cdk/README.md](../../packages/aws-cdk/README.md) for the construct reference.

## Prerequisites

1. **AWS credentials** for a sandbox account with permissions to create the resources listed in the package README.
2. **Region**: use one that supports Neptune and SES (for example `us-east-1`).
3. **Tooling**: Node.js 20+, pnpm 10, AWS CLI for the same account.
4. From the repo root:

   ```bash
   pnpm install
   ```

5. **Bootstrap CDK** once per account/region:

   ```bash
   pnpm --filter @ctxpipe/aws-cdk-self-host exec cdk bootstrap
   ```

`pnpm cdk ...` in this example package now runs through Turbo and automatically builds `@ctxpipe/aws-cdk` first.

## Configuration

The entrypoint [`bin/app.ts`](./bin/app.ts) reads CDK context and passes **`CtxPipeProps`**: `orgSlug`, `modelProvider`, and `customDomain`. Service image tag selection is internal to `@ctxpipe/aws-cdk` and release-managed. **Validation is performed inside `CtxPipe`**, not in this example.

At deploy time you still supply concrete values (CLI `-c` or local `cdk.json`). Recommended keys:

| Context key           | Maps to                         |
| --------------------- | ------------------------------- |
| `orgSlug`             | `orgSlug`                       |
| `modelBaseUrl`        | `modelProvider.baseUrl`         |
| `modelApiKey`         | `modelProvider.apiKey`          |
| `modelDefaultModel`   | `modelProvider.defaultModel`    |
| `domainName`          | `customDomain.domainName`       |
| `hostedZoneId`        | `customDomain.hostedZoneId`     |
| `stackName`           | optional stack id/name (default `CtxpipeSelfHostE2E`) |

Do not commit secrets; pass keys via the environment or `-c` locally.

## Manual e2e

Deploy → smoke (`/health`) → destroy:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host e2e \
  -c orgSlug="acme" \
  -c domainName="app.example.com" \
  -c hostedZoneId="Z0123456789ABCDEF" \
  -c modelBaseUrl="https://api.openai.com/v1" \
  -c modelApiKey="$OPENAI_API_KEY" \
  -c modelDefaultModel="gpt-4.1-mini"
```

Keep the stack for debugging:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host e2e:keep \
  -c orgSlug=... -c domainName=... -c hostedZoneId=... \
  -c modelBaseUrl=... -c modelApiKey=... -c modelDefaultModel=...
```

Tear down later:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host destroy
```

If you override the stack name (`-c stackName=MyStack`), set the same name for smoke:

```bash
CDK_STACK_NAME=MyStack pnpm --filter @ctxpipe/aws-cdk-self-host smoke
```

### Expected runtime

- `cdk deploy`: roughly 25–30 minutes on first run (Aurora, Neptune, SES custom resource).
- `smoke`: polls every 15s for up to ~20 minutes (ECS and migrations).
- `cdk destroy`: roughly 10–15 minutes.

### When smoke fails

1. CloudWatch Logs for `ctxpipe-backend`, `ctxpipe-worker`, `ctxpipe-codesearch`, `ctxpipe-migrate`.
2. ECS service events and task health.
3. ALB target group health for `/health`.

## Cost note

While the stack runs: NAT gateway, Aurora, Neptune, ALB, and Fargate are billed continuously—often on the order of a few dollars per hour in `us-east-1`. Destroy when finished.

## Cleanup caveats

The construct uses conservative removal policies: Aurora and Neptune may retain snapshots; EFS may be retained; SES identity may remain; Secrets Manager entries may sit in recovery. Clean those up in the console if you need a fully empty account.
