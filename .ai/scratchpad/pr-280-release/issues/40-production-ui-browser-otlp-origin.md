# Production UI browser spans: set the public origin on the UI service before pr-280 merges

Status: ready-for-agent
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 37 found that production has had no `ui` browser spans since 2026-10-07 23:31:47 UTC. The main branch relay still works. Production had no signed-in browser traffic in that window: from 2026-10-08 to 2026-10-11 there is no backend span with `ctxpipe.actor.type=user`, and no `POST /.otel/v1/:signal`. The last relay calls were on 2026-10-07 (12 calls, all 200). Thus the current gap comes from no traffic, not from a broken pipeline.

But pr-280 changes the relay. A merge will stop production browser spans.

- On main, `apps/ui/src/lib/otelBrowserProxy.ts` compares the `Origin` header with `X-Forwarded-Host`.
- On pr-280, the same file accepts only an origin from `AUTH_BASE_URL` or `AUTH_ALLOWED_ORIGINS` (`configuredPublicOrigins()`). Any other origin gets 403.
- `infra/module/ctxpipe/railway.tf` (`railway_variable_collection.ui_env`) sets the UI `AUTH_BASE_URL` to `http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:8080`. It does not set `AUTH_ALLOWED_ORIGINS` on the UI service.
- PR previews work because `.github/workflows/pr-deploy.yaml` (`upsert_preview_ui_bind_variables`) and `pr-preview-roll-existing.yaml` set the UI `AUTH_ALLOWED_ORIGINS` to the public preview origin. Terraform has no such step for production.

## Evidence

- HyperDX, `ServiceName='ui'`, `deployment.environment='production'`, 2026-10-04 to 2026-10-11: 235 spans, last span 2026-10-07T23:31:47Z.
- Same window on `pr-280`: 6,400+ `ui` spans; relay calls return 200 (for example `x-request-id` `e124f7af-b164-4309-a039-14ac5f768830` at 01:11:52 UTC on 2026-10-11).

## Expected vs actual

- Expected: after pr-280 merges and Terraform applies, `POST https://app.ctxpipe.ai/.otel/v1/traces` from the browser returns 200 and `ui` spans with `deployment.environment=production` arrive in HyperDX.
- Actual (predicted from code): the relay returns 403, because `https://app.ctxpipe.ai` is not in the UI service's configured origins.

## Scope

- Add `AUTH_ALLOWED_ORIGINS` to `ui_env` with the public app origin (`https://app.ctxpipe.ai`, and the backend Railway public domain if users can reach it).
- Add a unit test in `apps/ui` for the relay that proves a request from the configured public origin passes and the private `AUTH_BASE_URL` alone does not admit it.
- After the deploy, confirm production `ui` spans in HyperDX.

## Acceptance criteria

- [ ] `ui_env` in `infra/module/ctxpipe/railway.tf` names the public origin.
- [ ] A browser session on production makes `ui` spans in HyperDX under `production`.

## Comments

## Resolution
