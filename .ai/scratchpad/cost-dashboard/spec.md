# Cost dashboard

One HyperDX **Cost** dashboard plus hourly `cost-telemetry` gauges, so ctxpipe spend is visible next to the rest of ClickStack.

## Sources

Railway, Neon, OpenRouter, GitHub, Blacksmith, Cloudflare, and AWS sandbox account `007664619564` (`ctxpipe-sandbox`). Resend is free-tier and is not emitted.

AWS uses Cost Explorer `GetCostAndUsage` with a hardcoded `LINKED_ACCOUNT` filter so no other account can leak. Auth is `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (optional `AWS_SESSION_TOKEN`). No `AWS_ACCOUNT_ID`. Rows are `source=reported`, `sku` = usage type, `scope` = `account/service`. Credits stay. Cost Explorer is called once per day at 12:17 UTC.

## Reported vs estimated

- `reported`: the provider's billed dollars (OpenRouter, GitHub, Blacksmith, AWS). AWS figures stay estimates until the AWS bill finalizes.
- `estimated`: usage × list price in `cost-telemetry` `src/rates.ts` (Railway, Neon, Cloudflare R2). Expect about 10% vs invoices after free-tier maths.

There is no `fixed` source. Railway Pro's $20 is a minimum spend, not an extra fee.

## Recent-day corrections

Each run resends the last 3 UTC days because OpenRouter and GitHub finalise late, and a later run can lower a day's figure. Tiles keep one row per `(toDate(TimeUnix), provider, sku, scope)` with `argMax(Value, toUInt64OrZero(Attributes['billing.observed_at_unix_ms']))`. Taking `max(Value)` would keep a stale high figure.

## Preview acceptance

- Every Cost tile renders, including empty number tiles (NULL, not `$0.00`) when no cost rows exist.
- Last month's per-provider totals: reported providers within a few cents of the billing pages; estimated within about 10%.
- Top line items show usage plus a `unit` from the latest matching cost or usage observation; `unit` is blank if it changed across days in the range.
