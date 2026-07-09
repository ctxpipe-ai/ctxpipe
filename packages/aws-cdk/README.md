# @ctxpipe/aws-cdk

TypeScript AWS CDK library for deploying ctxpipe self-host infrastructure with one high-level construct: `CtxPipe`.

## Quickstart

```ts
import * as cdk from "aws-cdk-lib";
import { CtxPipe } from "@ctxpipe/aws-cdk";

const app = new cdk.App();
const stack = new cdk.Stack(app, "CtxPipeStack");

new CtxPipe(stack, "CtxPipe", {
  orgSlug: "acme",
  size: "medium",
  customDomain: {
    domainName: "app.example.com",
    hostedZoneId: "Z0123456789ABCDEF",
  },
  modelProvider: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: cdk.SecretValue.unsafePlainText("replace-model-api-key"),
    models: { fast: "gpt-4.1-mini" },
  },
});
```

Deploy with your CDK app as usual (`cdk synth`, then `cdk deploy`).

### Bedrock (task-role IAM, native SDK)

When `modelProvider.kind` is `"bedrock"`, the construct wires `MODEL_PROVIDER=bedrock`, `MODEL_BEDROCK_AWS_REGION`, tier model IDs, and IAM on the backend/worker task roles (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`). No `MODEL_PROVIDER_API_KEY` secret is created — the backend calls Bedrock Runtime directly with SigV4 credentials from the ECS task role.

```ts
new CtxPipe(stack, "CtxPipe", {
  orgSlug: "acme",
  customDomain: { domainName: "app.example.com", hostedZoneId: "Z0123456789ABCDEF" },
  modelProvider: {
    kind: "bedrock",
    region: "us-east-1", // optional; defaults to stack region
    models: {
      fast: "anthropic.claude-sonnet-4-20250514-v1:0",
      medium: "anthropic.claude-sonnet-4-20250514-v1:0",
      high: "anthropic.claude-opus-4-20250514-v1:0",
      embedding: "cohere.embed-v4:0", // optional; this is the default when omitted
    },
  },
});
```

Before deploy, enable each model ID in the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/) for the target region (model access / one-time enablement). Use model IDs your account can invoke; mismatches fail at runtime, not at `cdk deploy`.

**Embeddings on Bedrock:** The backend only supports **Cohere** embed models on Bedrock (Cohere request/response format). Default when `models.embedding` is omitted: `cohere.embed-v4:0`. Other Bedrock embedding models (for example Titan) are not supported yet.

## Model provider

`modelProvider` is a discriminated union:


| `kind`                                      | Auth at runtime                                | Required fields                    |
| ------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| `openai-like` (default when `kind` omitted) | `MODEL_PROVIDER_API_KEY` in Secrets Manager    | `baseUrl`, `apiKey`, `models.fast` |
| `bedrock`                                   | ECS task role → native Bedrock Runtime (SigV4) | `models.fast`                      |




### Tier model IDs

Configure all tiers under `models` (same shape for openai-like and bedrock). Omitted tiers cascade: **medium** falls back to **fast**, **high** falls back to **medium**.


| CDK field          | Injected env var       | Role                                              |
| ------------------ | ---------------------- | ------------------------------------------------- |
| `models.fast`      | `MODEL_FAST_NAME`      | Fast tier (required)                              |
| `models.medium`    | `MODEL_MEDIUM_NAME`    | Medium tier                                       |
| `models.high`      | `MODEL_HIGH_NAME`      | High tier                                         |
| `models.embedding` | `MODEL_EMBEDDING_NAME` | Embeddings (bedrock default: `cohere.embed-v4:0`; Cohere models only) |

### Migrating from older `@ctxpipe/aws-cdk` versions

Breaking changes in the current major release:

| Removed | Replacement |
| ------- | ----------- |
| `modelProvider.defaultModel` | `modelProvider.models.fast` (required) |

Example:

```ts
// Before
modelProvider: {
  baseUrl: "https://api.openai.com/v1",
  apiKey: secret,
  defaultModel: "gpt-4.1-mini",
  embedding: { baseUrl: "https://...", apiKey: embedSecret },
}

// After
modelProvider: {
  baseUrl: "https://api.openai.com/v1",
  apiKey: secret,
  models: {
    fast: "gpt-4.1-mini",
    embedding: "text-embedding-3-large",
  },
}
```

### Bedrock console checklist

1. Deploy the stack in an AWS region where Bedrock and your chosen models are available.
2. In **Amazon Bedrock → Model access** (or **Foundation models**), enable each model ID you pass in `models.`* for that region.
3. Confirm the stack region matches `modelProvider.region` when set (otherwise the construct uses the stack region).
4. No `modelProvider` Secrets Manager secret is provisioned for bedrock; `modelProviderSecret` / `modelProviderSecretArn` outputs are omitted.

## Required props

- `modelProvider`: model endpoint configuration — OpenAI-compatible HTTP (`openai-like`, default) or Amazon Bedrock via native SDK (`kind: "bedrock"`). See [Model provider](#model-provider) above.
- `orgSlug`: organization slug used by the deployed instance. Neptune is single-graph per cluster, so this construct configures one org per stack.
- `customDomain`: provide `domainName` and `hostedZoneId` to set the public URL to `https://<domainName>` and add:
  - ACM certificate for the domain (DNS validated in the provided hosted zone),
  - Route53 DNS validation records required by ACM,
  - Route53 ALB alias records,
  - HTTPS listener on ALB,
  - HTTP -> HTTPS redirect.
  The same hosted zone ID is also used for SES domain identity and DKIM records.



## Optional props

- `connectorSecrets`: deployment-wide connector secrets (GitHub/Atlassian). Omit for first boot if connectors are not configured yet.
- `size`: deployment capacity profile (`small`, `medium`, `large`). Defaults to `small` when omitted.



## Sizing profiles

`CtxPipe` is single-tenant by design and ships with three capacity presets:


| Size              | ECS task sizes (cpu/memory MiB)                                                                     | ECS desired count                               | Aurora writer   | Neptune instance | Backup retention |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- | ---------------- | ---------------- |
| `small` (default) | backend `256/512`, worker `512/1024`, ui `256/512`, codesearch `512/1024`, migrate `256/512`        | backend `1`, worker `1`, ui `1`, codesearch `1` | `db.t4g.medium` | `db.t4g.medium`  | 7 days           |
| `medium`          | backend `512/1024`, worker `1024/2048`, ui `256/512`, codesearch `1024/2048`, migrate `512/1024`    | backend `1`, worker `1`, ui `1`, codesearch `1` | `db.t4g.large`  | `db.r6g.large`   | 7 days           |
| `large`           | backend `1024/2048`, worker `2048/4096`, ui `512/1024`, codesearch `2048/4096`, migrate `1024/2048` | backend `2`, worker `2`, ui `1`, codesearch `1` | `db.r6g.xlarge` | `db.r6g.xlarge`  | 14 days          |


Sizing guidance:

- Use `small` for pilots and cost-sensitive setups with moderate ingestion churn. Both Aurora and Neptune use burstable `db.t4g.medium` — the smallest AWS-supported combination for Aurora PostgreSQL 16.x and Neptune in most regions (dev/test oriented; not intended for production graph performance testing).
- Use `medium` when ingestion/reindex bursts are frequent and you want more headroom. Neptune moves to memory-optimized `db.r6g.large`.
- Use `large` for high-ingestion repositories with stricter latency requirements. Aurora and Neptune both use `db.r6g.xlarge`.
- Scale worker first when queue pressure grows; codesearch replicas stay conservative.

Networking note:

- All size presets keep private ECS services with NAT egress. Outbound integrations (model providers, GitHub, Atlassian) require internet access from private subnets.



## What `CtxPipe` provisions

- VPC with public + private subnets and NAT egress.
- ECS cluster and Fargate services for backend, worker, ui, and codesearch.
  - Service deployments use ECS deployment circuit breaker with automatic rollback.
- Deploy-time database migration as a one-off ECS Fargate task triggered by a CloudFormation custom resource before service deployment.
- Aurora PostgreSQL (private), Neptune cluster + instance (private), EFS (codesearch `/data`).
- Secrets Manager secrets for database URL, model provider API key (openai-like only), and optional connectors.
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
- `AUTH_SECRET` generated in Secrets Manager and injected into backend/worker/codesearch/migrate tasks
- `DATABASE_URL` secret injected into backend/worker/codesearch tasks
- `SMTP_CONNECTION_URL` and `EMAIL_FROM_ADDRESS` injected into backend from SES SMTP credentials
  - `EMAIL_FROM_ADDRESS` is always `ctxpipe-noreply@<hosted-zone-apex>`



## Deploy-time migrations

`CtxPipe` runs Postgres migrations automatically during `cdk deploy` by executing an internal one-off ECS task before the long-running ECS services are deployed or updated.

- This migration step is part of the construct internals; consumers do not need to run `ecs run-task` manually.
- A failed migration fails the CloudFormation deployment, preventing partially-updated services.
- The migration custom-resource flow is bounded by Lambda/CloudFormation timing limits (up to 15 minutes per deployment operation). If your migrations can exceed that window, run heavy schema/data backfills outside this deploy-time hook (for example with a separate migration workflow).



## Image-tag coupling note

`@ctxpipe/aws-cdk` always uses one internal default GHCR tag for backend/worker/ui/codesearch/migrate task definitions. That tag is release-managed and stamped during CI to the same commit SHA used to publish `ghcr.io/ctxpipe-ai/*:<sha>` images on `main`.

This keeps the package and service images aligned by default with no extra config in `CtxPipeProps`.

## Environment checklist



### Customer-supplied (required)

- `AUTH_BASE_URL` (derived from `customDomain.domainName`)
- Model provider settings from `modelProvider`:
  - **openai-like**: `MODEL_PROVIDER_URL`, `MODEL_PROVIDER_API_KEY`, and tier names (`MODEL_FAST_NAME`, etc.)
  - **bedrock**: `MODEL_PROVIDER=bedrock`, tier names, and `MODEL_BEDROCK_AWS_REGION` — no `MODEL_PROVIDER_URL` or `MODEL_PROVIDER_API_KEY`



### CDK-generated defaults

- `AUTH_SECRET` (Secrets Manager generated value)
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

