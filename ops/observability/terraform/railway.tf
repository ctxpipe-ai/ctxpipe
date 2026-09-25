resource "railway_service" "clickhouse" {
  project_id         = var.railway_project_id
  name               = "clickhouse"
  source_repo        = var.github_repo
  source_repo_branch = var.github_repo_branch
  root_directory     = "ops/observability/clickhouse"
  config_path        = "ops/observability/clickhouse/railway.toml"
  regions            = local.regions
  volume = {
    name       = "clickhouse-data"
    mount_path = "/var/lib/clickhouse"
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [regions]
  }
}

resource "railway_variable_collection" "clickhouse" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.clickhouse.id

  variables = [
    {
      name  = "CLICKHOUSE_OTEL_PASSWORD"
      value = var.clickhouse_otel_password
    },
    {
      name  = "CLICKHOUSE_LANGFUSE_PASSWORD"
      value = var.clickhouse_langfuse_password
    },
    {
      name  = "PORT"
      value = "8123"
    },
  ]
}

resource "railway_service" "collector" {
  project_id         = var.railway_project_id
  name               = "collector"
  source_repo        = var.github_repo
  source_repo_branch = var.github_repo_branch
  root_directory     = "ops/observability/collector"
  config_path        = "ops/observability/collector/railway.toml"
  regions            = local.regions
  depends_on         = [railway_service.clickhouse]

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "collector" {
  environment_id = var.railway_environment_id
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
      value = var.clickhouse_otel_password
    },
    {
      name  = "HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE"
      value = "otel"
    },
    {
      name  = "CLICKHOUSE_DATABASE"
      value = "otel"
    },
    {
      name  = "HYPERDX_API_KEY"
      value = var.hyperdx_api_key
    },
    {
      name  = "LANGFUSE_OTLP_ENDPOINT"
      value = "http://$${{langfuse-web.RAILWAY_PRIVATE_DOMAIN}}:3000/api/public/otel"
    },
    {
      name  = "LANGFUSE_AUTH_STRING"
      value = var.langfuse_auth_string
    },
    {
      name  = "CUSTOM_OTELCOL_CONFIG_FILE"
      value = "/etc/otelcol-contrib/custom.config.yaml"
    },
    {
      name  = "PORT"
      value = "4318"
    },
  ]
}

resource "railway_custom_domain" "collector" {
  domain         = var.collector_custom_domain
  environment_id = var.railway_environment_id
  service_id     = railway_service.collector.id
}

resource "railway_service_domain" "collector" {
  subdomain      = "ctxpipe-telemetry"
  environment_id = var.railway_environment_id
  service_id     = railway_service.collector.id
}

resource "railway_service" "mongo" {
  project_id   = var.railway_project_id
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

resource "railway_variable_collection" "mongo" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.mongo.id

  variables = [
    {
      name  = "PORT"
      value = "27017"
    },
  ]
}

resource "railway_service" "redis" {
  project_id   = var.railway_project_id
  name         = "redis"
  source_image = "redis:7-alpine"
  regions      = local.regions

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "redis" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.redis.id

  variables = [
    {
      name  = "PORT"
      value = "6379"
    },
  ]
}

resource "railway_service" "hyperdx" {
  project_id   = var.railway_project_id
  name         = "hyperdx"
  source_image = "hyperdx/hyperdx:2"
  regions      = local.regions
  depends_on   = [railway_service.clickhouse, railway_service.mongo]

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "hyperdx" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.hyperdx.id

  variables = [
    {
      name  = "MONGO_URI"
      value = "mongodb://$${{mongo.RAILWAY_PRIVATE_DOMAIN}}:27017/hyperdx?maxIdleTimeMS=30000&minPoolSize=0&maxPoolSize=2"
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
      value = var.clickhouse_otel_password
    },
    {
      name  = "CLICKHOUSE_DATABASE"
      value = "otel"
    },
    {
      name  = "HYPERDX_API_KEY"
      value = var.hyperdx_api_key
    },
    {
      name  = "FRONTEND_URL"
      value = "https://${var.hyperdx_custom_domain}"
    },
    {
      name  = "PORT"
      value = "8080"
    },
    {
      name  = "OTEL_SDK_DISABLED"
      value = "true"
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
  ]
}

resource "railway_custom_domain" "hyperdx" {
  domain         = var.hyperdx_custom_domain
  environment_id = var.railway_environment_id
  service_id     = railway_service.hyperdx.id
}

resource "railway_service_domain" "hyperdx" {
  subdomain      = "ctxpipe-hyperdx"
  environment_id = var.railway_environment_id
  service_id     = railway_service.hyperdx.id
}

resource "railway_service" "langfuse_web" {
  project_id   = var.railway_project_id
  name         = "langfuse-web"
  source_image = "langfuse/langfuse:3"
  regions      = local.regions
  depends_on   = [railway_service.clickhouse, railway_service.redis]

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "langfuse_web" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.langfuse_web.id

  variables = concat(local.langfuse_shared_env, [
    {
      name  = "NEXTAUTH_URL"
      value = "https://${var.langfuse_custom_domain}"
    },
    {
      name  = "NEXTAUTH_SECRET"
      value = var.langfuse_nextauth_secret
    },
    {
      name  = "LANGFUSE_INIT_ORG_ID"
      value = var.langfuse_init_org_id
    },
    {
      name  = "LANGFUSE_INIT_ORG_NAME"
      value = "ctxpipe"
    },
    {
      name  = "LANGFUSE_INIT_PROJECT_ID"
      value = var.langfuse_init_project_id
    },
    {
      name  = "LANGFUSE_INIT_PROJECT_NAME"
      value = "ctxpipe"
    },
    {
      name  = "LANGFUSE_INIT_PROJECT_PUBLIC_KEY"
      value = var.langfuse_init_project_public_key
    },
    {
      name  = "LANGFUSE_INIT_PROJECT_SECRET_KEY"
      value = var.langfuse_init_project_secret_key
    },
    {
      name  = "LANGFUSE_INIT_USER_EMAIL"
      value = var.langfuse_init_user_email
    },
    {
      name  = "LANGFUSE_INIT_USER_NAME"
      value = var.langfuse_init_user_name
    },
    {
      name  = "LANGFUSE_INIT_USER_PASSWORD"
      value = var.langfuse_init_user_password
    },
    {
      name  = "PORT"
      value = "3000"
    },
  ])
}

resource "railway_custom_domain" "langfuse_web" {
  domain         = var.langfuse_custom_domain
  environment_id = var.railway_environment_id
  service_id     = railway_service.langfuse_web.id
}

resource "railway_service_domain" "langfuse_web" {
  subdomain      = "ctxpipe-langfuse"
  environment_id = var.railway_environment_id
  service_id     = railway_service.langfuse_web.id
}

resource "railway_service" "langfuse_worker" {
  project_id   = var.railway_project_id
  name         = "langfuse-worker"
  source_image = "langfuse/langfuse-worker:3"
  regions      = local.regions
  depends_on   = [railway_service.clickhouse, railway_service.redis]

  lifecycle {
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "langfuse_worker" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.langfuse_worker.id

  variables = concat(local.langfuse_shared_env, [
    {
      name  = "PORT"
      value = "3030"
    },
  ])
}
