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

variable "image_tag" {
  type        = string
  description = "Container image tag used for deployable services."
  default     = "latest"
}

variable "model_provider" {
  type        = string
  description = "MODEL_PROVIDER for backend/worker (openai-like, openrouter, azure, bedrock)"
  default     = "openrouter"
}

variable "linear_redirect_uri" {
  type        = string
  description = "optional LINEAR_REDIRECT_URI override"
  default     = ""
}

variable "pagerduty_redirect_uri" {
  type        = string
  description = "optional PAGERDUTY_REDIRECT_URI override"
  default     = ""
}

variable "otel_otlp_endpoint" {
  type        = string
  description = "Public ClickStack collector OTLP HTTP base (no /v1 suffix)."
  default     = "https://telemetry.ctxpipe.ai"
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

