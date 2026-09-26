variable "image_tag" {
  type        = string
  description = "Container image tag for Railway app services."
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

variable "github_webhook_secret" {
  type        = string
  description = "value for GITHUB_WEBHOOK_SECRET"
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

variable "falkordb_password" {
  type        = string
  description = "value for FALKORDB_PASSWORD"
  sensitive   = true
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
