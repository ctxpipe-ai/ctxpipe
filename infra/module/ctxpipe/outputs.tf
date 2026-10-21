output "railway_project_id" {
  value = railway_project.this.id
}

output "railway_environment_id" {
  value = railway_project.this.default_environment.id
}

output "railway_service_ids" {
  value = {
    ui            = railway_service.ui.id
    backend       = railway_service.backend.id
    code_search   = railway_service.code_search.id
    open_workflow = railway_service.open_workflow.id
    falkordb      = railway_service.falkordb.id
  }
}

output "neon_project_id" {
  value = neon_project.this.id
}

output "neon_default_branch_id" {
  value = neon_project.this.default_branch_id
}

output "ctxpipe_app_password" {
  value     = random_password.app_database.result
  sensitive = true
}


# Set these in Cloudflare (DNS only, proxy off) so Railway can issue the certificate.
output "www_app_dns_record" {
  value = {
    name   = railway_custom_domain.www_app.domain
    target = railway_custom_domain.www_app.dns_record_value
    type   = "CNAME"
  }
}
