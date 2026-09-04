resource "neon_project" "this" {
  name       = var.neon_project.name
  org_id     = var.neon_project.org_id
  region_id  = var.neon_project.region_id
  pg_version = var.neon_project.pg_version

  history_retention_seconds = try(var.neon_project.history_retention_seconds, null)
  compute_provisioner       = try(var.neon_project.compute_provisioner, null)
  store_password            = try(var.neon_project.store_password, null)
  enable_logical_replication = (
    var.neon_source_logical_replication ? "yes" : null
  )

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

resource "neon_project" "migration_target" {
  count = var.neon_migration_target == null ? 0 : 1

  name       = var.neon_migration_target.name
  org_id     = var.neon_migration_target.org_id
  region_id  = var.neon_migration_target.region_id
  pg_version = var.neon_migration_target.pg_version

  history_retention_seconds = try(
    var.neon_migration_target.history_retention_seconds,
    null,
  )
  compute_provisioner = try(
    var.neon_migration_target.compute_provisioner,
    null,
  )
  store_password = try(var.neon_migration_target.store_password, null)

  dynamic "maintenance_window" {
    for_each = try([var.neon_migration_target.maintenance_window], [])
    content {
      start_time = maintenance_window.value.start_time
      end_time   = maintenance_window.value.end_time
      weekdays   = maintenance_window.value.weekdays
    }
  }

  dynamic "branch" {
    for_each = try([var.neon_migration_target.branch], [])
    content {
      name          = branch.value.name
      database_name = branch.value.database_name
      role_name     = branch.value.role_name
    }
  }

  dynamic "default_endpoint_settings" {
    for_each = try(
      [var.neon_migration_target.default_endpoint_settings],
      [],
    )
    content {
      autoscaling_limit_min_cu = default_endpoint_settings.value.autoscaling_limit_min_cu
      autoscaling_limit_max_cu = default_endpoint_settings.value.autoscaling_limit_max_cu
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "neon_database" "postgres" {
  branch_id  = neon_branch.production.id
  name       = var.neon_project.branch.database_name
  owner_name = var.neon_project.branch.role_name
  project_id = neon_project.this.id
}

resource "neon_branch" "production" {
  name       = "production"
  protected  = "yes"
  project_id = neon_project.this.id
}
