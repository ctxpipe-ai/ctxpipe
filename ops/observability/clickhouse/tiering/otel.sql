-- Retention for ClickStack tables in database otel.
-- Run as a user with ALTER on database otel (the otel user).
-- Deploy config.d/ttl.xml first: materialize_ttl_recalculate_only=1
-- so this only rewrites ttl.txt and does not re-upload cold parts.
-- Add a statement for a new table and run that statement only.
--
-- Hot window: 3 days, then volume cold.
-- Delete: 390 days, the same horizon the collector seed writes
-- (HYPERDX_OTEL_EXPORTER_TABLES_TTL=9360h -> toIntervalDay(390)).

ALTER TABLE otel.hyperdx_sessions
    MODIFY TTL
        TimestampTime + INTERVAL 3 DAY TO VOLUME 'cold',
        TimestampTime + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_logs
    MODIFY TTL
        toDateTime(Timestamp) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(Timestamp) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_logs_kv_rollup_15m
    MODIFY TTL
        Timestamp + INTERVAL 3 DAY TO VOLUME 'cold',
        Timestamp + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_metrics_exponential_histogram
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_metrics_gauge
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_metrics_histogram
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_metrics_sum
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_metrics_summary
    MODIFY TTL
        toDateTime(TimeUnix) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDateTime(TimeUnix) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_traces
    MODIFY TTL
        toDate(Timestamp) + INTERVAL 3 DAY TO VOLUME 'cold',
        toDate(Timestamp) + INTERVAL 390 DAY DELETE;

ALTER TABLE otel.otel_traces_kv_rollup_15m
    MODIFY TTL
        Timestamp + INTERVAL 3 DAY TO VOLUME 'cold',
        Timestamp + INTERVAL 390 DAY DELETE;
