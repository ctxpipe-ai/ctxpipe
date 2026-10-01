output "collector_dns_record" {
  description = "CNAME target Railway assigned for telemetry.ctxpipe.ai."
  value       = railway_custom_domain.collector.dns_record_value
}

output "collector_service_domain" {
  description = "Railway-generated collector hostname."
  value       = railway_service_domain.collector.domain
}

output "cost_telemetry_service_id" {
  description = "Railway cost telemetry service ID for post-apply credential sync."
  value       = railway_service.cost_telemetry.id
}

output "hyperdx_dns_record" {
  description = "CNAME target Railway assigned for hyperdx.ctxpipe.ai."
  value       = railway_custom_domain.hyperdx.dns_record_value
}

output "hyperdx_service_domain" {
  description = "Railway-generated HyperDX hostname."
  value       = railway_service_domain.hyperdx.domain
}

output "langfuse_dns_record" {
  description = "CNAME target Railway assigned for langfuse.ctxpipe.ai."
  value       = railway_custom_domain.langfuse_web.dns_record_value
}

output "langfuse_service_domain" {
  description = "Railway-generated Langfuse hostname."
  value       = railway_service_domain.langfuse_web.domain
}
