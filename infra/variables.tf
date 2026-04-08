variable "image_tag" {
  type        = string
  description = "Container image tag for Railway app services."
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

variable "falkordb_password" {
  type        = string
  description = "value for FALKORDB_PASSWORD"
  sensitive   = true
}

variable "better_stack_token" {
  type        = string
  description = "Better Stack OpenTelemetry source token for the collector."
  sensitive   = true
}

variable "langfuse_auth_string" {
  type        = string
  description = "LangFuse OTLP basic auth string (base64)."
  sensitive   = true
}

variable "langfuse_otlp_endpoint" {
  type        = string
  description = "LangFuse OTLP HTTP endpoint."
  sensitive   = true
}

variable "amplitude_api_key" {
  type        = string
  description = "Amplitude project API key; leave empty to disable analytics."
  default     = ""
  sensitive   = true
}

variable "amplitude_region" {
  type        = string
  description = "Amplitude data region: us or eu."
  default     = "us"
}