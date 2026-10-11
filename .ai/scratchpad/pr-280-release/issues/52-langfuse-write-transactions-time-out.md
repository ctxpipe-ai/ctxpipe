# Langfuse web: write transactions time out, so model prices cannot be saved

Status: ready-for-agent
Priority: P2
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 43 adds model prices in `ops/observability/langfuse/models.json` and the script `apply-models.sh`. On 2026-10-11 the script failed. Each `POST /api/public/models` answered 500 "An unknown error occurred", with the flat price fields and with `pricingTiers`. `GET /api/public/models` and `GET /api/public/health` answered 200.

## Evidence

The `langfuse-web` service in the `ctxpipe-observability` Railway project (environment `production`) logs, from about 05:09 UTC and repeated every few seconds:

```
error Transaction API error: Unable to start a transaction in the given time.
PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given time.
```

Prisma cannot open an interactive transaction on the Langfuse Postgres within its wait time. The likely causes are an exhausted connection pool (too low a `connection_limit`, or connections held by stuck requests), or a slow or overloaded Postgres. Reads that need no transaction still work.

## Acceptance criteria

- [ ] The cause is found from the Langfuse web and worker logs, the Postgres connection count, and the Langfuse `DATABASE_URL` pool settings (`connection_limit`, `pool_timeout`). Do not print secrets.
- [ ] The fix is in committed config under `ops/observability/` where possible, and is deployed by the team lead.
- [ ] `apply-models.sh` runs without errors, and Langfuse shows a cost on new generations (ticket 43).

## Comments

## Resolution
