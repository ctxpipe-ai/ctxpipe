locals {
  # Ops-stack self-telemetry. The collector rejects OTLP without
  # `authorization: <HYPERDX_API_KEY>`. The key stays on the collector;
  # consumers reference it. Langfuse builds the trace URL in code
  # (`${endpoint}/v1/traces`) and the OTLP exporter reads headers from
  # the process environment, not the Langfuse env schema.
  observability_otlp_endpoint       = "http://$${{collector.RAILWAY_PRIVATE_DOMAIN}}:4318"
  observability_otlp_headers        = "authorization=$${{collector.HYPERDX_API_KEY}}"
  observability_resource_attributes = "deployment.environment=observability,service.namespace=ctxpipe"
  # langfuse-web honors this (TraceIdRatioBasedSampler, must be > 0).
  langfuse_web_trace_sampling_ratio = "1"
  # ClickhouseWriter opens a write-to-clickhouse span on every tick, even with
  # empty queues, inside one long-lived sampled trace, so samplers cannot thin
  # it. Default 1000ms is 60 spans/min idle; 20000ms is 3/min. Sub-batch ingestion
  # waits up to 20s; a full batch (1000 rows) still flushes immediately.
  langfuse_worker_clickhouse_write_interval_ms = "20000"

  regions = [
    {
      num_replicas = var.railway_regions[0].num_replicas
      region       = var.railway_regions[0].region
    }
  ]

  langfuse_s3_env = [
    {
      name  = "LANGFUSE_S3_EVENT_UPLOAD_BUCKET"
      value = "$${{langfuse-events.BUCKET}}"
    },
    {
      name  = "LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID"
      value = "$${{langfuse-events.ACCESS_KEY_ID}}"
    },
    {
      name  = "LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY"
      value = "$${{langfuse-events.SECRET_ACCESS_KEY}}"
    },
    {
      name  = "LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT"
      value = "$${{langfuse-events.ENDPOINT}}"
    },
    {
      name  = "LANGFUSE_S3_EVENT_UPLOAD_REGION"
      value = "$${{langfuse-events.REGION}}"
    },
    {
      name  = "LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE"
      value = "true"
    },
  ]

  # Non-secret wiring shared by langfuse-web and langfuse-worker.
  # DATABASE_URL, DIRECT_URL, SALT, and ENCRYPTION_KEY are Railway-owned on
  # langfuse-web (include connection_limit=1&keepalives=0 on the URLs).
  # The worker references those variables; this module does not copy them.
  langfuse_shared_env = concat([
    {
      name  = "CLICKHOUSE_URL"
      value = "http://$${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}:8123"
    },
    {
      name  = "CLICKHOUSE_USER"
      value = "langfuse"
    },
    {
      name  = "CLICKHOUSE_PASSWORD"
      value = "$${{clickhouse.CLICKHOUSE_LANGFUSE_PASSWORD}}"
    },
    {
      name  = "CLICKHOUSE_MIGRATION_URL"
      value = "clickhouse://$${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}:9000"
    },
    {
      name  = "CLICKHOUSE_CLUSTER_ENABLED"
      value = "false"
    },
    {
      name  = "CLICKHOUSE_DB"
      value = "langfuse"
    },
    {
      name  = "REDIS_CONNECTION_STRING"
      value = "redis://$${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379"
    },
    {
      name  = "REDIS_SOCKET_TIMEOUT_MS"
      value = "0"
    },
    {
      name  = "TELEMETRY_ENABLED"
      value = "false"
    },
  ], local.langfuse_s3_env)

  # Worker copies of secrets that live on langfuse-web.
  langfuse_worker_secret_refs = [
    {
      name  = "DATABASE_URL"
      value = "$${{langfuse-web.DATABASE_URL}}"
    },
    {
      name  = "DIRECT_URL"
      value = "$${{langfuse-web.DIRECT_URL}}"
    },
    {
      name  = "SALT"
      value = "$${{langfuse-web.SALT}}"
    },
    {
      name  = "ENCRYPTION_KEY"
      value = "$${{langfuse-web.ENCRYPTION_KEY}}"
    },
  ]
}
