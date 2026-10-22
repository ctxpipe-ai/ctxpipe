output "collector_dns_record" {
  description = "CNAME target Railway assigned for telemetry.ctxpipe.ai."
  value       = railway_custom_domain.collector.dns_record_value
}

output "collector_service_domain" {
  description = "Railway-generated collector hostname."
  value       = railway_service_domain.collector.domain
}

output "railway_service_ids" {
  description = "Railway service IDs for the post-apply secret sync (scripts/railway-sync-variables.py)."
  value = {
    clickhouse        = railway_service.clickhouse.id
    collector         = railway_service.collector.id
    hyperdx           = railway_service.hyperdx.id
    langfuse_web      = railway_service.langfuse_web.id
    langfuse_worker   = railway_service.langfuse_worker.id
    railway_telemetry = railway_service.railway_telemetry.id
    cost_telemetry    = railway_service.cost_telemetry.id
  }
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
