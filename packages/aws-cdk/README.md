# @ctxpipe/aws-cdk

TypeScript AWS CDK library for deploying ctxpipe self-host infrastructure with one high-level construct: `CtxPipe`.

## Quickstart

```ts
import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { CtxPipe } from "@ctxpipe/aws-cdk";

const app = new cdk.App();
const stack = new cdk.Stack(app, "CtxPipeStack");

new CtxPipe(stack, "CtxPipe", {
  orgSlug: "acme",
  customDomain: {
    domainName: "app.example.com",
    hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, "HostedZone", {
      hostedZoneId: "Z0123456789ABCDEF",
      zoneName: "example.com",
    }),
  },
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
- `orgSlug`: organization slug used by the deployed instance. Neptune is single-graph per cluster, so this construct configures one org per stack.
- `customDomain`: provide `domainName` and `hostedZone` to set the public URL to `https://<domainName>` and add:
  - ACM certificate for the domain (DNS validated in the provided hosted zone),
  - Route53 DNS validation records required by ACM,
  - Route53 ALB alias records,
  - HTTPS listener on ALB,
  - HTTP -> HTTPS redirect.
  The same hosted zone is also used for SES domain identity and DKIM records.

## Optional props

- `connectorSecrets`: deployment-wide connector secrets (GitHub/Atlassian). Omit for first boot if connectors are not configured yet.
- `images`: override image tags (or all tags via `defaultTag`).
- `infraDefaults`: minor defaults such as AZ count, NAT gateways, DB name, backup retention days.

## What `CtxPipe` provisions

- VPC with public + private subnets and NAT egress.
- ECS cluster and Fargate services for backend, worker, ui, and codesearch.
  - Service deployments use ECS deployment circuit breaker with automatic rollback.
- Deploy-time database migration as a one-off ECS Fargate task triggered by a CloudFormation custom resource before service deployment.
- Aurora PostgreSQL (private), Neptune cluster + instance (private), EFS (codesearch `/data`).
- Secrets Manager secrets for database URL, model provider, and optional connectors.
- SES domain identity + DKIM records + SMTP credentials in Secrets Manager for backend email delivery.
- Public ALB routing to backend only (UI/codesearch remain internal-only).
- Outputs for app URL and key secret ARNs.
- Backup defaults enabled for Aurora, Neptune, and EFS.

Runtime defaults injected by the construct include:

- `GRAPH_DB_PROVIDER=neptune`
- `GRAPH_DB_URI` from Neptune endpoint
- `GRAPH_DB_URI_<orgSlug>` from the same Neptune endpoint
- `UI_PROXY_URL=http://ui.ctxpipe.local:3002`
- `CODESEARCH_URL=http://codesearch.ctxpipe.local:3001`
- `DATABASE_URL` secret injected into backend/worker/codesearch tasks
- `SMTP_CONNECTION_URL` and `EMAIL_FROM_ADDRESS` injected into backend from SES SMTP credentials
  - `EMAIL_FROM_ADDRESS` is always `ctxpipe-noreply@<hosted-zone-apex>`

## Deploy-time migrations

`CtxPipe` runs Postgres migrations automatically during `cdk deploy` by executing an internal one-off ECS task before the long-running ECS services are deployed or updated.

- This migration step is part of the construct internals; consumers do not need to run `ecs run-task` manually.
- A failed migration fails the CloudFormation deployment, preventing partially-updated services.
- The migration custom-resource flow is bounded by Lambda/CloudFormation timing limits (up to 15 minutes per deployment operation). If your migrations can exceed that window, run heavy schema/data backfills outside this deploy-time hook (for example with a separate migration workflow).

## Image-tag coupling note

By default, all service images use `:latest` unless overridden in `images`. For production, pin tags explicitly and keep them aligned with the same monorepo commit/release used for your `@ctxpipe/aws-cdk` version to avoid drift between construct expectations and runtime images.

## Environment checklist

### Customer-supplied (required)

- `AUTH_SECRET` (provided through `auth.authSecret`)
- `AUTH_BASE_URL` (derived from `customDomain.domainName`)
- `MODEL_PROVIDER_URL`, `MODEL_PROVIDER_API_KEY`, and `MODEL_FAST_NAME` (provided through `modelProvider`)

### CDK-generated defaults

- `DATABASE_URL` (Secrets Manager + Aurora endpoint)
- `GRAPH_DB_PROVIDER=neptune`
- `GRAPH_DB_URI` (Neptune endpoint)
- `GRAPH_DB_URI_<orgSlug>` (Neptune endpoint for the configured org slug)
- `UI_PROXY_URL` and `CODESEARCH_URL` (internal service DNS)
- `SMTP_CONNECTION_URL` and `EMAIL_FROM_ADDRESS` (SES SMTP + Secrets Manager)

Because Neptune is single-graph per cluster, this construct does not support multi-tenant self-hosting in one stack. Deploy separate stacks for separate org slugs.

### Optional second deploy (connector onboarding)

- `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`
