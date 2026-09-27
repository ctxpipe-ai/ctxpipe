# HyperDX

`DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` apply only when a new team has no connections (sources only when it has none). Sessions (`otel.hyperdx_sessions`) stay empty while browser replay is off.

## Provision

The observability workflow runs `provision.ts` after every apply on `main`, with the `HYPERDX_ACCESS_KEY` secret of the `observability` GitHub Environment (a personal key from Team Settings → API Keys). To run it locally from the repo root:

```bash
HYPERDX_ACCESS_KEY=... bun ops/observability/hyperdx/provision.ts
```

Typecheck: `pnpm --filter hyperdx typecheck`.

The script upserts `dashboards/*.json` and `saved-searches/*.json` by name (`POST` or `PUT`). It resolves source and connection names to ids. Dashboards not in the repo are left in place. Saved searches: **Request by id**, **Request by id (traces)**, **Production logs**, **Production traces**, **Production errors**.

## Environment filter

HyperDX 2.39.1 does not default every search to `production`. The shared filter field is `ResourceAttributes['deployment.environment']`, with no value pinned. `provision.ts` does not write pinned filters. Dashboard chips use that map expression. Hand-written SQL filters `DeploymentEnvironment`.

| Mechanism | Effect |
| --- | --- |
| Shared Filters | Checkboxes are the values in the time range. Pinning only `production` hides `pr-N` and `observability`. |
| Personal pins | Browser `localStorage`. The server does not set them. |
| Dashboard `savedFilterValues` | Restored on load. Defaults below. |
| Highlighted attribute | Row and trace panels. `DEFAULT_SOURCES` highlights the attribute on a new team. |

| Dashboard | Default |
| --- | --- |
| ctxpipe Services, LLM (gen_ai), Product usage | `production` |
| Observability Stack | `observability` |
| Railway Infrastructure | none |

Product usage: [dashboards/product-usage.md](dashboards/product-usage.md).
