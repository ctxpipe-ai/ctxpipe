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

variable "image_tag" {
  type        = string
  description = "Container image tag used for deployable services."
  default     = "latest"
}

variable "source_image_registry_username" {
  type        = string
  description = "Username used by Railway to pull private container images."
  sensitive   = true
}

variable "source_image_registry_password" {
  type        = string
  description = "Password or token used by Railway to pull private container images."
  sensitive   = true
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

