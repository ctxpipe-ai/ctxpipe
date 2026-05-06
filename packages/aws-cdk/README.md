# @ctxpipe/aws-cdk

TypeScript AWS CDK library for deploying ctxpipe self-host infrastructure with one high-level construct: `CtxPipe`.

## Quickstart

```ts
import * as cdk from "aws-cdk-lib";
import { CtxPipe } from "@ctxpipe/aws-cdk";

const app = new cdk.App();
const stack = new cdk.Stack(app, "CtxPipeStack");

new CtxPipe(stack, "CtxPipe", {
  auth: {
    authSecret: cdk.SecretValue.unsafePlainText("replace-with-32-char-secret"),
  },
  modelProvider: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: cdk.SecretValue.unsafePlainText("replace-model-api-key"),
    defaultModel: "gpt-4.1-mini",
  },
});
```

Deploy with your CDK app as usual (`cdk synth`, then `cdk deploy`).

## Required props

- `auth`: auth secret used by backend/worker (`AUTH_SECRET`).
- `modelProvider`: OpenAI-compatible model endpoint, key, and model ID.

## Optional props

- `customDomain`: provide `domainName`, `hostedZone`, `certificate` to set the public URL to `https://<domainName>` and add:
  - Route53 ALB alias records,
  - HTTPS listener on ALB,
  - optional HTTP -> HTTPS redirect (enabled by default).
  If omitted, runtime URLs default to the ALB DNS endpoint (`http://<alb-dns-name>`).
- `connectorSecrets`: deployment-wide connector secrets (GitHub/Atlassian). Omit for first boot if connectors are not configured yet.
- `email`: optional sender override (`fromAddress`). Defaults to `noreply@example.com`; this identity must be verified in SES before delivery.
- `images`: override image tags (or all tags via `defaultTag`).
- `infraDefaults`: minor defaults such as AZ count, NAT gateways, DB name, backup retention days.

## What `CtxPipe` provisions

- VPC with public + private subnets and NAT egress.
- ECS cluster and Fargate services for backend, worker, ui, and codesearch.
  - Service deployments use ECS deployment circuit breaker with automatic rollback.
- Aurora PostgreSQL (private), Neptune (private), EFS (codesearch `/data`).
- Secrets Manager secrets for database URL, model provider, and optional connectors.
- SES identity + SMTP credentials in Secrets Manager for backend email delivery.
- Public ALB routing to backend only (UI/codesearch remain internal-only).
- Outputs for app URL and key secret ARNs.
- Backup defaults enabled for Aurora, Neptune, and EFS.

Runtime defaults injected by the construct include:

- `GRAPH_DB_PROVIDER=neptune`
- `GRAPH_DB_URI` from Neptune endpoint
- `UI_PROXY_URL=http://ui.ctxpipe.local:3002`
- `CODESEARCH_URL=http://codesearch.ctxpipe.local:3001`
- `DATABASE_URL` secret injected into backend/worker/codesearch tasks
- `SMTP_CONNECTION_URL` and `EMAIL_FROM_ADDRESS` injected into backend from SES SMTP credentials

## Image-tag coupling note

By default, all service images use `:latest` unless overridden in `images`. For production, pin tags explicitly and keep them aligned with the same monorepo commit/release used for your `@ctxpipe/aws-cdk` version to avoid drift between construct expectations and runtime images.

## Environment checklist

### Customer-supplied (required)

- `AUTH_SECRET` (provided through `auth.authSecret`)
- `AUTH_BASE_URL` (derived from `customDomain.domainName` when set; otherwise ALB DNS URL)
- `MODEL_PROVIDER_URL`, `MODEL_PROVIDER_API_KEY`, and `MODEL_FAST_NAME` (provided through `modelProvider`)

### CDK-generated defaults

- `DATABASE_URL` (Secrets Manager + Aurora endpoint)
- `GRAPH_DB_PROVIDER=neptune`
- `GRAPH_DB_URI` (Neptune endpoint)
- `UI_PROXY_URL` and `CODESEARCH_URL` (internal service DNS)
- `SMTP_CONNECTION_URL` and `EMAIL_FROM_ADDRESS` (SES SMTP + Secrets Manager)

### Optional second deploy (connector onboarding)

- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`
