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
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    # Desired region is us-east4-eqdc4a (ADR-029). Pin after apply with
    # RAILWAY_SERVICE_SET=observability scripts/railway-set-regions.sh.
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "clickhouse" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.clickhouse.id

  # CLICKHOUSE_OTEL_PASSWORD and CLICKHOUSE_LANGFUSE_PASSWORD stay on Railway.
  # The clickhouse-cold bucket is Railway-owned (provider 0.6.1 has no bucket
  # resource). These references resolve to that bucket's credentials.
  # ENDPOINT has no trailing slash (https://t3.storageapi.dev); the value
  # below is the path-style URL ClickHouse stores objects under.
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
      value = "$${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}"
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
      name  = "LANGFUSE_OTLP_ENDPOINT"
      value = "http://$${{langfuse-web.RAILWAY_PRIVATE_DOMAIN}}:3000/api/public/otel"
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
  subdomain      = "collector-production-5b4c"
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
      value = "https://${var.hyperdx_custom_domain}"
    },
    {
      name  = "PORT"
      value = "8080"
    },
    {
      name  = "USAGE_STATS_ENABLED"
      value = "false"
    },
    # Browser /api/config only. The Node SDK preload does not read this.
    # false keeps the ingest key out of the browser; the private collector
    # is not reachable from a user's browser.
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
    # @hyperdx/node-opentelemetry copies HYPERDX_API_KEY into
    # OTEL_EXPORTER_OTLP_HEADERS as Authorization=<key> before it builds
    # exporters. Setting the header here as well duplicates it. An unset
    # endpoint defaults to https://in-otel.hyperdx.io.
    # Metrics stay off: a PeriodicExportingMetricReader would export on a
    # timer and stop this service from sleeping. Batch span/log processors
    # export only when a queue is non-empty.
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
    # setupTeamDefaults applies these only when a team is created and that team
    # has no connections yet (sources only when it has none). An existing team
    # is left unchanged. This is not local-mode-only.
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
      name = "DEFAULT_SOURCES"
      value = jsonencode([
        {
          from = {
            databaseName = "otel"
            tableName    = "otel_logs"
          }
          kind                              = "log"
          timestampValueExpression          = "Timestamp"
          name                              = "Logs"
          displayedTimestampValueExpression = "Timestamp"
          implicitColumnExpression          = "Body"
          serviceNameExpression             = "ServiceName"
          bodyExpression                    = "Body"
          eventAttributesExpression         = "LogAttributes"
          resourceAttributesExpression      = "ResourceAttributes"
          defaultTableSelectExpression      = "Timestamp,ServiceName,SeverityText,Body"
          severityTextExpression            = "SeverityText"
          traceIdExpression                 = "TraceId"
          spanIdExpression                  = "SpanId"
          querySettings                     = []
          highlightedTraceAttributeExpressions = [
            {
              sqlExpression = "ResourceAttributes['deployment.environment']"
              alias         = "deployment.environment"
            }
          ]
          highlightedRowAttributeExpressions = [
            {
              sqlExpression = "ResourceAttributes['deployment.environment']"
              alias         = "deployment.environment"
            }
          ]
          materializedViews = []
          metadataMaterializedViews = {
            kvRollupTable = "otel_logs_kv_rollup_15m"
            granularity   = "15 minute"
          }
          connection      = "ctxpipe ClickHouse"
          traceSourceId   = "Traces"
          sessionSourceId = "Sessions"
          metricSourceId  = "Metrics"
        },
        {
          from = {
            databaseName = "otel"
            tableName    = "otel_traces"
          }
          kind                              = "trace"
          timestampValueExpression          = "Timestamp"
          name                              = "Traces"
          displayedTimestampValueExpression = "Timestamp"
          implicitColumnExpression          = "SpanName"
          serviceNameExpression             = "ServiceName"
          eventAttributesExpression         = "SpanAttributes"
          resourceAttributesExpression      = "ResourceAttributes"
          defaultTableSelectExpression      = "Timestamp,ServiceName,StatusCode,round(Duration/1e6),SpanName"
          traceIdExpression                 = "TraceId"
          spanIdExpression                  = "SpanId"
          durationExpression                = "Duration"
          durationPrecision                 = 9
          parentSpanIdExpression            = "ParentSpanId"
          spanNameExpression                = "SpanName"
          spanKindExpression                = "SpanKind"
          statusCodeExpression              = "StatusCode"
          statusMessageExpression           = "StatusMessage"
          spanEventsValueExpression         = "Events"
          spanLinksValueExpression          = "Links"
          querySettings                     = []
          highlightedTraceAttributeExpressions = [
            {
              sqlExpression = "ResourceAttributes['deployment.environment']"
              alias         = "deployment.environment"
            }
          ]
          highlightedRowAttributeExpressions = [
            {
              sqlExpression = "ResourceAttributes['deployment.environment']"
              alias         = "deployment.environment"
            }
          ]
          materializedViews = []
          metadataMaterializedViews = {
            kvRollupTable = "otel_traces_kv_rollup_15m"
            granularity   = "15 minute"
          }
          connection      = "ctxpipe ClickHouse"
          logSourceId     = "Logs"
          sessionSourceId = "Sessions"
          metricSourceId  = "Metrics"
        },
        {
          from = {
            databaseName = "otel"
            tableName    = ""
          }
          kind                         = "metric"
          timestampValueExpression     = "TimeUnix"
          name                         = "Metrics"
          resourceAttributesExpression = "ResourceAttributes"
          serviceNameExpression        = "ServiceName"
          querySettings                = []
          metricTables = {
            gauge                   = "otel_metrics_gauge"
            histogram               = "otel_metrics_histogram"
            sum                     = "otel_metrics_sum"
            summary                 = "otel_metrics_summary"
            "exponential histogram" = "otel_metrics_exponential_histogram"
          }
          connection      = "ctxpipe ClickHouse"
          logSourceId     = "Logs"
          traceSourceId   = "Traces"
          sessionSourceId = "Sessions"
        },
        {
          from = {
            databaseName = "otel"
            tableName    = "hyperdx_sessions"
          }
          kind                         = "session"
          timestampValueExpression     = "TimestampTime"
          name                         = "Sessions"
          resourceAttributesExpression = "ResourceAttributes"
          querySettings                = []
          connection                   = "ctxpipe ClickHouse"
          logSourceId                  = "Logs"
          traceSourceId                = "Traces"
          metricSourceId               = "Metrics"
        }
      ])
    },
  ]
}

resource "railway_custom_domain" "hyperdx" {
  domain         = var.hyperdx_custom_domain
  environment_id = var.railway_environment_id
  service_id     = railway_service.hyperdx.id
}

resource "railway_service_domain" "hyperdx" {
  subdomain      = "hyperdx-production-1172"
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
    # v3.225.11 has no invite-only mode. This blocks every new account
    # (signup API and SSO createUser), including an invited email that
    # has no user row yet. Existing users still sign in with email and
    # password. Inviting an existing user writes the membership directly.
    {
      name  = "AUTH_DISABLE_SIGNUP"
      value = "true"
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
      name  = "LANGFUSE_INIT_USER_NAME"
      value = var.langfuse_init_user_name
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
      name  = "OTEL_TRACE_SAMPLING_RATIO"
      value = local.langfuse_web_trace_sampling_ratio
    },
    # sdk-node 0.220 (langfuse 3.225.11) treats an unset metrics or logs
    # exporter as otlp. That starts a PeriodicExportingMetricReader (60s)
    # and a log batch processor aimed at the collector. Trace batches do
    # not export an empty queue (5s timer only arms after a span ends).
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
  domain         = var.langfuse_custom_domain
  environment_id = var.railway_environment_id
  service_id     = railway_service.langfuse_web.id
}

resource "railway_service_domain" "langfuse_web" {
  subdomain      = "langfuse-web-production-f475"
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

  variables = concat(local.langfuse_shared_env, local.langfuse_worker_secret_refs, [
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
      value = local.langfuse_worker_clickhouse_write_interval_ms
    },
    # Idle spans on v3.225.11 come from PeriodicRunner (startNewTrace, so
    # each tick is its own fully sampled trace). Queue metrics default to
    # 1000ms and the gauges are not exported (OTEL_METRICS_EXPORTER=none).
    # MonitorRunner is hardcoded to 30s with no interval env. Trace-delete
    # stays on, polled every 2 min instead of 10s.
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
