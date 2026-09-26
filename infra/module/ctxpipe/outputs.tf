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

