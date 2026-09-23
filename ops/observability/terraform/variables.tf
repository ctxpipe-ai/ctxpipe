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

variable "clickhouse_otel_password" {
  type        = string
  description = "ClickHouse password for the otel user (HyperDX + collector)."
  sensitive   = true
}

variable "clickhouse_langfuse_password" {
  type        = string
  description = "ClickHouse password for the langfuse user."
  sensitive   = true
}

variable "hyperdx_api_key" {
  type        = string
  description = "Shared ClickStack ingest token. Product apps send it as OTEL_EXPORTER_OTLP_HEADERS=authorization=<key>."
  sensitive   = true
}

variable "langfuse_database_url" {
  type        = string
  description = "Pooled Neon URL for the dedicated langfuse database on the existing ctxpipe project (not neondb)."
  sensitive   = true
}

variable "langfuse_direct_url" {
  type        = string
  description = "Direct (non-pooler) Neon URL for Langfuse Prisma DIRECT_URL."
  sensitive   = true
}

variable "langfuse_nextauth_secret" {
  type        = string
  description = "Langfuse NEXTAUTH_SECRET."
  sensitive   = true
}

variable "langfuse_salt" {
  type        = string
  description = "Langfuse SALT."
  sensitive   = true
}

variable "langfuse_encryption_key" {
  type        = string
  description = "Langfuse ENCRYPTION_KEY (64 hex chars)."
  sensitive   = true
}

variable "langfuse_auth_string" {
  type        = string
  description = "base64(pk-lf-…:sk-lf-…). Same values as LANGFUSE_INIT_PROJECT_* so the collector can fan out on first boot."
  sensitive   = true
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

variable "langfuse_init_project_public_key" {
  type        = string
  description = "Pre-provisioned Langfuse public key (pk-lf-…)."
  sensitive   = true
}

variable "langfuse_init_project_secret_key" {
  type        = string
  description = "Pre-provisioned Langfuse secret key (sk-lf-…)."
  sensitive   = true
}

variable "langfuse_init_user_email" {
  type        = string
  description = "First Langfuse admin email."
}

variable "langfuse_init_user_name" {
  type        = string
  description = "First Langfuse admin display name."
  default     = "ctxpipe"
}

variable "langfuse_init_user_password" {
  type        = string
  description = "First Langfuse admin password."
  sensitive   = true
}
