output "railway_project_id" {
  value = railway_project.this.id
}

output "railway_environment_id" {
  value = railway_environment.this.id
}

output "railway_service_ids" {
  value = {
    for k, v in railway_service.this : k => v.id
  }
}

output "neon_project_id" {
  value = neon_project.this.id
}

output "neon_default_branch_id" {
  value = neon_project.this.default_branch_id
}

