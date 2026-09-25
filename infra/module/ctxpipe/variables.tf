variable "railway_workspace_id" {
  type        = string
  description = "Railway workspace ID to create the project in."
}

variable "railway_project" {
  type = object({
    name           = string
    description    = optional(string)
    private        = optional(bool, true)
    has_pr_deploys = optional(bool, false)
  })
  description = "Railway project configuration."
}

variable "railway_environment_name" {
  type        = string
  description = "Railway environment name (e.g., production)."
}

variable "railway_regions" {
  type = list(object({
    region       = string
    num_replicas = number
  }))
  description = "Railway service regions. Default is US East (Virginia), next to Neon aws-us-east-1."
  default = [{
    region       = "us-east4-eqdc4a"
    num_replicas = 1
  }]

  validation {
    condition     = length(var.railway_regions) == 1
    error_message = "railway_regions must be a single region. Railway provider 0.6.1 cannot convert a variable-length regions list into ServiceResourceRegionModel."
  }
}

variable "backend_source_image" {
  type        = string
  description = "Container image repository for the backend service."
  default     = "ghcr.io/ctxpipe-ai/backend"
}

variable "worker_source_image" {
  type        = string
  description = "Container image repository for the OpenWorkflow worker service."
  default     = "ghcr.io/ctxpipe-ai/worker"
}

variable "ui_source_image" {
  type        = string
  description = "Container image repository for the UI service."
  default     = "ghcr.io/ctxpipe-ai/ui"
}

variable "codesearch_source_image" {
  type        = string
  description = "Container image repository for the codesearch service."
  default     = "ghcr.io/ctxpipe-ai/codesearch"
}

variable "otel_collector_source_image" {
  type        = string
  description = "Container image repository for the OpenTelemetry Collector service."
  default     = "ghcr.io/ctxpipe-ai/otel-collector"
}

variable "image_tag" {
  type        = string
  description = "Container image tag used for deployable services."
  default     = "latest"
}

variable "better_auth_secret" {
  type        = string
  description = "value for AUTH_SECRET used in better-auth"
  sensitive   = true
}

variable "langsmith_api_key" {
  type        = string
  description = "value for LANGSMITH_API_KEY"
  sensitive   = true
}

variable "model_provider_api_key" {
  type        = string
  description = "value for MODEL_PROVIDER_API_KEY"
  sensitive   = true
}

variable "model_provider" {
  type        = string
  description = "MODEL_PROVIDER for backend/worker (openai-like, openrouter, azure, bedrock)"
  default     = "openrouter"
}

variable "smtp_connection_url" {
  type        = string
  description = "value for SMTP_CONNECTION_URL"
  sensitive   = true
}

variable "github_private_key" {
  type        = string
  description = "value for GITHUB_PRIVATE_KEY"
  sensitive   = true
}

variable "github_client_secret" {
  type        = string
  description = "value for GITHUB_CLIENT_SECRET"
  sensitive   = true
}

variable "atlassian_client_id" {
  type        = string
  description = "value for ATLASSIAN_CLIENT_ID (Forge / OAuth)"
  sensitive   = true
}

variable "atlassian_client_secret" {
  type        = string
  description = "value for ATLASSIAN_CLIENT_SECRET"
  sensitive   = true
}

variable "slack_client_id" {
  type        = string
  description = "value for SLACK_CLIENT_ID (deployment Slack app OAuth)"
  sensitive   = true
  default     = ""
}

variable "slack_client_secret" {
  type        = string
  description = "value for SLACK_CLIENT_SECRET"
  sensitive   = true
  default     = ""
}

variable "slack_signing_secret" {
  type        = string
  description = "value for SLACK_SIGNING_SECRET (Events API verification)"
  sensitive   = true
  default     = ""
}

variable "linear_client_id" {
  type        = string
  description = "value for LINEAR_CLIENT_ID; leave empty to disable the Linear connector"
  default     = ""
  sensitive   = true
}

variable "linear_client_secret" {
  type        = string
  description = "value for LINEAR_CLIENT_SECRET"
  default     = ""
  sensitive   = true
}

variable "linear_redirect_uri" {
  type        = string
  description = "optional LINEAR_REDIRECT_URI override"
  default     = ""
}

variable "linear_webhook_secret" {
  type        = string
  description = "value for LINEAR_WEBHOOK_SECRET"
  default     = ""
  sensitive   = true
}

variable "notion_client_id" {
  type        = string
  description = "value for NOTION_CLIENT_ID (public integration OAuth)"
  sensitive   = true
}

variable "notion_client_secret" {
  type        = string
  description = "value for NOTION_CLIENT_SECRET"
  sensitive   = true
}

variable "notion_webhook_secret" {
  type        = string
  description = "value for NOTION_WEBHOOK_SECRET"
  sensitive   = true
}

variable "pagerduty_client_id" {
  type        = string
  description = "value for PAGERDUTY_CLIENT_ID; leave empty to disable the PagerDuty connector"
  default     = ""
  sensitive   = true
}

variable "pagerduty_client_secret" {
  type        = string
  description = "value for PAGERDUTY_CLIENT_SECRET"
  default     = ""
  sensitive   = true
}

variable "pagerduty_redirect_uri" {
  type        = string
  description = "optional PAGERDUTY_REDIRECT_URI override"
  default     = ""
}

variable "github_webhook_secret" {
  type        = string
  description = "value for GITHUB_WEBHOOK_SECRET"
  sensitive   = true
}

variable "falkordb_password" {
  type        = string
  description = "value for FALKORDB_PASSWORD"
  sensitive   = true
}

variable "better_stack_token" {
  type        = string
  description = "Better Stack OpenTelemetry source token (BETTER_STACK_TOKEN on the collector)."
  sensitive   = true
}

variable "langfuse_auth_string" {
  type        = string
  description = "Base64 basic auth for LangFuse OTLP (LANGFUSE_AUTH_STRING)."
  sensitive   = true
}

variable "langfuse_otlp_endpoint" {
  type        = string
  description = "LangFuse OTLP HTTP endpoint URL (LANGFUSE_OTLP_ENDPOINT)."
  sensitive   = true
}

variable "otel_otlp_endpoint" {
  type        = string
  description = "Public ClickStack collector OTLP HTTP base (no /v1 suffix). Empty uses https://telemetry.ctxpipe.ai."
  default     = ""

  validation {
    condition     = length(trimspace(var.otel_otlp_endpoint)) == 0 || startswith(trimspace(var.otel_otlp_endpoint), "https://")
    error_message = "otel_otlp_endpoint must be an https URL or empty (empty uses https://telemetry.ctxpipe.ai)."
  }
}

variable "otel_otlp_headers" {
  type        = string
  description = "OTEL_EXPORTER_OTLP_HEADERS for the public collector (authorization=<HYPERDX_API_KEY>). Same value as OBSERVABILITY_OTLP_HEADERS."
  sensitive   = true

  validation {
    condition     = length(trimspace(var.otel_otlp_headers)) > 0
    error_message = "otel_otlp_headers is required so production OTLP includes the collector authorization header."
  }
}

variable "neon_project" {
  type = object({
    name                      = string
    org_id                    = string
    region_id                 = string
    pg_version                = number
    history_retention_seconds = optional(number)
    compute_provisioner       = optional(string)
    store_password            = optional(string)

    maintenance_window = optional(object({
      start_time = string
      end_time   = string
      weekdays   = list(number)
    }))

    branch = optional(object({
      name          = string
      database_name = string
      role_name     = string
    }))

    default_endpoint_settings = optional(object({
      autoscaling_limit_min_cu = number
      autoscaling_limit_max_cu = number
    }))
  })
  description = "Neon project configuration."
}

variable "openworkflow_concurrency" {
  type        = string
  description = "In-flight OpenWorkflow runs per worker process. Production default is the medium capacity pair (see ADR-027). Changing this requires redeploying the worker."
  default     = "10"
}

variable "codesearch_indexer_concurrency" {
  type        = string
  description = "Max concurrent Zoekt/SCIP child processes on the single codesearch replica. Production default is the medium pair. Changing this requires redeploying codesearch (and the worker, which uses the same value to batch SCIP HTTP)."
  default     = "2"
}

variable "codesearch_index_pipeline_concurrency" {
  type        = string
  description = "Max distinct repos with in-flight OpenWorkflow index-phase HTTP (clone included) on codesearch. Production default is the medium pair. Changing this requires redeploying codesearch."
  default     = "2"
}
