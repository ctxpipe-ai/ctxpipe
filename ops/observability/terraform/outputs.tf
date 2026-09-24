output "railway_project_id" {
  description = "ctxpipe-observability Railway project id."
  value       = var.railway_project_id
}

output "collector_custom_domain" {
  description = "Public OTLP hostname. Create the DNS CNAME Railway returns before cutover."
  value       = var.collector_custom_domain
}

output "collector_dns_record" {
  description = "CNAME target Railway assigned for telemetry.ctxpipe.ai."
  value       = railway_custom_domain.collector.dns_record_value
}

output "collector_service_domain" {
  description = "Railway-generated collector hostname for use before custom DNS is live."
  value       = railway_service_domain.collector.domain
}

output "hyperdx_custom_domain" {
  description = "Public HyperDX dashboard hostname."
  value       = var.hyperdx_custom_domain
}

output "hyperdx_dns_record" {
  description = "CNAME target Railway assigned for hyperdx.ctxpipe.ai."
  value       = railway_custom_domain.hyperdx.dns_record_value
}

output "hyperdx_service_domain" {
  description = "Railway-generated HyperDX hostname."
  value       = railway_service_domain.hyperdx.domain
}

output "langfuse_custom_domain" {
  description = "Public Langfuse hostname."
  value       = var.langfuse_custom_domain
}

output "langfuse_dns_record" {
  description = "CNAME target Railway assigned for langfuse.ctxpipe.ai."
  value       = railway_custom_domain.langfuse_web.dns_record_value
}

output "langfuse_service_domain" {
  description = "Railway-generated Langfuse hostname."
  value       = railway_service_domain.langfuse_web.domain
}

output "otel_otlp_endpoint" {
  description = "Value for product OBSERVABILITY_OTLP_ENDPOINT after DNS (or the Railway service domain until then)."
  value       = "https://${var.collector_custom_domain}"
}
