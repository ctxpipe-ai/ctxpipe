---
"@ctxpipe/aws-cdk": patch
---

improvement: Docker Compose self-host gives each service its own ClickHouse user. The migrate service keeps the admin user and makes `ctxpipe_reader` for the backend (read only) and `ctxpipe_writer` for the worker. Set `CLICKHOUSE_READER_PASSWORD` and `CLICKHOUSE_WRITER_PASSWORD` in `.env`, with values different from `CLICKHOUSE_PASSWORD`. They have no default: without them, the backend and the worker cannot connect to ClickHouse.
