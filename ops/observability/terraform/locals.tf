locals {
  railway_project_id     = "305aa114-c6f3-4aca-b883-0faa9c331aa2"
  railway_environment_id = "5a0afd5c-5f12-47ef-8f8a-606107610f89"
  # Provider 0.6.1 ignores regions on update (issue #77). Pin with
  # RAILWAY_SERVICE_SET=observability scripts/railway-set-regions.sh.
  railway_region = "us-east4-eqdc4a"
  regions = [
    {
      num_replicas = 1
      region       = local.railway_region
    }
  ]

  collector_domain = "telemetry.ctxpipe.ai"
  hyperdx_domain   = "hyperdx.ctxpipe.ai"
  langfuse_domain  = "langfuse.ctxpipe.ai"

  langfuse_init_org_id       = "ctxpipe"
  langfuse_init_org_name     = "ctxpipe"
  langfuse_init_project_id   = "ctxpipe"
  langfuse_init_project_name = "ctxpipe"
  langfuse_init_user_name    = "ctxpipe"

  observability_otlp_endpoint       = "http://$${{collector.RAILWAY_PRIVATE_DOMAIN}}:4318"
  observability_otlp_headers        = "authorization=$${{collector.HYPERDX_API_KEY}}"
  observability_resource_attributes = "deployment.environment=observability,service.namespace=ctxpipe"

  # DATABASE_URL, DIRECT_URL, SALT, and ENCRYPTION_KEY stay on langfuse-web.
  # langfuse-events is Railway-owned (provider 0.6.1 has no bucket resource).
  langfuse_shared_env = [
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
}
