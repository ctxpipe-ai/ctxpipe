---
"@ctxpipe/aws-cdk": patch
---

Docker Compose: the `deploy` profile no longer publishes Postgres on host port 5433 (`CTXPIPE_POSTGRES_HOST_PORT`). If a backup job or a tool on the host used that port, run it through Compose, for example `docker compose exec postgres pg_dump -U ctxpipe ctxpipe > backup.sql`. The `infra` profile for local development still publishes the port.
