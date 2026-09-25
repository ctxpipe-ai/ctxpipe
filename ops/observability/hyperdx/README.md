# HyperDX dashboards

Repo-owned HyperDX sources are declared as `DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` on the hyperdx service in [`terraform/railway.tf`](../terraform/railway.tf). HyperDX applies those only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team.

`provision.ts` upserts every `dashboards/*.json` by dashboard name through the HyperDX external API (`POST /api/v2/dashboards/validate`, then `POST` or `PUT /api/v2/dashboards`). JSON files name sources (`sourceName`, `appliesToSourceNames`). The script resolves names to ids with `GET /api/v2/sources`. Dashboards that exist in HyperDX but are not in `dashboards/` are left in place.

Run it from the operator shell. These two variables are not Railway env. The public app proxies `/api` to the API server, so the base URL includes that prefix and the script appends `/api/v2/...`:

```bash
HYPERDX_API_URL=https://hyperdx.ctxpipe.ai/api \
HYPERDX_ACCESS_KEY=... \
bun ops/observability/hyperdx/provision.ts
```

Without a key, `GET https://hyperdx.ctxpipe.ai/api/api/v2/sources` returns 401. `GET https://hyperdx.ctxpipe.ai/api/v2/sources` is 404 (the proxy strips one `/api` and the API has no `/v2/sources`). A second run updates the same dashboards.

The script also upserts two saved searches (`GET/POST/PUT /api/v2/saved-searches`):

- **Request by id** on Logs, `LogAttributes['request.id'] != ''`, selecting `TraceId`.
- **Request by id (traces)** on Traces, `SpanAttributes['request.id'] != ''`.

Each search is one source. To pin a single request, set the where clause to `LogAttributes['request.id'] = '<id>'` or `SpanAttributes['request.id'] = '<id>'`.
