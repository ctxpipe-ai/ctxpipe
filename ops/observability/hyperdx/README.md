# HyperDX dashboards

Repo-owned HyperDX sources are declared as `DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` on the hyperdx service in [`terraform/railway.tf`](../terraform/railway.tf). HyperDX applies those only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team. The Sessions source reads `otel.hyperdx_sessions`. That table stays empty while browser replay is off (`disableReplay: true`), so session charts have no rows.

`provision.ts` upserts every `dashboards/*.json` by dashboard name through the HyperDX external API (`POST /api/v2/dashboards/validate`, then `POST` or `PUT /api/v2/dashboards`). JSON files name sources (`sourceName`, `appliesToSourceNames`) and, on raw SQL tiles, the ClickHouse connection (`connectionName`). The script resolves names to ids with `GET /api/v2/sources` and `GET /api/v2/connections`. Dashboards that exist in HyperDX but are not in `dashboards/` are left in place.

Run it from the operator shell. These two variables are not Railway env. The public app proxies `/api` to the API server, so the base URL includes that prefix and the script appends `/api/v2/...`:

```bash
HYPERDX_API_URL=https://hyperdx.ctxpipe.ai/api \
HYPERDX_ACCESS_KEY=... \
bun ops/observability/hyperdx/provision.ts
```

Without a key, `GET https://hyperdx.ctxpipe.ai/api/api/v2/sources` returns 401. `GET https://hyperdx.ctxpipe.ai/api/v2/sources` is 404 (the proxy strips one `/api` and the API has no `/v2/sources`). A second run updates the same dashboards.

The script also upserts saved searches (`GET/POST/PUT /api/v2/saved-searches`):

- **Request by id** on Logs, `LogAttributes['request.id'] != ''`, selecting `TraceId`.
- **Request by id (traces)** on Traces, `SpanAttributes['request.id'] != ''`.
- **Production logs**, **Production traces**, and **Production errors** (logs, `SeverityText IN ('error')`). Each `where` is `ResourceAttributes['deployment.environment'] IN ('production')`, and `filters` is that predicate in the sidebar form HyperDX renders (`<column> IN (...)`).

Each search is one source. To pin a single request, set the where clause to `LogAttributes['request.id'] = '<id>'` or `SpanAttributes['request.id'] = '<id>'`.

## Environment filter

HyperDX `2.39.1` (image `hyperdx/hyperdx:2`, `/health` `version`) has no team or source setting that defaults the search page `where` to `production`.

What it does support, from that tag (`@hyperdx/api@2.39.1`, commit `6db385cdeeddd91c947940b855fd0d4810737fe9`):

| Mechanism | Where | Effect |
| --- | --- | --- |
| Team Shared Filters | `PUT /pinned-filters`, model `packages/api/src/models/pinnedFilter.ts` | One document per team and source (`fields`, `filters`). The search sidebar renders those fields in a Shared Filters section (`DBSearchPageFilters.tsx`). A value in `filters` is always listed, and it is the only option when the facet query returns nothing for that field. An empty `filters` object lists the values the facet query returns. |
| Personal pins | browser `localStorage` keys `hdx-pinned-fields` and `hdx-pinned-search-filters` (`packages/app/src/searchFilters.tsx`) | Per browser. The server cannot set them. |
| Dashboard `savedFilterValues` | external API, `SqlSavedFilterValue` `{ type: "sql", condition }` | Restored when the dashboard loads. The condition must be the same expression as the filter, in `IN (...)` form, so the chip and the tile `WHERE` match. |
| Saved search `where` + `filters` | `/api/v2/saved-searches` | Opening that search applies `where`. `filters` must be a renderable SQL facet or the API rejects them (`isRenderablePinnedFilter`). |
| `tableFilterExpression` | log and trace source schemas | Deprecated. AND'd into every query. Not set: it would force `production` onto the observability dashboards. |
| Highlighted attributes | `highlightedRowAttributeExpressions` / `highlightedTraceAttributeExpressions` | Row side panel and trace view, not the filter sidebar. |
| Materialized column | `schema/deployment-environment.sql` | Column `DeploymentEnvironment` (`LowCardinality`). The search sidebar pins this name. A map `IN` is compiled to `has(ResourceAttributeItems, …)` (text index) before the materialized-column rewrite. The dotted `__hdx_materialized_…environment` name collides with the seed column on `otel_logs`. |

`DEFAULT_SOURCES` on the hyperdx service is applied only when a team has no sources. Logs and traces there include the highlighted attribute. An existing team is unchanged by editing that variable.

`provision.ts` PUTS the Traces source so the trace and row panels show `deployment.environment`. It does not PUT Logs: the external log schema omits `sessionSourceId`, and PUT replaces the document. The existing Logs document keeps `sessionSourceId` and gets the same highlight by a field update, matching `DEFAULT_SOURCES`.

The script also tries `PUT /pinned-filters` so `DeploymentEnvironment` is a team Shared Filter on every source. The payload is the field only (`fields: ["DeploymentEnvironment"]`, `filters: {}`). No value is pinned. HyperDX 2.39.1 builds facet values in `useFetchFacets` → `getAllKeyValues`. Native columns that the metadata rollup selects (`otel_traces_kv_rollup_15m`: `ServiceName`, `SpanName`, `SpanKind`, `StatusCode`, `ScopeName`, `ScopeVersion`) are read from that view. `DeploymentEnvironment` is not in the view, so a session that already cached `DESCRIBE` before the column existed never adds it to the raw sample either. The Shared Filters section still renders the pinned field, and with `filters.DeploymentEnvironment = ["production"]` that literal is the only checkbox — including on ranges whose rows are `pr-N` and `observability`. With `filters` empty, the field stays in Shared Filters and the checkboxes are the values present in the time range (a fresh page load, so `DESCRIBE` includes the `LowCardinality` column). The personal access key is not accepted on that route (session cookie only). A 401 is logged and the rest of the script continues. Those four documents (Logs, Traces, Metrics, Sessions) are stored in Mongo `pinnedfilters`.

Dashboard defaults (`savedFilterValues`):

| Dashboard | Default |
| --- | --- |
| ctxpipe Services | `production` |
| LLM (gen_ai) | `production` |
| Observability Stack | `observability` |
| Railway Infrastructure | none (the filter is there; all environments load, including `production`) |
| Product usage | `production` (required; the expression is the `DeploymentEnvironment` column) |

## Product usage

`dashboards/product-usage.json` is raw SQL on the Traces source (`configType: "sql"`). HyperDX 2.39.1 builder charts cannot express a trailing-window distinct count, so DAU/WAU/MAU and stickiness are SQL tiles. The external API persists `connectionId` and `sqlTemplate`; `provision.ts` maps `connectionName` via `GET /api/v2/connections`.

Definitions, also on the dashboard markdown tile:

- **DAU / WAU / MAU** are one line chart. DAU is `uniqExact(enduser.id)` per UTC day on backend server spans. WAU and MAU merge those daily `uniqExact` states over the 7 and 30 calendar days ending that day (`uniqExactMerge` … `ROWS BETWEEN 6 PRECEDING` and `29 PRECEDING`). Webhook and job actors are excluded. Browser `ui` spans are not included: the UI calls the API, and `uniqExact` would not double-count a person who appeared on both. An org API key has no `enduser.id`, so it is not a product user. Number tiles repeat the three values for the last day of the dashboard range.
- **MCP DAU / WAU / MAU** use the same windows on backend server spans named `POST /mcp` or carrying `ctxpipe.mcp.tool`, for actors `user`, `oauth_client`, and `org_api_key`. Identity is `enduser.id` when set, otherwise `ctxpipe.api_key.id`. An org API key is its own MCP actor. A person who has both ids is counted once.
- **Stickiness** counts actors by how many distinct UTC days they were active in the 7 days, and in the 30 days, ending on the last day of the range. Product and MCP each have both windows. Raw SQL bars are sorted by height in the browser (`useCategoricalChart` only keeps SQL `ORDER BY` for builder charts), so the axis is not locked at 1 on the left. Labels are `01 day` … `30 days`.

The environment filter is required (`minSelections: 1`) and defaults to `DeploymentEnvironment IN ('production')`. Tiles apply it with `$__filters`. That column is the materialized `deployment.environment`; a map `IN` would miss it. Time bounds use `$__fromTime` / `$__toTime` / `$__toTime_ms`. The line charts set `fillNulls: false` so a finer dashboard granularity does not draw zeros between the daily points. The calendar is capped at 421 days (`numbers(421)`), which covers retention plus the 30-day lookback. The line-chart external schema does not store `granularity`; the day bucket is in the SQL.
