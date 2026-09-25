locals {
  # Prisma holds sockets for the process lifetime unless the URL caps the pool.
  # connection_limit=1 + keepalives=0 + Neon idle_session_timeout lets web drop outbound.
  langfuse_database_url_limited = strcontains(var.langfuse_database_url, "connection_limit=") ? var.langfuse_database_url : (
    strcontains(var.langfuse_database_url, "?") ? "${var.langfuse_database_url}&connection_limit=1" : "${var.langfuse_database_url}?connection_limit=1"
  )
  langfuse_direct_url_limited = strcontains(var.langfuse_direct_url, "connection_limit=") ? var.langfuse_direct_url : (
    strcontains(var.langfuse_direct_url, "?") ? "${var.langfuse_direct_url}&connection_limit=1" : "${var.langfuse_direct_url}?connection_limit=1"
  )
  langfuse_database_url = strcontains(local.langfuse_database_url_limited, "keepalives=") ? local.langfuse_database_url_limited : (
    "${local.langfuse_database_url_limited}&keepalives=0"
  )
  langfuse_direct_url = strcontains(local.langfuse_direct_url_limited, "keepalives=") ? local.langfuse_direct_url_limited : (
    "${local.langfuse_direct_url_limited}&keepalives=0"
  )

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

  langfuse_shared_env = concat([
    {
      name  = "DATABASE_URL"
      value = local.langfuse_database_url
    },
    {
      name  = "DIRECT_URL"
      value = local.langfuse_direct_url
    },
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
      value = var.clickhouse_langfuse_password
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
      name  = "SALT"
      value = var.langfuse_salt
    },
    {
      name  = "ENCRYPTION_KEY"
      value = var.langfuse_encryption_key
    },
    {
      name  = "TELEMETRY_ENABLED"
      value = "false"
    },
  ], local.langfuse_s3_env)
}
