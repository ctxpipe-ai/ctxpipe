# Cost

HyperDX dashboard **Cost** (`cost.json`). Days are UTC. Every tile is raw SQL on `otel.otel_metrics_gauge` (`ServiceName = 'cost-telemetry'`). Number tiles and charts that show money use USD except the ≈ AUD number tiles and the AUD columns on the tables.

## Metric contract

`cost-telemetry` writes one gauge point per UTC day and line item, with `TimeUnix` at 00:00 UTC of that day so date filters stay on the billing day. Each run also stamps every cost and usage point with the same `billing.observed_at_unix_ms` (`String(Date.now())`).

| Metric | Unit | Meaning |
| --- | --- | --- |
| `billing.cost` | USD | Dollars for that day and line item. Use the provider figure when it reports one; otherwise usage × the list price in `cost-telemetry` `src/rates.ts`. |
| `billing.usage` | `1` | Quantity for that day and line item. The real unit is `Attributes['billing.unit']` (tokens, bytes, minutes, …). One OTLP metric identity cannot carry several units. |
| `billing.fx_rate` | `1` | Latest USD→AUD rate from Frankfurter (ECB). Attribute `billing.pair=USD/AUD`. One point per successful FX fetch, stamped with the run time. |

Data-point attributes: `billing.provider` (`railway` \| `neon` \| `openrouter` \| `github` \| `blacksmith` \| `cloudflare` \| `aws`), `billing.sku`, `billing.scope`, `billing.source` (`reported` \| `estimated`), `billing.unit`, `billing.observed_at_unix_ms` (string milliseconds).

AWS is the ctxpipe-sandbox account (`007664619564`) only, via Cost Explorer `GetCostAndUsage` (`sku` = usage type, `scope` = `account/service`, `source=reported`). Figures stay estimates until the AWS bill finalizes. The collector only refreshes AWS at 12:17 UTC because each paginated Cost Explorer call costs $0.01.

Resource: `service.name=cost-telemetry`, `deployment.environment=observability`.

Resend is free-tier and is not emitted. Railway Pro's $20 is a minimum spend, not an extra fee, so there is no Railway `subscription` row. There is no `fixed` source: no producer emits a prorated plan fee.

## Dedupe

Each run resends the last 3 UTC days because OpenRouter and GitHub finalise late, and a later run can lower a day's figure (credits, refunds, a revised estimate). Tiles keep one row per `(toDate(TimeUnix), provider, sku, scope)` with `argMax(Value, toUInt64OrZero(Attributes['billing.observed_at_unix_ms']))`, then sum. That picks the latest observation, including a downward revision. Taking the larger `Value` would keep the stale high figure. Retention is the existing 390-day gauge TTL.

Number tiles that show money use `sumOrNull` after that dedupe so a window with no cost rows is NULL rather than `$0.00`. The USD→AUD rate tile uses `if(count() = 0, NULL, argMax(Value, TimeUnix))` for the same empty-state reason. HyperDX may still render a dash or blank for NULL; SQL does not coerce that to zero.

## Estimations

`billing.source=reported` is the provider's billed dollars. `estimated` is list price times usage and will not match invoices exactly — expect about 10% on Railway, Neon, and Cloudflare R2 after free-tier maths.

≈ AUD is `USD ×` the latest stored `billing.fx_rate`. That subquery ignores the dashboard time range, so the current rate applies to every day, including last month. If the FX fetch failed, the dashboard keeps the last stored rate. Labels say ≈ on purpose.

## Tiles

**Month to date**, **Projected month**, and **Last month** are anchored on `$__toTime`, not the selected range. Projected is MTD ÷ elapsed UTC days in that month × days in the month. The same three tiles repeat in ≈ AUD, plus **USD→AUD rate**.

**Daily cost by provider** is a USD stacked bar over the dashboard range (calendar days that overlap `$__fromTime`..`$__toTime`). **Monthly cost by provider** is the last 13 calendar months ending at `$__toTime`, whatever the range. Charts stay in USD only.

**By provider** is MTD and last month per provider (USD, ≈ AUD, Δ% = `(mtd − last) / last × 100`). **Top line items** is the top 50 `(provider, sku, scope)` in the dashboard range, with `source` and usage taken from the same latest observation via `argMax` on `billing.observed_at_unix_ms` (across days, `source` is `argMax(source, day)`). Usage is summed for invoice reconciliation. `unit` is `billing.unit` from the latest matching cost or usage observation; if that unit is not the same on every day in the range, the column is empty so a mixed-unit sum is not labelled. Plus cost USD and cost ≈ AUD.

## Filters

`billing.provider` and `billing.source` on Metrics (gauge). No default pin. Filter behavior: [hyperdx/README.md](../README.md#environment-filter).
