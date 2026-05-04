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
  description = "Railway service regions."
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

variable "amplitude_api_key" {
  type        = string
  description = "Amplitude project API key (browser + MCP); leave empty to disable."
  default     = ""
  sensitive   = true
}

variable "amplitude_region" {
  type        = string
  description = "Amplitude data region: us or eu."
  default     = "us"
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

