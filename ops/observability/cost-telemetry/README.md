# cost-telemetry

An hourly job at :17 UTC: a scheduled ECS Fargate task (linux/arm64) of the observability stack in the production AWS account (factory `machines/observability`). One run reads the billing APIs of each provider and posts OTLP/JSON gauges to the collector. A failed run exits 1, and that slot gets one attempt.

## Window and dedupe

The shared window is the last 3 UTC days, today included. OpenRouter lags by one day (it serves only completed UTC days), so it covers today-3..today-1. Each run sends the full window again, because providers finalize late. A dashboard keeps the latest observation of each day, provider, sku and scope by `billing.observed_at_unix_ms` on each point (not `max(Value)`).

## Metrics

- `billing.cost` (USD) and `billing.usage` (unit `1`; the unit of the row is `billing.unit`): one point per row at 00:00 UTC of its day. Attributes: `billing.provider`, `billing.sku`, `billing.scope`, `billing.source`, `billing.unit`, `billing.observed_at_unix_ms`, and `billing.account` on AWS rows.
- `billing.fx_rate` (unit `1`, `billing.pair=USD/AUD`): one point on each run with a successful FX fetch from Frankfurter v2 (`https://api.frankfurter.dev/v2/rates`, `providers=ecb`). An alert of the observability stack expects it every hour.

## Sources

`billing.source` tells a dashboard where a cost figure comes from. Each sum of `billing.cost` over all rows is the spend; no row counts a charge that another row counts too.

- `reported`: the provider's own figure of what it bills (AWS Cost Explorer, the Cloudflare billing history, GitHub billing usage, OpenRouter, Blacksmith). Cost Explorer still revises the current month until the bill is final.
- `derived`: no cost API exists, so the figure is the plan's seats × the committed list price per seat per month in `src/rates.ts`, spread evenly over the days of the month (Linear, the GitHub plan). Each window day takes today's seat count. Update a price when its pricing page changes (each has a checked date and its URL).
- `estimated`: no longer sent. Older Cloudflare R2 rows have it: R2 usage × list prices, before the job read the Cloudflare billing history. A newer row of the same day, sku and scope replaces such a row.

## Providers

| Provider | Rows | Source |
| --- | --- | --- |
| AWS | Cost Explorer of the management account (the payer view of all accounts), grouped by `LINKED_ACCOUNT` and `SERVICE`. sku = service, scope = `<account id>/<service>`, `billing.account` = the account's name (`ACCOUNT_NAMES` in `src/providers/aws.ts`; an unknown account keeps its id). | `reported` |
| Cloudflare | One row per charge of the account billing history (sku = description, scope = billing item id, day = date of the charge). R2 rows (`r2_storage`, `r2_class_a`, `r2_class_b` per bucket) are usage only, with cost 0: the R2 charge is in the billing history. | `reported` |
| GitHub | Billing usage of the organization: metered products, `netAmount` is the spend. The plan's paid seats (`GET /orgs/{org}`, `plan.seats`) × the seat price, sku `plan/<name>`. The plan rows are a separate entry of the run, so a token that cannot see the plan fails only them. | `reported`; plan `derived` |
| Linear | The workspace's paid subscription (`organization { subscription { type seats seatsMinimum seatsMaximum } }`): the billed seats × the seat price of the subscription type. A type without a price in `src/rates.ts` fails the provider. | `derived` |
| OpenRouter | Activity per model and provider. | `reported` |
| Blacksmith | The CLI's `daily` rows: Actions cost at organization scope. Its workflow and runner breakdowns cannot be joined to a day. | `reported` |

AWS Cost Explorer is billed at $0.01 for each paginated `GetCostAndUsage` request and updates at least daily, so the job calls it only in the 12:17 UTC slot. Other hours send no AWS rows (the last 12:17 payload stays in ClickHouse). A failed 12:17 slot tries again the next day. The client signs with the official SDK and sends over fetch with `maxAttempts: 1`, so a retry does not multiply the charge, and Bun and MSW see the HTTP call. Cost Explorer and STS are at `us-east-1`. `NetUnblendedCost` is the documented metric; `UnblendedCost` is the fallback. Credits and other negative amounts stay in.

## Environment

The task definition sets these. A missing provider input fails only that provider.

| Variable | Use |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Required. The collector (`http://collector.observability.internal:4318` in the VPC). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional, `key=value` pairs. The in-VPC collector takes none; a collector behind Cloudflare Access takes its token headers here. |
| `OPENROUTER_MANAGEMENT_KEY` | OpenRouter management key (the activity endpoint returns 403 for a normal key). |
| `GITHUB_BILLING_TOKEN` | Organization Administration: Read for billing usage. The plan (`plan` of `GET /orgs/{org}`) shows only to a token of an organization owner. |
| `BLACKSMITH_TOKEN` | Blacksmith organization token. |
| `CLOUDFLARE_API_TOKEN` | Account Analytics: Read (R2) and Billing: Read (billing history). |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account id. |
| `LINEAR_API_KEY` | Linear API key; it must see the workspace's subscription. |

OpenRouter management keys and Blacksmith organization tokens also permit management actions. Neither provider has a read-only token for these APIs.

AWS has no keys: the SDK default credential chain gives the ECS task role, which assumes `arn:aws:iam::007664619564:role/ctxpipe-cost-explorer-read` (a read-only `ce:GetCostAndUsage` role in the management account; factory aws-core) through STS. The role is a constant in `src/providers/aws.ts`, not an env var: the factory policy pack forbids the ARN of another account in the task definition.

## Image

`deploy.yaml` builds the image (`Dockerfile`, linux/amd64 and linux/arm64) on each main build that changes this package, publishes `ghcr.io/ctxpipe-ai/cost-telemetry:<sha>`, and copies it by digest to `213102790567.dkr.ecr.us-west-2.amazonaws.com/ctxpipe/cost-telemetry:<sha>` (the copy keeps the digest). The digest of a build is in the `deploy-image` notice of its job Publish image (cost-telemetry), and in the summary of its job Copy images to the ECR. A main build that does not change this package reuses the digest of the build before it.

## Tests

`pnpm --filter cost-telemetry test`. The tests fake each provider's HTTP API with MSW.
