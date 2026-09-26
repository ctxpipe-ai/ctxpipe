# Product usage

HyperDX dashboard **Product usage** (`product-usage.json`). Days are UTC. Tiles are raw SQL on backend server spans (`ServiceName = 'backend'`, `SpanKind = 'Server'`). The UI calls that API, so a person who only uses the app is included. Browser `ui` spans are not queried.

## Identity

One id for web and MCP:

```sql
if(
  SpanAttributes['enduser.id'] != '',
  SpanAttributes['enduser.id'],
  if(
    SpanAttributes['ctxpipe.actor.type'] = 'org_api_key',
    SpanAttributes['ctxpipe.api_key.id'],
    ''
  )
)
```

A personal API key is actor `user` and sets `enduser.id` to that user (`apps/backend/src/auth/withAuth.ts`). It counts as the user, including when `ctxpipe.api_key.id` is also set. An org API key sets `ctxpipe.actor.type = org_api_key` and does not set `enduser.id` (`attributesForOrgApiKey`). That key id is the identity. OAuth with a user id counts as the user. Webhook and job actors are excluded, including a job that still carries the caller's `enduser.id`. Empty ids are excluded.

Someone who uses the app and MCP is one identity on every tile. MCP tiles use the same id and keep only `POST /mcp` server spans and server spans with `ctxpipe.mcp.tool`.

## Tiles

**DAU, WAU, and MAU** (number tiles and one line chart). DAU is distinct identities that UTC day. WAU is the 7 days ending that day. MAU is the 30 days ending that day. Each point is one day. The scan starts 30 days before the dashboard range so the first MAU point is a full window. The number tiles are those three values on the last day of the range. The line chart sets `fillNulls: false`. HyperDX does not store granularity on a raw SQL line tile; the day bucket is in the SQL. The calendar is `numbers(421)`.

**MCP DAU, WAU, and MAU** is the same series restricted to MCP spans.

**Stickiness** is one bar chart for web and MCP together. The x-axis is how many distinct UTC days an identity was active inside the dashboard range. The y-axis is how many identities had that count. `$__fromTime` and `$__toTime` size the buckets: N is the number of UTC dates in the range, and N is capped at 30. A longer range uses the 30 UTC days ending on the last day of the range, so bucket 30 still means 30 active days. HyperDX 2.39.1 sorts raw-SQL bars by height (`useCategoricalChart` keeps SQL `ORDER BY` only for builder charts). Labels are `01 day` … `30 days`.

## Environment

The dashboard filter is required and defaults to `ResourceAttributes['deployment.environment'] IN ('production')`, the same expression as the other dashboards and the team shared filter. Tiles apply it with `$__filters`. A map `IN` is compiled to the attribute text index before HyperDX can rewrite it to the `DeploymentEnvironment` column, so these tiles do not add a second predicate on that column. Ad-hoc SQL should filter `DeploymentEnvironment` directly.
