# HyperDX dashboards

Repo-owned HyperDX sources are declared as `DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` on the hyperdx service in [`terraform/railway.tf`](../terraform/railway.tf). HyperDX applies those only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team. The Sessions source reads `otel.hyperdx_sessions`. That table stays empty while browser replay is off (`disableReplay: true`), so session charts have no rows.

`provision.ts` upserts every `dashboards/*.json` by dashboard name through the HyperDX external API (`POST /api/v2/dashboards/validate`, then `POST` or `PUT /api/v2/dashboards`). JSON files name sources (`sourceName`, `appliesToSourceNames`). The script resolves names to ids with `GET /api/v2/sources`. Dashboards that exist in HyperDX but are not in `dashboards/` are left in place.

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
| Team Shared Filters | `PUT /pinned-filters`, model `packages/api/src/models/pinnedFilter.ts` | One document per team and source (`fields`, `filters`). The search sidebar renders those fields in a Shared Filters section (`DBSearchPageFilters.tsx`). Pinning a value sorts it first. It does not select it. |
| Personal pins | browser `localStorage` keys `hdx-pinned-fields` and `hdx-pinned-search-filters` (`packages/app/src/searchFilters.tsx`) | Per browser. The server cannot set them. |
| Dashboard `savedFilterValues` | external API, `SqlSavedFilterValue` `{ type: "sql", condition }` | Restored when the dashboard loads. The condition must be the same expression as the filter, in `IN (...)` form, so the chip and the tile `WHERE` match. |
| Saved search `where` + `filters` | `/api/v2/saved-searches` | Opening that search applies `where`. `filters` must be a renderable SQL facet or the API rejects them (`isRenderablePinnedFilter`). |
| `tableFilterExpression` | log and trace source schemas | Deprecated. AND'd into every query. Not set: it would force `production` onto the observability dashboards. |
| Highlighted attributes | `highlightedRowAttributeExpressions` / `highlightedTraceAttributeExpressions` | Row side panel and trace view, not the filter sidebar. |
| Materialized column | `schema/deployment-environment.sql` | Column `DeploymentEnvironment` (`LowCardinality`). The search sidebar pins this name. A map `IN` is compiled to `has(ResourceAttributeItems, …)` (text index) before the materialized-column rewrite. The dotted `__hdx_materialized_…environment` name collides with the seed column on `otel_logs`. |

`DEFAULT_SOURCES` on the hyperdx service is applied only when a team has no sources. Logs and traces there include the highlighted attribute. An existing team is unchanged by editing that variable.

`provision.ts` PUTS the Traces source so the trace and row panels show `deployment.environment`. It does not PUT Logs: the external log schema omits `sessionSourceId`, and PUT replaces the document. The existing Logs document keeps `sessionSourceId` and gets the same highlight by a field update, matching `DEFAULT_SOURCES`.

The script also tries `PUT /pinned-filters` so `DeploymentEnvironment` is a team Shared Filter, with `production` pinned to the top of that facet. The personal access key is not accepted on that route (session cookie only). A 401 is logged and the rest of the script continues. Those four documents (Logs, Traces, Metrics, Sessions) are stored in Mongo `pinnedfilters`.

Dashboard defaults (`savedFilterValues`):

| Dashboard | Default |
| --- | --- |
| ctxpipe Services | `production` |
| LLM (gen_ai) | `production` |
| Observability Stack | `observability` |
| Railway Infrastructure | none (the filter is there; all environments load, including `production`) |
