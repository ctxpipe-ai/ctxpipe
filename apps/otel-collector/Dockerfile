FROM ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.150.0

COPY apps/otel-collector/config.yaml /etc/otelcol/config.yaml

CMD ["--config", "/etc/otelcol/config.yaml"]
