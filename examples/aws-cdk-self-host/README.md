# `@ctxpipe/aws-cdk-self-host`

Manually-run end-to-end test for [`@ctxpipe/aws-cdk`](../../packages/aws-cdk). Deploys the high-level `CtxPipe` construct into a real AWS account, polls `/health`, then tears the stack back down.

This example is a private workspace package; it is **not** published.

## What it deploys

A single CloudFormation stack (default name `CtxpipeSelfHostE2E`) containing everything the `CtxPipe` construct provisions:

- VPC with public + private subnets and a NAT gateway
- ECS Fargate cluster running backend, worker, ui, codesearch
- Aurora PostgreSQL (writer)
- Neptune cluster
- EFS file system for codesearch `/data`
- Secrets Manager secrets for auth, database URL, model provider, SMTP, optional connectors
- SES identity + SMTP credentials (custom resource)
- Public ALB routing to the backend

See [packages/aws-cdk/README.md](../../packages/aws-cdk/README.md) for the full construct reference.

## Prerequisites

1. **AWS credentials** for a sandbox account with admin-equivalent permissions. The construct creates IAM users, secrets, RDS, Neptune, ECS, ALB, Route 53 records, and a Lambda-backed custom resource — operate in a throwaway account.
2. **Region**: pick a region that supports Neptune and SES (e.g. `us-east-1`). Export `AWS_REGION`/`AWS_DEFAULT_REGION` or rely on the default in your AWS profile.
3. **Tooling**: Node.js 20+, pnpm 10 (this repo's package manager), the AWS CLI configured for the same account.
4. **Install workspace deps** from the repo root:

   ```bash
   pnpm install
   pnpm --filter @ctxpipe/aws-cdk build
   ```

5. **Bootstrap CDK** once per account/region (no-op if already bootstrapped):

   ```bash
   pnpm --filter @ctxpipe/aws-cdk-self-host exec cdk bootstrap
   ```

## Required configuration

Pass values via CDK context (`-c key=value`) or by editing `cdk.json` locally (do not commit secrets).

| Context key         | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `orgSlug`           | Organization slug mapped to `GRAPH_DB_URI_<orgSlug>` in ECS tasks   |
| `authSecret`        | Better Auth secret, **must be at least 32 characters**               |
| `modelBaseUrl`      | OpenAI-compatible API base URL (e.g. `https://api.openai.com/v1`)    |
| `modelApiKey`       | API key for `modelBaseUrl`                                           |
| `modelDefaultModel` | Model id passed to backend/worker (e.g. `gpt-4.1-mini`)              |
| `domainName`        | Public FQDN served by ALB over HTTPS (example: `app.example.com`)     |
| `hostedZoneId`      | Route 53 public hosted zone ID used for ALB records + SES DKIM        |

Optional context keys:

| Context key                                                                                   | Meaning                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `stackName`                                                                                   | CloudFormation stack name. Defaults to `CtxpipeSelfHostE2E`.                  |
| `imagesDefaultTag`                                                                            | Override the image tag for all four services. Defaults to `latest`.          |
| `githubAppId`, `githubPrivateKey`, `githubWebhookSecret`, `githubClientId`, `githubClientSecret`, `atlassianClientId`, `atlassianClientSecret` | When provided, populate the optional connector secret.                       |

## Manual e2e

The simplest happy path (deploy → smoke → destroy):

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host e2e \
  -c orgSlug="acme" \
  -c authSecret="$(openssl rand -hex 32)" \
  -c domainName="app.example.com" \
  -c hostedZoneId="Z0123456789ABCDEF" \
  -c modelBaseUrl="https://api.openai.com/v1" \
  -c modelApiKey="$OPENAI_API_KEY" \
  -c modelDefaultModel="gpt-4.1-mini"
```

If you want to keep the stack around to poke at it, use:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host e2e:keep \
  -c orgSlug=... -c authSecret=... -c domainName=... -c hostedZoneId=... -c modelBaseUrl=... -c modelApiKey=... -c modelDefaultModel=...
```

…and tear it down later with:

```bash
pnpm --filter @ctxpipe/aws-cdk-self-host destroy
```

### Expected runtime

- `cdk deploy`: ~25–30 minutes on first run. Aurora, Neptune, and the SES SMTP custom resource dominate.
- `smoke`: polls `/health` every 15s for up to ~20 minutes after deploy completes (ECS warm-up + first-time DB migrations).
- `cdk destroy`: ~10–15 minutes.

### When `smoke` fails

1. Open the AWS console for the deploy region.
2. CloudWatch Logs → `ctxpipe-backend`, `ctxpipe-worker`, `ctxpipe-codesearch`, `ctxpipe-migrate` log groups.
3. ECS console → cluster → service events for any task that is failing health checks.
4. ALB target group → health status (looking for `/health` 5xx vs target draining).

## Cost note

While the stack is up: NAT gateway + Aurora writer + Neptune + ALB + Fargate ≈ **$3–5/hour** in `us-east-1`. Always destroy when finished.

## Cleanup caveats

The construct's removal policies are conservative:

- **Aurora** and **Neptune**: snapshots are retained on delete (`RemovalPolicy.SNAPSHOT`). Inspect and delete the snapshots manually if you don't need them.
- **EFS**: file system is retained on delete (`RemovalPolicy.RETAIN`). Delete it from the EFS console once the stack is gone if you don't want it.
- **SES identity**: domain identity stays attached to your account; remove it from the SES console if undesired.
- **Secrets Manager**: secrets enter the 7–30 day recovery window after `cdk destroy`. Force-delete from the console if you need to redeploy with the same secret name immediately.

## Notes on domain and sender address

`CtxPipe` now requires `customDomain`, so `AUTH_BASE_URL` is always `https://<domainName>`. SES is configured as a domain identity in the same hosted zone, and the runtime sender address is always `ctxpipe-noreply@<hosted-zone-apex>`.
