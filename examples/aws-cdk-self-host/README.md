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
   pnpm --filter @ctxpipe/aws-cdk-self-host cdk bootstrap
   ```

`pnpm cdk ...` in this example package now runs through Turbo and automatically builds `@ctxpipe/aws-cdk` first.

## Configuration

The entrypoint [`bin/app.ts`](./bin/app.ts) reads CDK context and passes **`CtxPipeProps`**: `orgSlug`, optional `size`, `modelProvider`, and `customDomain`. Service image tag selection is internal to `@ctxpipe/aws-cdk` and release-managed. **Validation is performed inside `CtxPipe`**, not in this example.

At deploy time you can override values with CLI `-c` or by editing [`cdk.json`](./cdk.json). Defaults in `cdk.json` match the ctxpipe AWS sandbox (`testing-4mh`, `app.aws.ctxpipe.ai`) so `cdk bootstrap` and `cdk synth` work without extra flags.

| Context key      | Maps to                                                   |
| ---------------- | --------------------------------------------------------- |
| `orgSlug`        | `orgSlug`                                                 |
| `domainName`     | `customDomain.domainName`                                 |
| `hostedZoneId`   | `customDomain.hostedZoneId`                               |
| `modelFast`      | `modelProvider.models.fast` → `MODEL_FAST_NAME`           |
| `modelMedium`    | `modelProvider.models.medium` → `MODEL_MEDIUM_NAME`       |
| `modelHigh`      | `modelProvider.models.high` → `MODEL_HIGH_NAME`           |
| `modelEmbedding` | `modelProvider.models.embedding` → `MODEL_EMBEDDING_NAME` |
| `size`           | optional `size` (`small` default, or `medium`/`large`)    |
| `stackName`      | optional stack id/name (default `CtxpipeSelfHostE2E`)      |

Bedrock model specs use **dot** ids with optional **`reasoning.effort`** query params (see [`cdk.json`](./cdk.json)), for example `openai.gpt-5.5?reasoning.effort=low`. The backend adapter maps that to Bedrock OpenAI-compatible Chat Completions (`reasoning_effort`) — not raw OpenRouter syntax. Enable each model id in the Bedrock console for your deploy region before smoke-testing chat/embeddings.

Do not commit secrets; pass any local overrides via `-c` only when needed.

## Manual e2e

Deploy → smoke (`/health`) → destroy:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host e2e \
  -c orgSlug="acme" \
  -c size="small" \
  -c domainName="app.example.com" \
  -c hostedZoneId="Z0123456789ABCDEF"
```

Keep the stack for debugging:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host e2e:keep \
  -c orgSlug=... -c size=small -c domainName=... -c hostedZoneId=...
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
