-- Fast filter column for the resource attribute ctxpipe actually sets.
-- ClickStack 2.39.1 seeds `__hdx_materialized_deployment.environment.name`
-- on otel_logs only, from ResourceAttributes['deployment.environment.name'].
-- That column stays empty here. A second column whose name is the prefix
-- `__hdx_materialized_deployment.environment` is rejected on otel_logs:
-- ClickHouse treats the dot as a nested-column prefix of the seed column.
--
-- HyperDX rewrites a query expression to a MATERIALIZED column when
-- system.columns.default_expression matches it
-- (getMaterializedColumnsLookupTable in @hyperdx/common-utils 2.39.1).
-- The name of this column is DeploymentEnvironment. Its expression is
-- ResourceAttributes['deployment.environment'], which is what dashboards
-- and saved searches filter on.
--
-- Run as the otel user. ADD COLUMN IF NOT EXISTS is safe to repeat.
-- MATERIALIZE COLUMN backfills parts that existed before the add. Run it
-- once after the add. Repeating it rewrites parts.
--
-- The collector migrate binary only runs CREATE TABLE IF NOT EXISTS (and
-- MODIFY TTL when HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL is true). It
-- does not drop this column. MATERIALIZED columns are computed on insert
-- and are not part of the collector's named INSERT list.
--
-- The DROP statements remove an earlier dotted name that is not the seed
-- column. They no-op once that name is gone (IF EXISTS). otel_logs is not
-- in that list: dropping the prefix there can take the seed column with it.

ALTER TABLE otel.otel_logs
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_logs
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.otel_traces
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.otel_traces
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_traces
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.otel_metrics_gauge
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.otel_metrics_gauge
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_gauge
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.otel_metrics_sum
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.otel_metrics_sum
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_sum
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.otel_metrics_histogram
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.otel_metrics_histogram
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_histogram
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.otel_metrics_summary
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.otel_metrics_summary
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_summary
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.otel_metrics_exponential_histogram
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.otel_metrics_exponential_histogram
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.otel_metrics_exponential_histogram
    MATERIALIZE COLUMN DeploymentEnvironment;

ALTER TABLE otel.hyperdx_sessions
    DROP COLUMN IF EXISTS `__hdx_materialized_deployment.environment`;

ALTER TABLE otel.hyperdx_sessions
    ADD COLUMN IF NOT EXISTS DeploymentEnvironment LowCardinality(String)
        MATERIALIZED ResourceAttributes['deployment.environment'] CODEC(ZSTD(1));

ALTER TABLE otel.hyperdx_sessions
    MATERIALIZE COLUMN DeploymentEnvironment;
