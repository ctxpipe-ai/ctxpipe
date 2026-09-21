FROM clickhouse/clickstack-otel-collector:latest

COPY config.yaml /etc/otelcol-contrib/custom.config.yaml

ENV CUSTOM_OTELCOL_CONFIG_FILE=/etc/otelcol-contrib/custom.config.yaml
