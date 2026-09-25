FROM clickhouse/clickstack-otel-collector:2.39.1

COPY config.yaml /etc/otelcol-contrib/custom.config.yaml

ENV CUSTOM_OTELCOL_CONFIG_FILE=/etc/otelcol-contrib/custom.config.yaml
