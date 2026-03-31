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
  type = string
  description = "value for AUTH_SECRET used in better-auth"
  sensitive = true
}

variable "langsmith_api_key" {
  type = string
  description = "value for LANGSMITH_API_KEY"
  sensitive = true
}

variable "model_provider_api_key" {
  type = string
  description = "value for MODEL_PROVIDER_API_KEY"
  sensitive = true
}

variable "smtp_connection_url" {
  type = string
  description = "value for SMTP_CONNECTION_URL"
  sensitive = true
}

variable "github_private_key" {
  type = string
  description = "value for GITHUB_PRIVATE_KEY"
  sensitive = true
}

variable "github_client_secret" {
  type = string
  description = "value for GITHUB_CLIENT_SECRET"
  sensitive = true
}

variable "falkordb_password" {
  type = string
  description = "value for FALKORDB_PASSWORD"
  sensitive = true
}