# HyperDX dashboards

Repo-owned HyperDX sources are declared as `DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` on the hyperdx service in [`terraform/railway.tf`](../terraform/railway.tf). HyperDX applies those only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team.

`provision.ts` upserts every `dashboards/*.json` by dashboard name through the HyperDX external API (`POST /api/v2/dashboards/validate`, then `POST` or `PUT /api/v2/dashboards`). JSON files name sources (`sourceName`, `appliesToSourceNames`). The script resolves names to ids with `GET /api/v2/sources`.

Run it from the operator shell. These two variables are not Railway env:

```bash
HYPERDX_API_URL=http://hyperdx:8000 \
HYPERDX_ACCESS_KEY=... \
bun ops/observability/hyperdx/provision.ts
```

`HYPERDX_API_URL` is the API base (port 8000), not the UI. A second run updates the same dashboards.

The script also upserts the saved search **Request by id** on the Logs source (`GET/POST/PUT /api/v2/saved-searches`) when that API exists. The search lists log rows that have `LogAttributes['request.id']`, including `TraceId`, so the Logs → Traces source link opens the matching trace. The v2 saved-search API is one source per search, so it does not join the two tables in one query. To pin a single request, change the where clause to `LogAttributes['request.id'] = '<id>'`.

If `GET /api/v2/saved-searches` returns 404, the script leaves dashboards in place and prints `saved search API unsupported`. Create the search in Mongo `savedsearches` for the team (fields `name`, `source` = Logs source id, `select`, `where`, `whereLanguage: "sql"`, `orderBy`, `team`, `createdAt`, `updatedAt`) or add it in the HyperDX UI on the Logs source with that where clause.
