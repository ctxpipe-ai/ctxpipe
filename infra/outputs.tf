output "railway_project_id" {
  value = module.ctxpipe.railway_project_id
}

output "railway_environment_id" {
  value = module.ctxpipe.railway_environment_id
}

output "railway_service_ids" {
  value = module.ctxpipe.railway_service_ids
}

output "neon_project_id" {
  value = module.ctxpipe.neon_project_id
}

output "neon_default_branch_id" {
  value = module.ctxpipe.neon_default_branch_id
}

output "neon_migration_target_project_id" {
  value = module.ctxpipe.neon_migration_target_project_id
}

output "neon_migration_target_connection_uri" {
  value     = module.ctxpipe.neon_migration_target_connection_uri
  sensitive = true
}

output "neon_migration_target_connection_uri_pooler" {
  value     = module.ctxpipe.neon_migration_target_connection_uri_pooler
  sensitive = true
}

