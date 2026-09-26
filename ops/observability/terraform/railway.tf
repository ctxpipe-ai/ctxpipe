resource "railway_service" "clickhouse" {
  project_id   = local.railway_project_id
  name         = "clickhouse"
  source_image = var.clickhouse_image
  regions      = local.regions
  volume = {
    name       = "clickhouse-data"
    mount_path = "/var/lib/clickhouse"
  }

  lifecycle {
    prevent_destroy = true
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "clickhouse" {
  environment_id = local.railway_environment_id
  service_id     = railway_service.clickhouse.id

  # clickhouse-cold is Railway-owned (provider 0.6.1 has no bucket resource).
  # CLICKHOUSE_OTEL_PASSWORD and CLICKHOUSE_LANGFUSE_PASSWORD stay on Railway.
  variables = [
    {
      name  = "PORT"
      value = "8123"
    },
    {
      name  = "CLICKHOUSE_COLD_ENDPOINT"
      value = "$${{clickhouse-cold.ENDPOINT}}/$${{clickhouse-cold.BUCKET}}/clickhouse/"
    },
    {
      name  = "CLICKHOUSE_COLD_ACCESS_KEY_ID"
      value = "$${{clickhouse-cold.ACCESS_KEY_ID}}"
    },
    {
      name  = "CLICKHOUSE_COLD_SECRET_ACCESS_KEY"
      value = "$${{clickhouse-cold.SECRET_ACCESS_KEY}}"
    },
    {
      name  = "CLICKHOUSE_COLD_REGION"
      value = "$${{clickhouse-cold.REGION}}"
    },
  ]
}

resource "railway_service" "collector" {
  project_id   = local.railway_project_id
  name         = "collector"
  source_image = var.collector_image
  regions      = local.regions
  depends_on   = [railway_service.clickhouse]

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [regions]
  }
}

resource "railway_variable_collection" "collector" {
  environment_id = local.railway_environment_id
  service_id     = railway_service.collector.id

  variables = [
    {
      name  = "CLICKHOUSE_ENDPOINT"
      value = "http://$${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}:8123"
    },
    {
      name  = "CLICKHOUSE_USER"
      value = "otel"
    },
    {
      name  = "CLICKHOUSE_PASSWORD"
      value = "$${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}"
    },
    {
      name  = "HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE"
      value = "otel"
    },
    {
      name  = "PORT"
      value = "4318"
    },
  ]
}

resource "railway_custom_domain" "collector" {
  domain         = local.collector_domain
  environment_id = local.railway_environment_id
  service_id     = railway_service.collector.id
}

resource "railway_service_domain" "collector" {
  subdomain      = "collector-production-5b4c"
  environment_id = local.railway_environment_id
  service_id     = railway_service.collector.id
}

resource "railway_service" "mongo" {
  project_id   = local.railway_project_id
  name         = "mongo"
  source_image = "mongo:7"
  regions      = local.regions
  volume = {
    name       = "mongo-data"
    mount_path = "/data/db"
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [regions]
  }
}

resource "railway_service" "redis" {
  project_id   = local.railway_project_id
  name         = "redis"
  source_image = "redis:7-alpine"
  regions      = local.regions

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_service" "hyperdx" {
  project_id   = local.railway_project_id
  name         = "hyperdx"
  source_image = "hyperdx/hyperdx:2.39.1"
  regions      = local.regions
  depends_on   = [railway_service.clickhouse, railway_service.mongo]

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "hyperdx" {
  environment_id = local.railway_environment_id
  service_id     = railway_service.hyperdx.id

  variables = [
    {
      name  = "MONGO_URI"
      value = "mongodb://$${{mongo.RAILWAY_PRIVATE_DOMAIN}}:27017/hyperdx?maxIdleTimeMS=30000&minPoolSize=0&maxPoolSize=2&heartbeatFrequencyMS=1200000"
    },
    {
      name  = "CLICKHOUSE_HOST"
      value = "$${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}"
    },
    {
      name  = "CLICKHOUSE_PORT"
      value = "8123"
    },
    {
      name  = "CLICKHOUSE_USER"
      value = "otel"
    },
    {
      name  = "CLICKHOUSE_PASSWORD"
      value = "$${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}"
    },
    {
      name  = "CLICKHOUSE_DATABASE"
      value = "otel"
    },
    {
      name  = "HYPERDX_API_KEY"
      value = "$${{collector.HYPERDX_API_KEY}}"
    },
    {
      name  = "FRONTEND_URL"
      value = "https://${local.hyperdx_domain}"
    },
    {
      name  = "PORT"
      value = "8080"
    },
    {
      name  = "USAGE_STATS_ENABLED"
      value = "false"
    },
    {
      name  = "HDX_EXPORTER_ENABLED"
      value = "false"
    },
    {
      name  = "HDX_STARTUP_LOGS"
      value = "false"
    },
    {
      name  = "RUN_SCHEDULED_TASKS_EXTERNALLY"
      value = "true"
    },
    {
      name  = "NEXT_TELEMETRY_DISABLED"
      value = "1"
    },
    {
      name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
      value = local.observability_otlp_endpoint
    },
    {
      name  = "OTEL_TRACES_EXPORTER"
      value = "otlp"
    },
    {
      name  = "OTEL_LOGS_EXPORTER"
      value = "otlp"
    },
    {
      name  = "OTEL_METRICS_EXPORTER"
      value = "none"
    },
    {
      name  = "OTEL_SERVICE_NAME"
      value = "hyperdx"
    },
    {
      name  = "OTEL_RESOURCE_ATTRIBUTES"
      value = local.observability_resource_attributes
    },
    {
      name = "DEFAULT_CONNECTIONS"
      value = jsonencode([
        {
          name     = "ctxpipe ClickHouse"
          host     = "http://$${{clickhouse.RAILWAY_PRIVATE_DOMAIN}}:8123"
          username = "otel"
          password = "$${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}"
        }
      ])
    },
    {
      name  = "DEFAULT_SOURCES"
      value = jsonencode(jsondecode(file("${path.module}/../hyperdx/default-sources.json")))
    },
  ]
}

resource "railway_custom_domain" "hyperdx" {
  domain         = local.hyperdx_domain
  environment_id = local.railway_environment_id
  service_id     = railway_service.hyperdx.id
}

resource "railway_service_domain" "hyperdx" {
  subdomain      = "hyperdx-production-1172"
  environment_id = local.railway_environment_id
  service_id     = railway_service.hyperdx.id
}

resource "railway_service" "langfuse_web" {
  project_id   = local.railway_project_id
  name         = "langfuse-web"
  source_image = "langfuse/langfuse:3"
  regions      = local.regions
  depends_on   = [railway_service.clickhouse, railway_service.redis]

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [regions]
  }
}

resource "railway_variable_collection" "langfuse_web" {
  environment_id = local.railway_environment_id
  service_id     = railway_service.langfuse_web.id

  variables = concat(local.langfuse_shared_env, [
    {
      name  = "NEXTAUTH_URL"
      value = "https://${local.langfuse_domain}"
    },
    {
      name  = "AUTH_DISABLE_SIGNUP"
      value = "true"
    },
    {
      name  = "LANGFUSE_INIT_ORG_ID"
      value = local.langfuse_init_org_id
    },
    {
      name  = "LANGFUSE_INIT_ORG_NAME"
      value = local.langfuse_init_org_name
    },
    {
      name  = "LANGFUSE_INIT_PROJECT_ID"
      value = local.langfuse_init_project_id
    },
    {
      name  = "LANGFUSE_INIT_PROJECT_NAME"
      value = local.langfuse_init_project_name
    },
    {
      name  = "LANGFUSE_INIT_USER_NAME"
      value = local.langfuse_init_user_name
    },
    {
      name  = "PORT"
      value = "3000"
    },
    {
      name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
      value = local.observability_otlp_endpoint
    },
    {
      name  = "OTEL_EXPORTER_OTLP_HEADERS"
      value = local.observability_otlp_headers
    },
    {
      name  = "OTEL_SERVICE_NAME"
      value = "langfuse-web"
    },
    {
      name  = "OTEL_RESOURCE_ATTRIBUTES"
      value = local.observability_resource_attributes
    },
    {
      name  = "OTEL_METRICS_EXPORTER"
      value = "none"
    },
    {
      name  = "OTEL_LOGS_EXPORTER"
      value = "none"
    },
  ])
}

resource "railway_custom_domain" "langfuse_web" {
  domain         = local.langfuse_domain
  environment_id = local.railway_environment_id
  service_id     = railway_service.langfuse_web.id
}

resource "railway_service_domain" "langfuse_web" {
  subdomain      = "langfuse-web-production-f475"
  environment_id = local.railway_environment_id
  service_id     = railway_service.langfuse_web.id
}

resource "railway_service" "langfuse_worker" {
  project_id   = local.railway_project_id
  name         = "langfuse-worker"
  source_image = "langfuse/langfuse-worker:3"
  regions      = local.regions
  depends_on   = [railway_service.clickhouse, railway_service.redis]

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [regions]
  }
}

resource "railway_variable_collection" "langfuse_worker" {
  environment_id = local.railway_environment_id
  service_id     = railway_service.langfuse_worker.id

  variables = concat(local.langfuse_shared_env, [
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
    {
      name  = "PORT"
      value = "3030"
    },
    {
      name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
      value = local.observability_otlp_endpoint
    },
    {
      name  = "OTEL_EXPORTER_OTLP_HEADERS"
      value = local.observability_otlp_headers
    },
    {
      name  = "OTEL_SERVICE_NAME"
      value = "langfuse-worker"
    },
    {
      name  = "OTEL_RESOURCE_ATTRIBUTES"
      value = local.observability_resource_attributes
    },
    {
      name  = "OTEL_METRICS_EXPORTER"
      value = "none"
    },
    {
      name  = "OTEL_LOGS_EXPORTER"
      value = "none"
    },
    {
      name  = "LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS"
      value = "20000"
    },
    {
      name  = "LANGFUSE_QUEUE_METRICS_ENABLED"
      value = "false"
    },
    {
      name  = "LANGFUSE_MONITOR_SCHEDULER_ENABLED"
      value = "false"
    },
    {
      name  = "LANGFUSE_TRACE_DELETE_BATCH_ACTION_RUNNER_INTERVAL_MS"
      value = "120000"
    },
  ])
}

resource "railway_service" "railway_telemetry" {
  project_id   = local.railway_project_id
  name         = "railway-telemetry"
  source_image = var.railway_telemetry_image
  # Provider 0.6.1 Update sends cronSchedule without omitempty. An unset
  # attribute clears the live */5 schedule.
  cron_schedule = "*/5 * * * *"
  regions       = local.regions
  depends_on    = [railway_service.collector]

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "railway_telemetry" {
  environment_id = local.railway_environment_id
  service_id     = railway_service.railway_telemetry.id

  # RAILWAY_API_TOKEN stays on Railway.
  variables = [
    {
      name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
      value = local.observability_otlp_endpoint
    },
    {
      name  = "OTEL_EXPORTER_OTLP_HEADERS"
      value = local.observability_otlp_headers
    },
  ]
}
