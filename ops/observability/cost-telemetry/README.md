# cost-telemetry

An hourly job at :17 UTC: a scheduled ECS Fargate task (linux/arm64) of the observability stack in the production AWS account (factory `machines/observability`). One run reads the billing APIs of each provider and posts OTLP/JSON gauges to the collector. Each slot gets one attempt.

## Failures and the exit code

Each provider entry fails on its own: the other entries still send their rows, and each entry sends its result as a `billing.provider_status` point. The run exits 0 when its OTLP export succeeds, also when providers failed. It exits 1 only when the export fails or cannot start (no `OTEL_EXPORTER_OTLP_ENDPOINT`); then nothing arrives, and the no-data alert of the observability stack covers it. The log line of the run names each failed entry with its error class only (`failures=github-plan:http_403`), never a message or a response body.

## Window and dedupe

The shared window is the last 3 UTC days, today included. OpenRouter lags by one day (it serves only completed UTC days), so it covers today-3..today-1. Each run sends the full window again, because providers finalize late. A dashboard keeps the latest observation of each day, provider, sku and scope by `billing.observed_at_unix_ms` on each point (not `max(Value)`).

## Metrics

- `billing.cost` (USD) and `billing.usage` (unit `1`; the unit of the row is `billing.unit`): one point per row at 00:00 UTC of its day. Attributes: `billing.provider`, `billing.sku`, `billing.scope`, `billing.source`, `billing.unit`, `billing.observed_at_unix_ms`, and `billing.account` on AWS rows.
- `billing.fx_rate` (unit `1`, `billing.pair=USD/AUD`): one point on each run with a successful FX fetch from Frankfurter v2 (`https://api.frankfurter.dev/v2/rates`, `providers=ecb`). An alert of the observability stack expects it every hour.
- `billing.provider_status` (unit `1`): one point for each provider entry of the run, at the time of the run: 1 when the entry succeeded, 0 when it failed. Attributes: `billing.provider` (the entry: `openrouter`, `github`, `github-plan`, `blacksmith`, `cloudflare`, `aws`, `linear`, `fx`), `billing.observed_at_unix_ms` (the run time), and on a failure `billing.error`, a short class: `missing_env`, `http_<status>` (`http_401`, `http_403`, `http_429`, …), `http_5xx`, `timeout`, `parse` (an unexpected response), `graphql` (a GraphQL `errors` array), `cli` (the Blacksmith CLI failed), `no_plan` (the token cannot see the GitHub plan), `no_price` (no committed seat price), `currency` (a Cloudflare charge not in USD), `secret_read` (Secrets Manager could not read an input), or `error` (any other failure). AWS sends no status point outside its 12:17 UTC slot, because the run does not call it then.

## Sources

`billing.source` tells a dashboard where a cost figure comes from. Each sum of `billing.cost` over all rows is the spend (for AWS, the cost before credits); no row counts a charge that another row counts too, except on the AWS cutover days below.

- `reported`: the provider's own figure of what it bills (AWS Cost Explorer, the Cloudflare billing history, GitHub billing usage, OpenRouter, Blacksmith). Cost Explorer still revises the current month until the bill is final.
- `derived`: no cost API exists, so the figure is the plan's seats × the committed list price per seat per month in `src/rates.ts`, spread evenly over the days of the month (Linear, the GitHub plan). Each window day takes today's seat count. Update a price when its pricing page changes (each has a checked date and its URL).
- `estimated`: no longer sent. Older Cloudflare R2 rows have it: R2 usage × list prices, before the job read the Cloudflare billing history. A newer row of the same day, sku and scope replaces such a row.

Before this version, the job sent AWS rows of the management account only, with sku = usage type. No newer row replaces them, so on the days that both versions sent (the cutover window, and while the old job still runs) the AWS spend of that account counts twice. To see the cutover days correctly, keep only the AWS rows whose sku is a service name.

## Providers

| Provider | Rows | Source |
| --- | --- | --- |
| AWS | Cost Explorer of the management account (the payer view of all accounts), before credits. Two queries: records of type `Usage` grouped by `LINKED_ACCOUNT` and `SERVICE` (sku = service, scope = `<account id>/<service>`), and records of each other type except `Credit` (for example `Tax`, `Support`, `Refund`, `Fee`) grouped by `LINKED_ACCOUNT` and `RECORD_TYPE` (sku = record type, scope = `<account id>/<record type>`). `billing.account` = the account's name (`ACCOUNT_NAMES` in `src/providers/aws.ts`; an unknown account keeps its id). No usage: a service sums usage types of different units, so `billing.usage` is 0. | `reported` |
| Cloudflare | One row per item of type `charge` in the account billing history (sku = description, scope = billing item id, day = date of the charge). The API documents no other type, so a refund or a credit is not counted. R2 rows (`r2_storage`, `r2_class_a`, `r2_class_b` per bucket) are usage only, with cost 0: the R2 charge is in the billing history. | `reported` |
| GitHub | Billing usage of the organization: metered products, `netAmount` is the spend. The plan's paid seats (`GET /orgs/{org}`, `plan.seats`) × the seat price, sku `plan/<name>`. The plan rows are a separate entry (`github-plan`), so a token that cannot see the plan fails only them (`billing.error=no_plan`). | `reported`; plan `derived` |
| Linear | The workspace's paid subscription (`organization { subscription { type seats seatsMinimum seatsMaximum } }`): the billed seats × the seat price of the subscription type (yearly or monthly billing), sku = the type. A type without a price in `src/rates.ts` fails the provider. | `derived` |
| OpenRouter | Activity per model and provider. | `reported` |
| Blacksmith | The CLI's `daily` rows: Actions cost at organization scope. Its workflow and runner breakdowns cannot be joined to a day. | `reported` |

AWS Cost Explorer is billed at $0.01 for each paginated `GetCostAndUsage` request and updates at least daily, so the job calls it only in the 12:17 UTC slot. Other hours send no AWS rows (the last 12:17 payload stays in ClickHouse). A failed 12:17 slot tries again the next day. The client signs with the official SDK and sends over fetch with `maxAttempts: 1`, so a retry does not multiply the charge, and Bun and MSW see the HTTP call. Cost Explorer and STS are at `us-east-1`. `NetUnblendedCost` is the documented metric; `UnblendedCost` is the fallback. Two queries cost $0.02 a day, or more when a query has more than one page.

The AWS rows do not include credits (records of type `Credit`). A credit record cancels the usage that it pays, so with credits the sum of the rows was about $0 each day. Now the AWS rows show the cost of what the organization uses, and their sum is the bill before credits. A refund is a negative row. The AWS rows of the days before the first run of this change stay net of credits: no newer row replaces them. On the days that both versions sent, an older row of a service with no usage in the window (for example a support plan) stays next to the newer row of its record type. To see those days exactly, keep only the AWS rows of the last run of each day (the greatest `billing.observed_at_unix_ms` of the AWS rows of that day): each run sends all rows of its window.

## Environment

The task definition sets the first three as plain env. Each provider input (the rows after them) comes from its env var when it is set (local runs and tests). Else, in the ECS task (ECS sets `ECS_CONTAINER_METADATA_URI_V4`), the run reads the secret `cost-telemetry/<NAME>` (for example `cost-telemetry/LINEAR_API_KEY`) once with `GetSecretValue`: the task role, region `AWS_REGION`, else `us-west-2`. The task reads them itself because ECS cannot start a task while an injected secret is empty. A missing input (no env var, no secret, no `AWSCURRENT` value, or an empty value) fails only its provider with `billing.error=missing_env`; another read error fails it with `secret_read`. The log line names each input that the run could not read with its class only (`inputs=LINEAR_API_KEY:missing_env`), never a value.

| Variable | Use |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Required. The collector (`http://collector.observability.internal:4318` in the VPC). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional, `key=value` pairs. The in-VPC collector takes none; a collector behind Cloudflare Access takes its token headers here. |
| `OPENROUTER_MANAGEMENT_KEY` | OpenRouter management key (the activity endpoint returns 403 for a normal key). |
| `GITHUB_BILLING_TOKEN` | A fine-grained token with only organization Administration: Read (billing usage). GitHub shows the plan (`plan` of `GET /orgs/{org}`) only when the token's owner is an organization owner. Do not use a classic token with `admin:org`: it can also write to the organization. |
| `BLACKSMITH_TOKEN` | Blacksmith organization token. |
| `CLOUDFLARE_API_TOKEN` | Account Analytics: Read (R2) and Billing: Read (billing history). |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account id. |
| `LINEAR_API_KEY` | A Linear API key with read permission only; it must see the workspace's subscription. |

OpenRouter management keys and Blacksmith organization tokens also permit management actions. Neither provider has a read-only token for these APIs.

AWS has no keys: the SDK default credential chain gives the ECS task role. It reads the provider input secrets (`secretsmanager:GetSecretValue` on `cost-telemetry/*`) and assumes `arn:aws:iam::007664619564:role/ctxpipe-cost-explorer-read` (a read-only `ce:GetCostAndUsage` role in the management account; factory aws-core) through STS. The role is a constant in `src/providers/aws.ts`, not an env var: the factory policy pack forbids the ARN of another account in the task definition.

## Image

`deploy.yaml` builds the image (`Dockerfile`, linux/amd64 and linux/arm64) on each main build that changes this package, publishes `ghcr.io/ctxpipe-ai/cost-telemetry:<sha>`, and copies it by digest to `213102790567.dkr.ecr.us-west-2.amazonaws.com/ctxpipe/cost-telemetry:<sha>` (the copy keeps the digest). The digest of a build is in the `deploy-image` notice of its job Publish image (cost-telemetry), and in the summary of its job Copy images to the ECR. A main build that does not change this package reuses the digest of the build before it.

`bun.lock` pins every package that the image installs (`bun install --frozen-lockfile`); the workspace's `pnpm-lock.yaml` pins the packages of the tests. After a dependency change, run `bun install --lockfile-only` in this folder and commit both lockfiles.

## Tests

`pnpm --filter cost-telemetry test`. The tests fake each provider's HTTP API with MSW.
