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
