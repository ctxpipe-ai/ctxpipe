variable "railway_project_id" {
  type        = string
  description = "Existing Railway project id for ctxpipe-observability. Terraform does not create the project."
  default     = "305aa114-c6f3-4aca-b883-0faa9c331aa2"
}

variable "railway_environment_id" {
  type        = string
  description = "Production environment id in ctxpipe-observability."
  default     = "5a0afd5c-5f12-47ef-8f8a-606107610f89"
}

variable "railway_regions" {
  type = list(object({
    region       = string
    num_replicas = number
  }))
  description = "Railway service regions. Single region only (provider 0.6.1)."
  default = [{
    region       = "us-east4-eqdc4a"
    num_replicas = 1
  }]

  validation {
    condition     = length(var.railway_regions) == 1
    error_message = "railway_regions must be a single region. Railway provider 0.6.1 cannot convert a variable-length regions list into ServiceResourceRegionModel."
  }
}

variable "github_repo" {
  type        = string
  description = "GitHub repository Railway builds ClickHouse and the collector from (owner/repo). Requires the Railway GitHub app on this repo."
  default     = "ctxpipe-ai/ctxpipe"
}

variable "github_repo_branch" {
  type        = string
  description = "Branch the Railway GitHub integration builds from. Use this PR branch for the first apply; switch to main after merge."
  default     = "main"
}

variable "collector_custom_domain" {
  type        = string
  description = "Public OTLP hostname for the ClickStack collector."
  default     = "telemetry.ctxpipe.ai"
}

variable "hyperdx_custom_domain" {
  type        = string
  description = "Public HyperDX dashboard hostname."
  default     = "hyperdx.ctxpipe.ai"
}

variable "langfuse_custom_domain" {
  type        = string
  description = "Public Langfuse hostname."
  default     = "langfuse.ctxpipe.ai"
}

variable "langfuse_init_org_id" {
  type        = string
  description = "LANGFUSE_INIT_ORG_ID (enables first-boot project + API keys)."
  default     = "ctxpipe"
}

variable "langfuse_init_project_id" {
  type        = string
  description = "LANGFUSE_INIT_PROJECT_ID."
  default     = "ctxpipe"
}

variable "langfuse_init_user_name" {
  type        = string
  description = "First Langfuse admin display name."
  default     = "ctxpipe"
}

