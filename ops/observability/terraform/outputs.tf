output "collector_dns_record" {
  description = "CNAME target Railway assigned for telemetry.ctxpipe.ai."
  value       = railway_custom_domain.collector.dns_record_value
}

output "collector_service_domain" {
  description = "Railway-generated collector hostname."
  value       = railway_service_domain.collector.domain
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
