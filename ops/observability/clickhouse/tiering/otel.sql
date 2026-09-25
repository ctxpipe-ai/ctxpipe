-- Idempotent retention for ClickStack tables in database otel.
-- Safe to re-run. Apply only after config.d/storage.xml is loaded
-- (storage policy default must contain volume cold).
--
-- Hot window: 3 days on the local volume, then volume cold.
-- Delete: 13 months. That replaces the collector's previous 30-day TTL
-- (toIntervalDay(30) on every table below). materialize_ttl_after_modify
-- stays at its default of 1, so the longer delete keeps existing parts.
--
-- Expressions match the column each table already uses for TTL.
-- A table created later by the collector gets exporters.clickhouse ttl
-- (390 days, delete only) until a statement is added here and re-applied.

ALTER TABLE otel.hyperdx_sessions
    MODIFY TTL
        TimestampTime + INTERVAL 3 DAY TO VOLUME 'cold',
        TimestampTime + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_logs
    MODIFY TTL
        toDateTime(Timestamp) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(Timestamp) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_logs_kv_rollup_15m
    MODIFY TTL
        Timestamp + INTERVAL 3 DAY TO VOLUME 'cold',
        Timestamp + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_metrics_exponential_histogram
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_metrics_gauge
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_metrics_histogram
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_metrics_sum
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_metrics_summary
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_traces
    MODIFY TTL
        toDate(Timestamp) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDate(Timestamp) + INTERVAL 13 MONTH DELETE;

ALTER TABLE otel.otel_traces_kv_rollup_15m
    MODIFY TTL
        Timestamp + INTERVAL 3 DAY TO VOLUME 'cold',
        Timestamp + INTERVAL 13 MONTH DELETE;
