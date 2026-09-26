variable "clickhouse_image" {
  description = "Public GHCR image for ClickHouse (ghcr.io/ctxpipe-ai/obs-clickhouse:<git tree of ops/observability/clickhouse>). Railway pulls it with no registry credentials, same as the product services."
  type        = string
}

variable "collector_image" {
  description = "Public GHCR image for the collector (ghcr.io/ctxpipe-ai/obs-collector:<git tree of ops/observability/collector>). Railway pulls it with no registry credentials, same as the product services."
  type        = string
}

variable "railway_telemetry_image" {
  description = "Public GHCR image for railway-telemetry (ghcr.io/ctxpipe-ai/obs-railway-telemetry:<git tree of ops/observability/railway-telemetry>). Railway pulls it with no registry credentials, same as the product services."
  type        = string
}
