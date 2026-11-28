---
"@ctxpipe/aws-cdk": minor
---

feature: Docker Compose self-host gets a ClickHouse service for the knowledge content, with its data on the `clickhouse_data` volume. The migrate service makes the ClickHouse tables. Set `CLICKHOUSE_PASSWORD` in `.env` before the first start. No feature uses ClickHouse yet.
