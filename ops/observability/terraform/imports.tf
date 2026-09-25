# Adopt API-created Railway objects into this configuration.
#
# These services were created through the Railway API, so R2 state is empty
# or partial. An apply without these blocks would create a second copy.
# Import blocks are ignored once the address is already in state.
#
# Provider 0.6.1 import id formats (tag v0.6.1):
# - railway_service: service UUID
#   https://github.com/terraform-community-providers/terraform-provider-railway/blob/v0.6.1/internal/provider/resource_service.go
# - railway_variable_collection: service_id:environment_name:VAR:VAR:...
#   environment_name is the Railway environment name (production), not the UUID.
#   Only the listed names enter state. Update deletes a variable only when it
#   is in state and absent from config, so a Railway-owned secret omitted here
#   is left alone. Omitted on purpose: clickhouse passwords, collector
#   HYPERDX_API_KEY and LANGFUSE_AUTH_STRING, langfuse-web DATABASE_URL /
#   DIRECT_URL / SALT / ENCRYPTION_KEY / NEXTAUTH_SECRET / LANGFUSE_INIT_* keys,
#   email, and password, langfuse-web NODE_OPTIONS, and railway-telemetry
#   RAILWAY_API_TOKEN. Consumer copies are references and stay in the list.
#   https://github.com/terraform-community-providers/terraform-provider-railway/blob/v0.6.1/internal/provider/resource_variable_collection.go
# - railway_custom_domain: service_id:environment_name:hostname
#   https://github.com/terraform-community-providers/terraform-provider-railway/blob/v0.6.1/internal/provider/resource_custom_domain.go
# - railway_service_domain: service_id:environment_name:full-hostname
#   The third field is the full domain (collector-production-5b4c.up.railway.app).
#   Read sets subdomain to domain with ".{suffix}" removed. Suffix is
#   up.railway.app, so subdomain is the host label (collector-production-5b4c).
#   Config uses those live labels, so import + config describe the same hostname.
#   https://github.com/terraform-community-providers/terraform-provider-railway/blob/v0.6.1/internal/provider/resource_service_domain.go
#
# Volumes are not their own resource. railway_service import is the service
# UUID; Read loads the volume mounted in the project default environment
# (this project has only production). clickhouse-data and mongo-data match
# the config name and mount path, so Update does not create a second volume.
# Update creates a volume only when state has none and config has one.
#
# Not imported: ops-probe (not in this configuration) and the langfuse-events
# bucket (provider 0.6.1 has no bucket resource).

import {
  to = railway_service.clickhouse
  id = "3b65fd5e-d05f-48dd-8395-ff75f250d2e5"
}

import {
  to = railway_variable_collection.clickhouse
  id = "3b65fd5e-d05f-48dd-8395-ff75f250d2e5:production:PORT"
}

import {
  to = railway_service.collector
  id = "f6ad26a3-22f4-48cf-9586-198f244b5496"
}

import {
  to = railway_variable_collection.collector
  id = "f6ad26a3-22f4-48cf-9586-198f244b5496:production:CLICKHOUSE_ENDPOINT:CLICKHOUSE_USER:CLICKHOUSE_PASSWORD:HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE:CLICKHOUSE_DATABASE:LANGFUSE_OTLP_ENDPOINT:CUSTOM_OTELCOL_CONFIG_FILE:PORT"
}

import {
  to = railway_custom_domain.collector
  id = "f6ad26a3-22f4-48cf-9586-198f244b5496:production:telemetry.ctxpipe.ai"
}

import {
  to = railway_service_domain.collector
  id = "f6ad26a3-22f4-48cf-9586-198f244b5496:production:collector-production-5b4c.up.railway.app"
}

import {
  to = railway_service.mongo
  id = "7c517c94-675a-46d7-a687-b6dc59736348"
}

import {
  to = railway_variable_collection.mongo
  id = "7c517c94-675a-46d7-a687-b6dc59736348:production:PORT"
}

import {
  to = railway_service.redis
  id = "6439e551-5ba2-4742-8680-0c7f515d07fc"
}

import {
  to = railway_variable_collection.redis
  id = "6439e551-5ba2-4742-8680-0c7f515d07fc:production:PORT"
}

import {
  to = railway_service.hyperdx
  id = "b89fb9c3-f354-4792-9769-8b014d3749ba"
}

import {
  to = railway_variable_collection.hyperdx
  id = "b89fb9c3-f354-4792-9769-8b014d3749ba:production:MONGO_URI:CLICKHOUSE_HOST:CLICKHOUSE_PORT:CLICKHOUSE_USER:CLICKHOUSE_PASSWORD:CLICKHOUSE_DATABASE:HYPERDX_API_KEY:FRONTEND_URL:PORT:USAGE_STATS_ENABLED:HDX_EXPORTER_ENABLED:HDX_STARTUP_LOGS:RUN_SCHEDULED_TASKS_EXTERNALLY:NEXT_TELEMETRY_DISABLED:OTEL_EXPORTER_OTLP_ENDPOINT:OTEL_TRACES_EXPORTER:OTEL_LOGS_EXPORTER:OTEL_METRICS_EXPORTER:OTEL_SERVICE_NAME:OTEL_RESOURCE_ATTRIBUTES:DEFAULT_CONNECTIONS:DEFAULT_SOURCES"
}

import {
  to = railway_custom_domain.hyperdx
  id = "b89fb9c3-f354-4792-9769-8b014d3749ba:production:hyperdx.ctxpipe.ai"
}

import {
  to = railway_service_domain.hyperdx
  id = "b89fb9c3-f354-4792-9769-8b014d3749ba:production:hyperdx-production-1172.up.railway.app"
}

import {
  to = railway_service.langfuse_web
  id = "4f05dedf-ea03-4b26-a080-b632b032d88a"
}

import {
  to = railway_variable_collection.langfuse_web
  id = "4f05dedf-ea03-4b26-a080-b632b032d88a:production:CLICKHOUSE_URL:CLICKHOUSE_USER:CLICKHOUSE_PASSWORD:CLICKHOUSE_MIGRATION_URL:CLICKHOUSE_CLUSTER_ENABLED:CLICKHOUSE_DB:REDIS_CONNECTION_STRING:REDIS_SOCKET_TIMEOUT_MS:TELEMETRY_ENABLED:LANGFUSE_S3_EVENT_UPLOAD_BUCKET:LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID:LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY:LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT:LANGFUSE_S3_EVENT_UPLOAD_REGION:LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE:NEXTAUTH_URL:LANGFUSE_INIT_ORG_ID:LANGFUSE_INIT_ORG_NAME:LANGFUSE_INIT_PROJECT_ID:LANGFUSE_INIT_PROJECT_NAME:LANGFUSE_INIT_USER_NAME:PORT:OTEL_EXPORTER_OTLP_ENDPOINT:OTEL_EXPORTER_OTLP_HEADERS:OTEL_SERVICE_NAME:OTEL_RESOURCE_ATTRIBUTES:OTEL_TRACE_SAMPLING_RATIO:OTEL_METRICS_EXPORTER:OTEL_LOGS_EXPORTER"
}

import {
  to = railway_custom_domain.langfuse_web
  id = "4f05dedf-ea03-4b26-a080-b632b032d88a:production:langfuse.ctxpipe.ai"
}

import {
  to = railway_service_domain.langfuse_web
  id = "4f05dedf-ea03-4b26-a080-b632b032d88a:production:langfuse-web-production-f475.up.railway.app"
}

import {
  to = railway_service.langfuse_worker
  id = "68491027-3044-4ac2-8a43-b7178982842e"
}

import {
  to = railway_variable_collection.langfuse_worker
  id = "68491027-3044-4ac2-8a43-b7178982842e:production:CLICKHOUSE_URL:CLICKHOUSE_USER:CLICKHOUSE_PASSWORD:CLICKHOUSE_MIGRATION_URL:CLICKHOUSE_CLUSTER_ENABLED:CLICKHOUSE_DB:REDIS_CONNECTION_STRING:REDIS_SOCKET_TIMEOUT_MS:TELEMETRY_ENABLED:LANGFUSE_S3_EVENT_UPLOAD_BUCKET:LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID:LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY:LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT:LANGFUSE_S3_EVENT_UPLOAD_REGION:LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE:DATABASE_URL:DIRECT_URL:SALT:ENCRYPTION_KEY:PORT:OTEL_EXPORTER_OTLP_ENDPOINT:OTEL_EXPORTER_OTLP_HEADERS:OTEL_SERVICE_NAME:OTEL_RESOURCE_ATTRIBUTES:OTEL_METRICS_EXPORTER:OTEL_LOGS_EXPORTER:LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS:LANGFUSE_QUEUE_METRICS_ENABLED:LANGFUSE_MONITOR_SCHEDULER_ENABLED:LANGFUSE_TRACE_DELETE_BATCH_ACTION_RUNNER_INTERVAL_MS"
}

import {
  to = railway_service.railway_telemetry
  id = "f72e20f6-b4db-4fbd-a5ca-85511b517dbd"
}

import {
  to = railway_variable_collection.railway_telemetry
  id = "f72e20f6-b4db-4fbd-a5ca-85511b517dbd:production:OTEL_EXPORTER_OTLP_ENDPOINT:OTEL_EXPORTER_OTLP_HEADERS:REDIS_URL"
}
