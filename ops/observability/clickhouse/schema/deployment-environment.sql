-- DeploymentEnvironment is ResourceAttributes['deployment.environment'].
-- ClickStack 2.39.1 seeds __hdx_materialized_deployment.environment.name on
-- otel_logs only. A column named with that dotted prefix is rejected there
-- (ClickHouse nested-column prefix). HyperDX rewrites a query to this column
-- when system.columns.default_expression matches the map expression.
--
-- Run as the otel user. ADD COLUMN IF NOT EXISTS is safe to repeat.
-- The collector migrate binary only runs CREATE TABLE IF NOT EXISTS (and
-- MODIFY TTL when HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL is true). It
-- does not drop this column. MATERIALIZED columns are computed on insert
-- and are not part of the collector's named INSERT list.
--
-- One-off, already applied 2026-09-25 — do not add it back:
--   ALTER TABLE <table> MATERIALIZE COLUMN DeploymentEnvironment;
-- Repeating MATERIALIZE COLUMN rewrites parts.

ALTER TABLE otel.otel_logs
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_traces
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_gauge
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_sum
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_histogram
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_summary
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_exponential_histogram
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.hyperdx_sessions
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));
