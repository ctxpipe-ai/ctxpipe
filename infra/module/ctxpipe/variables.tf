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
    default_environment = optional(object({
      name = string
    }))
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

variable "source_repo" {
  type        = string
  description = "GitHub repo in `org/name` format."
}

variable "source_repo_branch" {
  type        = string
  description = "Git branch to deploy from."
}

variable "services" {
  type = map(object({
    name         = string
    config_path  = optional(string)
    source_image = optional(string)
    volume = optional(object({
      name       = string
      mount_path = string
    }))
  }))
  description = "Railway services keyed by a stable identifier (e.g., backend, ui)."
}

variable "railway_service_variables" {
  type = list(object({
    service_key = string
    name        = string
    value       = string
  }))
  description = "Per-service env vars to set in the given Railway environment."
  default     = []
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

