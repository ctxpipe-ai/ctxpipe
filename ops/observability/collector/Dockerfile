FROM clickhouse/clickstack-otel-collector:2.39.1

COPY config.yaml /etc/otelcol-contrib/custom.config.yaml

ENV CUSTOM_OTELCOL_CONFIG_FILE=/etc/otelcol-contrib/custom.config.yaml
# 9360h = 390 days = 13 * 30 days. The seed templates this into
# toIntervalDay(390) for tables it creates. Do not set
# HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL: the migrate binary skips
# a multi-interval TTL (TO VOLUME plus DELETE) so it will not rewrite
# tiering/otel.sql.
ENV HYPERDX_OTEL_EXPORTER_TABLES_TTL=9360h
