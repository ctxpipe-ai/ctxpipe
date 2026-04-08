FROM otel/opentelemetry-collector-contrib:0.109.0

COPY apps/otel-collector/config.yaml /etc/otelcol/config.yaml

CMD ["--config", "/etc/otelcol/config.yaml"]
