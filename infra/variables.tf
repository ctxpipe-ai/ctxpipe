variable "image_tag" {
  type        = string
  description = "Container image tag for Railway app services."
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

