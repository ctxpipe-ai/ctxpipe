resource "neon_project" "this" {
  name       = var.neon_project.name
  org_id     = var.neon_project.org_id
  region_id  = var.neon_project.region_id
  pg_version = var.neon_project.pg_version

  history_retention_seconds = try(var.neon_project.history_retention_seconds, null)
  compute_provisioner       = try(var.neon_project.compute_provisioner, null)
  store_password            = try(var.neon_project.store_password, null)

  dynamic "maintenance_window" {
    for_each = try([var.neon_project.maintenance_window], [])
    content {
      start_time = maintenance_window.value.start_time
      end_time   = maintenance_window.value.end_time
      weekdays   = maintenance_window.value.weekdays
    }
  }

  dynamic "branch" {
    for_each = try([var.neon_project.branch], [])
    content {
      name          = branch.value.name
      database_name = branch.value.database_name
      role_name     = branch.value.role_name
    }
  }

  dynamic "default_endpoint_settings" {
    for_each = try([var.neon_project.default_endpoint_settings], [])
    content {
      autoscaling_limit_min_cu = default_endpoint_settings.value.autoscaling_limit_min_cu
      autoscaling_limit_max_cu = default_endpoint_settings.value.autoscaling_limit_max_cu
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

